'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/** Per-workspace DB instances */
const _instances = new Map();

/**
 * Open (or create) the SQLite database for a workspace.
 * @param {string} workspacePath
 * @returns {Database.Database}
 */
function getWorkspaceDb(workspacePath) {
  if (_instances.has(workspacePath)) {
    return _instances.get(workspacePath);
  }

  const dbPath = path.join(workspacePath, '.bulletin.db');
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  _instances.set(workspacePath, db);
  return db;
}

/**
 * Close and remove a workspace DB instance.
 * Call when a workspace is closed/unmounted.
 * @param {string} workspacePath
 */
function closeWorkspaceDb(workspacePath) {
  if (_instances.has(workspacePath)) {
    _instances.get(workspacePath).close();
    _instances.delete(workspacePath);
  }
}

/**
 * Run a migration from legacy loose files into the SQLite DB.
 * Safe to call multiple times — uses INSERT OR IGNORE / INSERT OR REPLACE
 * so existing DB data is preserved.
 * @param {string} workspacePath
 * @param {object} log - Logger with .info, .warn, .error methods
 */
function migrateLegacyFiles(workspacePath, log = console) {
  const db = getWorkspaceDb(workspacePath);
  const backupDir = path.join(workspacePath, '.bulletin-backup');

  const tryBackup = (file) => {
    const src = path.join(workspacePath, file);
    if (fs.existsSync(src)) {
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const dest = path.join(backupDir, file);
      fs.copyFileSync(src, dest);
      log.info(`Backed up ${file} → .bulletin-backup/`);
    }
  };

  // ── 1. bulletin-config.json → church table ──────────────────────────────
  const configPath = path.join(workspacePath, 'bulletin-config.json');
  if (fs.existsSync(configPath)) {
    tryBackup('bulletin-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    db.prepare(`
      UPDATE church SET
        name = COALESCE(NULLIF(?, ''), name),
        denomination = COALESCE(NULLIF(?, ''), denomination),
        tagline = COALESCE(NULLIF(?, ''), tagline),
        standing_note = COALESCE(NULLIF(?, ''), standing_note)
      WHERE id = 1
    `).run(
      config['church-name'] || config.churchName || '',
      config.denomination || '',
      config['denomination'] || '',
      config['standing-note'] || config.standingNote || ''
    );
    log.info('Migrated bulletin-config.json → church table');
  }

  // ── 2. schedule.csv → services table ───────────────────────────────────
  const schedulePath = path.join(workspacePath, 'schedule.csv');
  if (fs.existsSync(schedulePath)) {
    tryBackup('schedule.csv');
    const lines = fs.readFileSync(schedulePath, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length > 1) {
      const insertService = db.prepare(`
        INSERT OR IGNORE INTO services (date, season)
        VALUES (?, ?)
      `);
      const migrateAll = db.transaction((rows) => {
        for (const row of rows) {
          if (/^\d{4}-\d{2}-\d{2}/.test(row[0])) {
            insertService.run(row[0], row[1] || 'Ordinary Time');
          }
        }
      });

      // Parse quoted CSV
      const parseRow = (line) => {
        const fields = [];
        let inQuotes = false, field = '', i = 0;
        while (i < line.length) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuotes && line[i+1] === '"') { field += '"'; i++; }
            else inQuotes = !inQuotes;
          } else if (ch === ',' && !inQuotes) { fields.push(field); field = ''; }
          else field += ch;
          i++;
        }
        fields.push(field);
        return fields;
      };

      const rows = lines.slice(1).map(parseRow);
      migrateAll(rows);
      log.info(`Migrated ${lines.length - 1} schedule rows → services`);
    }
  }

  // ── 3. csh.tsv → hymns table ──────────────────────────────────────────
  const cshPath = path.join(workspacePath, 'csh.tsv');
  if (fs.existsSync(cshPath)) {
    tryBackup('csh.tsv');
    const lines = fs.readFileSync(cshPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      // Skip the header row (NUM \t TITLE \t TUNE)
      .filter(l => !/^NUM\tTITLE\tTUNE$/i.test(l.trim()));
    const insertHymn = db.prepare(`
      INSERT OR REPLACE INTO hymns (code, title, tune, source)
      VALUES (?, ?, ?, 'CSH')
    `);
    const migrateAll = db.transaction((hymnLines) => {
      for (const line of hymnLines) {
        const [code, title, tune] = line.split('\t');
        if (code) insertHymn.run(code.trim(), title?.trim() || '', tune?.trim() || '');
      }
    });
    migrateAll(lines);
    log.info(`Migrated ${lines.length} hymns from csh.tsv`);
  }

  // ── 4. elements/*.txt → liturgy_constants ─────────────────────────────
  const elementsDir = path.join(workspacePath, 'elements');
  if (fs.existsSync(elementsDir)) {
    const files = fs.readdirSync(elementsDir).filter(f => f.endsWith('.txt'));
    const insertLit = db.prepare(`
      INSERT OR REPLACE INTO liturgy_constants (key, value)
      VALUES (?, ?)
    `);
    for (const file of files) {
      const key = file.replace(/\.txt$/, '');
      // Strip non-printable characters (e.g. BOM \x1B) from content
      const content = fs.readFileSync(path.join(elementsDir, file), 'utf8')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .trim();
      if (content) insertLit.run(key, content);
    }
    if (files.length) log.info(`Migrated ${files.length} element files → liturgy_constants`);
  }

  // ── 5. Default second-page blocks ─────────────────────────────────────
  const insertBlock = db.prepare(`
    INSERT OR IGNORE INTO second_page_blocks (service_id, type, label, position, scope, file_path)
    VALUES (NULL, ?, ?, ?, 'global', ?)
  `);
  const defaultBlocks = [
    ['announcements', 'Announcements', 0, null],
    ['textfile', 'Prayer List', 1, 'prayer-list.txt'],
    ['textfile', 'Birthdays', 2, 'birthdays.txt'],
    ['element', 'Officers', 3, 'elements/officers.txt'],
  ];
  for (const [type, label, pos, fp] of defaultBlocks) {
    insertBlock.run(type, label, pos, fp);
  }

  log.info('Migration complete.');
}

module.exports = { getWorkspaceDb, closeWorkspaceDb, migrateLegacyFiles };
