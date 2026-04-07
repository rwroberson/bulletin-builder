const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn } = require('child_process');
const { renderBulletinHTML } = require('./bulletin-render');
const { printBulletin, imposeBooklet } = require('./bulletin-print');

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
