const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn } = require('child_process');
const { renderBulletinHTML } = require('./bulletin-render');
const { printBulletin, imposeBooklet } = require('./bulletin-print');
const { getWorkspaceDb, closeWorkspaceDb, migrateLegacyFiles } = require('./src/database');

let mainWindow;
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// ── Settings persistence ────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
}

// ── TSV / order utilities ────────────────────────────────────────────────────

function parseTSV(content) {
  return content.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      if (line.startsWith('HD\t')) {
        return { type: 'heading', title: line.slice(3).trim(), enabled: true };
      }
      if (line.startsWith('\\')) {
        return { type: 'raw', text: line, enabled: true };
      }
      const [name = '', ref = '', note = ''] = line.split('\t');
      return { type: 'element', name: name.trim(), ref: ref.trim(), note: note.trim(), enabled: true };
    });
}

function serializeTSV(items) {
  return items
    .filter(item => item.enabled !== false)
    .map(item => {
      if (item.type === 'heading') return `HD\t${item.title ?? ''}`;
      if (item.type === 'element') return `${item.name ?? ''}\t${item.ref ?? ''}\t${item.note ?? ''}`;
      if (item.type === 'raw')     return item.text ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n') + '\n';
}

// ── CSV utilities ────────────────────────────────────────────────────────────

const SCHEDULE_COLS = [
  'DATE', 'Season', 'Introit', 'Call to Worship', 'Opening Hymn',
  'Law Reading', 'Assurance', 'Confession Hymn', 'OT Reading',
  'Scripture Hymn', 'Sermon Text', 'Closing Hymn', 'Notes',
];

function parseCSVLine(line) {
  const fields = [];
  let inQuotes = false;
  let field = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Announcements utilities ──────────────────────────────────────────────────

// Returns { content, end } where end is the index of the closing }
function extractBracedArg(str, start) {
  if (str[start] !== '{') return null;
  let depth = 0;
  let content = '';
  for (let i = start + 1; i < str.length; i++) {
    if (str[i] === '\\') {
      content += str[i] + (str[i + 1] ?? '');
      i++;
    } else if (str[i] === '{') {
      depth++; content += '{';
    } else if (str[i] === '}') {
      if (depth === 0) return { content, end: i };
      depth--; content += '}';
    } else {
      content += str[i];
    }
  }
  return null;
}

function parseAnnouncements(raw) {
  const items = [];
  let i = 0;
  // Strip surrounding whitespace lines but preserve structure
  const text = raw;

  while (i < text.length) {
    // Skip whitespace-only content
    if (/[ \t\r\n]/.test(text[i])) { i++; continue; }

    // \item [Label] body
    if (text.slice(i).startsWith('\\item')) {
      let pos = i + 5;
      while (pos < text.length && text[pos] === ' ') pos++;
      let label = '';
      if (text[pos] === '[') {
        const end = text.indexOf(']', pos);
        if (end !== -1) { label = text.slice(pos + 1, end); pos = end + 1; }
      }
      while (pos < text.length && text[pos] === ' ') pos++;
      // Body runs until next \item or \announce or end of description
      const nextCmd = /\\item\b|\\announce[cl]\{|\\end\{description\}/;
      const remaining = text.slice(pos);
      const m = nextCmd.exec(remaining);
      const bodyEnd = m ? pos + m.index : text.length;
      items.push({ type: 'item', label, body: text.slice(pos, bodyEnd).trimEnd() });
      i = bodyEnd;
      continue;
    }

    // \announcec{Title}{Content} or \announcel{Title}{Content}
    const macroMatch = /^\\(announce[cl])\{/.exec(text.slice(i));
    if (macroMatch) {
      const titleStart = i + macroMatch[0].length - 1;
      const titleArg = extractBracedArg(text, titleStart);
      if (titleArg) {
        let cs = titleArg.end + 1;
        while (cs < text.length && text[cs] !== '{') cs++;
        const contentArg = extractBracedArg(text, cs);
        if (contentArg) {
          items.push({
            type: macroMatch[1] === 'announcec' ? 'announcec' : 'announcel',
            title: titleArg.content,
            content: contentArg.content,
          });
          i = contentArg.end + 1;
          continue;
        }
      }
    }

    // Skip structural lines (wrapper boilerplate)
    const lineEnd = text.indexOf('\n', i);
    const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd);
    if (
      line.includes('\\subsection') ||
      line.includes('\\begin{description}') ||
      line.includes('\\end{description}')
    ) {
      i = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }

    // Raw passthrough for anything else non-empty
    if (line.trim()) {
      items.push({ type: 'raw', text: line });
    }
    i = lineEnd === -1 ? text.length : lineEnd + 1;
  }

  return items;
}

function serializeAnnouncements(items) {
  const lines = ['\\subsection*{Announcements}', '\\begin{description}'];
  for (const item of items) {
    if (item.type === 'item') {
      lines.push(`  \\item [${item.label}] ${item.body}`);
    } else if (item.type === 'announcec') {
      lines.push(`  \\announcec{${item.title}}{${item.content}}`);
    } else if (item.type === 'announcel') {
      lines.push(`  \\announcel{${item.title}}{${item.content}}`);
    } else if (item.type === 'raw') {
      lines.push(`  ${item.text}`);
    }
  }
  lines.push('\\end{description}');
  return lines.join('\n') + '\n';
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Bulletin Builder',
  });
  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Bulletin Workspace',
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  const p = result.filePaths[0];
  saveSettings({ ...loadSettings(), workspacePath: p });
  return p;
});

ipcMain.handle('workspace:get', () => {
  return loadSettings().workspacePath ?? null;
});

ipcMain.handle('workspace:listDates', (_, workspacePath) => {
  if (!fs.existsSync(workspacePath)) return [];
  return fs.readdirSync(workspacePath, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();
});

ipcMain.handle('workspace:listServices', (_, workspacePath) => {
  const SYSTEM_DIRS = new Set(['elements', 'graphics', 'music']);
  if (!fs.existsSync(workspacePath)) return [];
  return fs.readdirSync(workspacePath, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SYSTEM_DIRS.has(e.name.toLowerCase()))
    .map(e => {
      const name = e.name;
      const metaPath = path.join(workspacePath, name, 'meta.json');
      let date = /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : null;
      let communion = false;
      if (fs.existsSync(metaPath)) {
        try { const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); if (m.date) date = m.date; if (m.communion) communion = true; } catch {}
      }
      return { name, date: date || '', communion };
    })
    .sort((a, b) => {
      const aIsDate = /^\d{4}-\d{2}-\d{2}$/.test(a.name);
      const bIsDate = /^\d{4}-\d{2}-\d{2}$/.test(b.name);
      if (aIsDate && bIsDate) return b.name.localeCompare(a.name);
      if (aIsDate) return 1;
      if (bIsDate) return -1;
      return a.name.localeCompare(b.name);
    });
});

ipcMain.handle('workspace:createService', (_, workspacePath, name, date, communion) => {
  const dir = path.join(workspacePath, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const meta = { name, date: date || name };
  if (communion) meta.communion = true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || communion) {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }
  return { ok: true, name, date: date || name, communion: !!communion };
});

ipcMain.handle('workspace:setServiceMeta', (_, workspacePath, folder, updates) => {
  const metaPath = path.join(workspacePath, folder, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }
  if (!meta.name) meta.name = folder;
  if (!meta.date) meta.date = /^\d{4}-\d{2}-\d{2}$/.test(folder) ? folder : '';
  Object.assign(meta, updates);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true };
});

ipcMain.handle('hymnal:load', (_, workspacePath) => {
  const filePath = path.join(workspacePath, 'csh.tsv');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const [num, title, tune] = l.split('\t');
      return { num: num?.trim(), title: title?.trim(), tune: tune?.trim() };
    })
    .filter(r => r.num);
});

ipcMain.handle('csv:read', (_, workspacePath, date) => {
  const filePath = path.join(workspacePath, 'schedule.csv');
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const header = parseCSVLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseCSVLine(lines[i]);
    if (fields[0]?.trim() === date) {
      const row = {};
      header.forEach((col, j) => { row[col.trim()] = (fields[j] ?? '').trim(); });
      return row;
    }
  }
  return null;
});

ipcMain.handle('csv:write', (_, workspacePath, date, row) => {
  const filePath = path.join(workspacePath, 'schedule.csv');
  const newLine = SCHEDULE_COLS.map(col => csvField(row[col] ?? '')).join(',');
  let found = false;
  let result;

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    result = lines.map((line, i) => {
      if (i === 0 || !line.trim()) return line;
      const fields = parseCSVLine(line);
      if (fields[0]?.trim() === date) { found = true; return newLine; }
      return line;
    });
    if (!found) {
      // Insert in date order
      let insertIdx = -1;
      for (let i = 1; i < result.length; i++) {
        if (!result[i].trim()) continue;
        const fields = parseCSVLine(result[i]);
        if (fields[0]?.trim() > date) { insertIdx = i; break; }
      }
      if (insertIdx === -1) result.push(newLine);
      else result.splice(insertIdx, 0, newLine);
    }
  } else {
    result = [SCHEDULE_COLS.join(','), newLine, ''];
  }

  fs.writeFileSync(filePath, result.join('\n'), 'utf8');
  return { ok: true };
});

ipcMain.handle('announcements:read', (_, workspacePath, folder) => {
  const filePath = path.join(workspacePath, folder, 'announcements.txt');
  if (!fs.existsSync(filePath)) return [];
  return parseAnnouncements(fs.readFileSync(filePath, 'utf8'));
});

ipcMain.handle('announcements:write', (_, workspacePath, folder, items) => {
  const dir = path.join(workspacePath, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'announcements.txt'), serializeAnnouncements(items), 'utf8');
  return { ok: true };
});

ipcMain.handle('textfile:read', (_, workspacePath, filename) => {
  const filePath = path.join(workspacePath, filename);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('textfile:write', (_, workspacePath, filename, content) => {
  fs.writeFileSync(path.join(workspacePath, filename), content, 'utf8');
  return { ok: true };
});

ipcMain.handle('order:generate', async (_, workspacePath, date, communion) => {
  const buildArgs = ['-d', date];
  if (communion) buildArgs.push('-c');
  return new Promise((resolve, reject) => {
    const proc = spawn('./build-order.sh', buildArgs, { cwd: workspacePath, shell: true });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => {
      const out = Buffer.concat(chunks).toString();
      if (code === 0) resolve(parseTSV(out));
      else reject(new Error(`build-order.sh exited with code ${code}`));
    });
    proc.on('error', reject);
  });
});

ipcMain.handle('order:load', (_, workspacePath, folder) => {
  const filePath = path.join(workspacePath, folder, 'order.tsv');
  if (!fs.existsSync(filePath)) return null;
  return parseTSV(fs.readFileSync(filePath, 'utf8'));
});

ipcMain.handle('order:save', (_, workspacePath, folder, tsv) => {
  const dir = path.join(workspacePath, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'order.tsv'), tsv, 'utf8');
  return { ok: true };
});

ipcMain.handle('elements:list', (_, workspacePath) => {
  const elementsDir = path.join(workspacePath, 'elements');
  if (!fs.existsSync(elementsDir)) return [];
  const results = [];
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (/\.(txt|tex)$/i.test(entry.name)) {
        results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(elementsDir, '');
  return results.sort();
});

const DEFAULT_COMMUNION_TSV =
  'HD\tGod Communes with Us\n' +
  'Words of Institution\t1 Corinthians 11:23\u201326\t\n' +
  'Distribution of the Bread\t\t\n' +
  'Distribution of the Cup\t\t\n' +
  'Prayer of Thanksgiving\t\t\n';

ipcMain.handle('communion:getTemplate', (_, workspacePath) => {
  const filePath = path.join(workspacePath, 'elements', 'communion-order.tsv');
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  return DEFAULT_COMMUNION_TSV;
});

ipcMain.handle('communion:saveTemplate', (_, workspacePath, content) => {
  const dir = path.join(workspacePath, 'elements');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'communion-order.tsv'), content, 'utf8');
  return { ok: true };
});

ipcMain.handle('config:read', (_, workspacePath) => {
  const p = path.join(workspacePath, 'bulletin-config.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});

ipcMain.handle('config:write', (_, workspacePath, config) => {
  fs.writeFileSync(
    path.join(workspacePath, 'bulletin-config.json'),
    JSON.stringify(config, null, 2), 'utf8'
  );
  return { ok: true };
});

ipcMain.handle('config:readService', (_, workspacePath, folder) => {
  const p = path.join(workspacePath, folder, 'service-config.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});

ipcMain.handle('config:writeService', (_, workspacePath, folder, config) => {
  const dir = path.join(workspacePath, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (config === null) {
    const p = path.join(dir, 'service-config.json');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else {
    fs.writeFileSync(path.join(dir, 'service-config.json'), JSON.stringify(config, null, 2), 'utf8');
  }
  return { ok: true };
});

ipcMain.handle('pdf:load', (_, pdfPath) => {
  if (!fs.existsSync(pdfPath)) return null;
  return 'data:application/pdf;base64,' + fs.readFileSync(pdfPath).toString('base64');
});

// ── Build pipeline ────────────────────────────────────────────────────────────

ipcMain.on('build:start', (event, params) => {
  runBuild(event.sender, params.workspacePath, params.folder || params.date, params.date, !!params.communion);
});

async function runBuild(sender, workspacePath, folder, date, communion) {
  const emit = (line, type = 'info') => sender.send('build:log', { line, type });

  const dateDir = path.join(workspacePath, folder);

  try {
    // Ensure date directory exists
    if (!fs.existsSync(dateDir)) {
      fs.mkdirSync(dateDir, { recursive: true });
      emit(`Created ${folder}/`);
    }

    // ── Step 1: Load order TSV ────────────────────────────────────────────
    emit('\n▶ Step 1: Loading order of worship', 'step');
    const savedOrderPath = path.join(dateDir, 'order.tsv');

    if (!fs.existsSync(savedOrderPath)) {
      throw new Error(
        `No order of worship found for "${folder}".\n` +
        `Open the Order tab, add your service items, save, then build.`
      );
    }

    const tsvContent = fs.readFileSync(savedOrderPath, 'utf8');
    emit(`Loaded ${folder}/order.tsv (${tsvContent.split('\n').filter(Boolean).length} rows)`);

    // ── Step 2: Render HTML ───────────────────────────────────────────────
    emit('\n▶ Step 2: Rendering bulletin HTML', 'step');

    // Read sidecar files needed for the announcements page
    const annPath  = path.join(dateDir, 'announcements.txt');
    const annItems = fs.existsSync(annPath)
      ? parseAnnouncements(fs.readFileSync(annPath, 'utf8'))
      : [];

    const configPath = path.join(workspacePath, 'bulletin-config.json');
    const globalConfig = fs.existsSync(configPath)
      ? (() => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } })()
      : {};
    const svcConfigPath = path.join(dateDir, 'service-config.json');
    const svcConfig = fs.existsSync(svcConfigPath)
      ? (() => { try { return JSON.parse(fs.readFileSync(svcConfigPath, 'utf8')); } catch { return {}; } })()
      : {};
    const churchConfig = { ...globalConfig, ...svcConfig };

    const htmlContent = renderBulletinHTML({
      workspacePath,
      folder,
      date,
      tsvContent,
      fontsDir: app.isPackaged
        ? path.join(process.resourcesPath, 'fonts')
        : path.join(__dirname, 'fonts'),
      announcementItems: annItems,
      churchConfig,
    });
    emit(`HTML rendered (${htmlContent.length} bytes)`);

    // ── Step 3: Print to PDF ──────────────────────────────────────────────
    emit('\n▶ Step 3: Printing to PDF', 'step');
    const htmlPath     = path.join(dateDir, 'BULLETIN.html');
    const bulletinPath = path.join(dateDir, 'BULLETIN.pdf');
    await printBulletin(htmlContent, htmlPath, bulletinPath);
    emit(`Wrote ${folder}/BULLETIN.pdf`);

    // ── Step 4: Booklet imposition ────────────────────────────────────────
    emit('\n▶ Step 4: Creating booklet', 'step');
    const bookPath = path.join(dateDir, 'book.pdf');
    await imposeBooklet(bulletinPath, bookPath);
    emit(`Wrote ${folder}/book.pdf`);

    const pdfPath = bulletinPath;
    emit('\n✓ Build complete', 'success');
    sender.send('build:done', { success: true, pdfPath });

  } catch (err) {
    emit(`\n✗ ${err.message}`, 'error');
    sender.send('build:done', { success: false, error: err.message });
  }
}

// ── Database IPC handlers (Phase 1+) ───────────────────────────────────────

ipcMain.handle('db:init', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:migrate', (_, workspacePath) => {
  try {
    const log = {
      info: (...a) => { /* migration is silent on success */ },
      warn: (...a) => console.warn('[DB migrate]', ...a),
      error: (...a) => console.error('[DB migrate]', ...a),
    };
    migrateLegacyFiles(workspacePath, log);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getChurch', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT * FROM church WHERE id = 1').get() ?? null;
  } catch { return null; }
});

ipcMain.handle('db:saveChurch', (_, workspacePath, data) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    db.prepare(`
      UPDATE church SET
        name = COALESCE(?, name),
        denomination = COALESCE(?, denomination),
        tagline = COALESCE(?, tagline),
        standing_note = COALESCE(?, standing_note),
        default_template = COALESCE(?, default_template)
      WHERE id = 1
    `).run(data.name, data.denomination, data.tagline, data.standing_note, data.default_template);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getHymns', (_, workspacePath, filter = {}) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    let sql = 'SELECT * FROM hymns WHERE 1=1';
    const params = [];
    if (filter.source) { sql += ' AND source = ?'; params.push(filter.source); }
    if (filter.query) {
      sql += ' AND (code LIKE ? OR title LIKE ?)';
      const q = filter.query + '%';
      params.push(q, q + '%');
    }
    sql += ' ORDER BY code+0 ASC, code ASC LIMIT 100';
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error(err);
    return [];
  }
});

ipcMain.handle('db:getTemplates', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT id, slug, name, description, is_system FROM templates').all();
  } catch { return []; }
});

ipcMain.handle('db:getTemplate', (_, workspacePath, slug) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT * FROM templates WHERE slug = ?').get(slug) ?? null;
  } catch { return null; }
});

ipcMain.handle('db:listServices', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT id, date, template_id, communion, season, updated_at FROM services ORDER BY date DESC').all();
  } catch { return []; }
});

ipcMain.handle('db:getService', (_, workspacePath, date) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT * FROM services WHERE date = ?').get(date) ?? null;
  } catch { return null; }
});

ipcMain.handle('db:createService', (_, workspacePath, { date, templateSlug, communion, season }) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const template = db.prepare('SELECT id FROM templates WHERE slug = ?').get(templateSlug ?? 'classic-half-sheet');
    const stmt = db.prepare(`
      INSERT INTO services (date, template_id, communion, season)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(date, template?.id ?? null, communion ? 1 : 0, season ?? 'Ordinary Time');
    return { ok: true, serviceId: result.lastInsertRowid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:saveService', (_, workspacePath, { date, communion, season }) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    db.prepare(`
      UPDATE services SET
        communion = COALESCE(?, communion),
        season = COALESCE(?, season),
        updated_at = datetime('now')
      WHERE date = ?
    `).run(communion != null ? (communion ? 1 : 0) : null, season, date);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:deleteService', (_, workspacePath, date) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    db.prepare('DELETE FROM services WHERE date = ?').run(date);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getOrderItems', (_, workspacePath, date) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const service = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
    if (!service) return [];
    return db.prepare(`
      SELECT oi.*, h.code as hymn_code, h.title as hymn_title, h.tune as hymn_tune
      FROM order_items oi
      LEFT JOIN hymns h ON oi.hymn_id = h.id
      WHERE oi.service_id = ?
      ORDER BY oi.section, oi.position
    `).all(service.id);
  } catch (err) {
    console.error(err);
    return [];
  }
});

ipcMain.handle('db:saveOrderItems', (_, workspacePath, date, items) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const service = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
    if (!service) return { ok: false, error: 'Service not found' };

    const upsert = db.prepare(`
      INSERT INTO order_items (service_id, position, section, type, enabled, name, ref, note, hymn_id, custom_text, file_path, is_fixed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        position = excluded.position, section = excluded.section, type = excluded.type,
        enabled = excluded.enabled, name = excluded.name, ref = excluded.ref,
        note = excluded.note, hymn_id = excluded.hymn_id,
        custom_text = excluded.custom_text, file_path = excluded.file_path,
        is_fixed = excluded.is_fixed
    `);

    const replace = db.transaction((rows) => {
      // Clear non-fixed items for this service
      db.prepare('DELETE FROM order_items WHERE service_id = ? AND is_fixed = 0').run(service.id);
      for (const item of rows) {
        if (item.is_fixed) continue; // don't reinsert fixed items
        upsert.run(
          service.id, item.position, item.section, item.type,
          item.enabled ? 1 : 0, item.name, item.ref, item.note,
          item.hymn_id ?? null, item.custom_text ?? null, item.file_path ?? null,
          item.is_fixed ? 1 : 0
        );
      }
    });
    replace(items);
    // Touch updated_at
    db.prepare("UPDATE services SET updated_at = datetime('now') WHERE id = ?").run(service.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getAnnouncements', (_, workspacePath, date) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const service = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
    if (!service) return [];
    return db.prepare('SELECT * FROM announcements WHERE service_id = ? ORDER BY position').all(service.id);
  } catch { return []; }
});

ipcMain.handle('db:saveAnnouncements', (_, workspacePath, date, items) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const service = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
    if (!service) return { ok: false, error: 'Service not found' };

    const upsert = db.prepare(`
      INSERT INTO announcements (service_id, position, type, label, body, title, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        position = excluded.position, type = excluded.type, label = excluded.label,
        body = excluded.body, title = excluded.title, content = excluded.content
    `);

    const replace = db.transaction((rows) => {
      db.prepare('DELETE FROM announcements WHERE service_id = ?').run(service.id);
      rows.forEach(item => {
        upsert.run(service.id, item.position, item.type, item.label, item.body, item.title, item.content);
      });
    });
    replace(items);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getLiturgyConstants', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT lc.*, h.code as hymn_code, h.title as hymn_title FROM liturgy_constants lc LEFT JOIN hymns h ON lc.hymn_id = h.id').all();
  } catch { return []; }
});

ipcMain.handle('db:saveLiturgyConstant', (_, workspacePath, key, value, hymnId = null) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    db.prepare('INSERT OR REPLACE INTO liturgy_constants (key, value, hymn_id) VALUES (?, ?, ?)').run(key, value, hymnId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getSecondPageBlocks', (_, workspacePath, date) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    // Per-service overrides shadow global defaults
    const global = db.prepare("SELECT * FROM second_page_blocks WHERE service_id IS NULL OR service_id = '' ORDER BY position").all();
    if (!date) return global;
    const service = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
    if (!service) return global;
    const perSvc = db.prepare('SELECT * FROM second_page_blocks WHERE service_id = ?').all(service.id);
    // Merge: per-service version overrides global by label
    const byLabel = {};
    for (const b of global) byLabel[b.label] = { ...b };
    for (const b of perSvc) byLabel[b.label] = { ...b, scope: 'service' };
    return Object.values(byLabel).sort((a, b) => a.position - b.position);
  } catch (err) {
    return [];
  }
});

ipcMain.handle('db:saveSecondPageBlock', (_, workspacePath, date, block) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    let serviceId = null;
    if (date) {
      const svc = db.prepare('SELECT id FROM services WHERE date = ?').get(date);
      serviceId = svc?.id ?? null;
    }
    if (serviceId) {
      db.prepare(`
        INSERT INTO second_page_blocks (service_id, type, label, enabled, position, scope, file_path, custom_content)
        VALUES (?, ?, ?, ?, ?, 'service', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled, position = excluded.position,
          file_path = excluded.file_path, custom_content = excluded.custom_content
      `).run(serviceId, block.type, block.label, block.enabled ? 1 : 0, block.position, block.file_path, block.custom_content);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:getAssets', (_, workspacePath) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    return db.prepare('SELECT id, filename, mime, width, height, created_at FROM assets ORDER BY created_at DESC').all();
  } catch { return []; }
});

ipcMain.handle('db:saveAsset', (_, workspacePath, { filename, mime, blob, width, height }) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const result = db.prepare(`
      INSERT INTO assets (filename, mime, blob, width, height)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        filename = excluded.filename, mime = excluded.mime,
        blob = excluded.blob, width = excluded.width, height = excluded.height
    `).run(filename, mime, Buffer.from(blob), width, height);
    return { ok: true, assetId: result.lastInsertRowid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:deleteAsset', (_, workspacePath, id) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:addHymn', (_, workspacePath, hymn) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const result = db.prepare(`
      INSERT INTO hymns (code, title, tune, meter, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET title=excluded.title, tune=excluded.tune, meter=excluded.meter
    `).run(hymn.code, hymn.title, hymn.tune, hymn.meter ?? null, hymn.source ?? 'custom');
    return { ok: true, hymnId: result.lastInsertRowid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:importHymns', (_, workspacePath, hymns, source) => {
  try {
    const db = getWorkspaceDb(workspacePath);
    const upsert = db.prepare(`
      INSERT INTO hymns (code, title, tune, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET title=excluded.title, tune=excluded.tune
    `);
    const tx = db.transaction((rows) => {
      let count = 0;
      for (const h of rows) {
        if (h.code) { upsert.run(h.code, h.title || '', h.tune || '', source); count++; }
      }
      return count;
    });
    const count = tx(hymns);
    db.prepare(`INSERT INTO import_log (source, count) VALUES (?, ?)`).run(source, count);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
