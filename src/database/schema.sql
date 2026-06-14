-- Bulletin Builder SQLite Schema
-- All tables use INTEGER PRIMARY KEY (auto-increment) unless noted.

-- Workspace-level church configuration
CREATE TABLE IF NOT EXISTS church (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'My Church',
  denomination TEXT,
  tagline TEXT,
  logo_blob BLOB,
  logo_mime TEXT,
  standing_note TEXT,
  default_template TEXT DEFAULT 'classic-half-sheet'
);

-- Injected automatically on first insert
INSERT OR IGNORE INTO church (id, name) VALUES (1, 'My Church');

-- Hymnal entries (hymn numbers with metadata)
CREATE TABLE IF NOT EXISTS hymns (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- "341", "P103", "TPH325"
  title TEXT NOT NULL,
  tune TEXT,
  meter TEXT,
  source TEXT NOT NULL DEFAULT 'custom'  -- "CSH", "TPH", "BHC", "custom"
);
CREATE INDEX IF NOT EXISTS idx_hymns_code ON hymns(code);
CREATE INDEX IF NOT EXISTS idx_hymns_source ON hymns(source);

-- Bulletin templates
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  html_layout TEXT NOT NULL,           -- full HTML with {{mustache}} placeholders
  css TEXT NOT NULL,                  -- embedded CSS
  is_system INTEGER NOT NULL DEFAULT 0  -- 1=bundled, can't delete
);
-- Insert default bundled templates
INSERT OR IGNORE INTO templates (slug, name, description, html_layout, css, is_system) VALUES
('classic-half-sheet', 'Classic Half-Sheet', '5.5×8.5 in half-sheet, two-column layout', '', '', 1),
('letter-full-page', 'Letter Full-Page', '8.5×11 in single page', '', '', 1),
('booklet', 'Booklet', 'Full-page with facing-page imposition', '', '', 1);

-- Weekly services
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,          -- "2026-06-21"
  template_id INTEGER REFERENCES templates(id),
  communion INTEGER NOT NULL DEFAULT 0,
  season TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_services_date ON services(date);

-- Order-of-worship items for a service
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT 'consecrates',  -- calls|cleanses|consecrates|communes|commissions
  type TEXT NOT NULL,                 -- heading|element|hymn|prayer|responsive|raw
  enabled INTEGER NOT NULL DEFAULT 1,
  name TEXT,
  ref TEXT,                          -- scripture reference
  note TEXT,                         -- right-side note
  hymn_id INTEGER REFERENCES hymns(id),
  custom_text TEXT,                  -- raw text for prayer/responsive/raw
  file_path TEXT,                    -- for file-based elements
  is_fixed INTEGER NOT NULL DEFAULT 0  -- 1=locked (benediction, etc.)
);
CREATE INDEX IF NOT EXISTS idx_order_items_service ON order_items(service_id);

-- Announcements for a service
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,               -- item|announcec|announcel|raw
  label TEXT,
  body TEXT,
  title TEXT,
  content TEXT
);
CREATE INDEX IF NOT EXISTS idx_announcements_service ON announcements(service_id);

-- Second-page blocks (global defaults + per-service overrides)
CREATE TABLE IF NOT EXISTS second_page_blocks (
  id INTEGER PRIMARY KEY,
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,  -- NULL=global default
  type TEXT NOT NULL,               -- announcements|textfile|element
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',  -- global|service
  file_path TEXT,
  custom_content TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocks_service ON second_page_blocks(service_id);

-- Uploaded images and assets
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  blob BLOB NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_filename ON assets(filename);

-- Editable liturgical constants (benediction text, fixed hymns, etc.)
CREATE TABLE IF NOT EXISTS liturgy_constants (
  key TEXT PRIMARY KEY,              -- "benediction", "gloria_patri", etc.
  value TEXT NOT NULL,
  hymn_id INTEGER REFERENCES hymns(id)
);
-- Insert defaults
INSERT OR IGNORE INTO liturgy_constants (key, value) VALUES
('benediction', 'Numbers 6:24-26'),
('gloria_patri_hymn_id', NULL),
('doxology_hymn_id', NULL),
('departure_hymn', 'Shalom to You'),
('departure_hymn_tune', 'SOMOS DEL SENOR');

-- Hymnal imports log (for tracking import history)
CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,              -- "csv", "hymnary", "manual"
  count INTEGER NOT NULL DEFAULT 0,
  details TEXT                      -- JSON with column mapping, etc.
);
