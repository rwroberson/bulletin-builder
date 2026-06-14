# Perfect Bulletin Builder — Execution Plan

**Goal:** Build a self-contained church bulletin application that a non-technical
secretary can open, select a date, pick a template, fill in fields, and produce
a polished PDF — with no knowledge of LaTeX, file formats, or the command line.

Inspired by Planning Center Services and Canva: the app owns all data,
manages all assets, and presents a WYSIWYG canvas experience.

---

## Part I — Architecture Overhaul

### 1. Internal SQLite Database

Replace all loose files (`schedule.csv`, `announcements.txt`, etc.) with a
single SQLite database per workspace. This is the biggest architectural change.

**Why SQLite:**
- Single file, portable, zero-config, decades of stability
- Queryable, relational, supports full-text search
- Plain enough that a determined user could still read it with `sqlite3`
- Embedded in the app via `better-sqlite3`

**Schema sketch:**

```sql
-- Workspace-level config
CREATE TABLE church (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  denomination TEXT,
  tagline TEXT,
  logo_blob BLOB,          -- stored directly in DB
  logo_mime TEXT,
  standing_note TEXT,
  default_template TEXT    -- slug of default template
);

-- Hymnal
CREATE TABLE hymns (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,  -- "341", "P103", "TPH325"
  title TEXT NOT NULL,
  tune TEXT,
  meter TEXT,
  source TEXT               -- "CSH", "TPH", "BHC", "custom"
);

-- Templates
CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,         -- "Classic Half-Sheet"
  description TEXT,
  html_layout TEXT NOT NULL,  -- full HTML with {{placeholders}}
  css TEXT NOT NULL,
  is_system BOOLEAN DEFAULT 0
);

-- Services (one per Sunday)
CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,  -- "2026-06-21"
  template_id INTEGER REFERENCES templates(id),
  communion BOOLEAN DEFAULT 0,
  season TEXT,                -- "Ordinary Time", "Advent", etc.
  created_at TEXT,
  updated_at TEXT
);

-- Order-of-worship items for a service
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,         -- "heading","element","hymn","prayer",
                              -- "responsive","raw"
  enabled BOOLEAN DEFAULT 1,
  name TEXT,
  ref TEXT,                   -- scripture reference
  note TEXT,                  -- right-side note
  hymn_id INTEGER REFERENCES hymns(id),
  custom_text TEXT,          -- for prayer/responsive/raw
  file_path TEXT              -- for file-based prayers
);

-- Announcements
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY,
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,         -- "item","announcec","announcel","raw"
  label TEXT,
  body TEXT,
  title TEXT,
  content TEXT
);

-- Second-page blocks
CREATE TABLE second_page_blocks (
  id INTEGER PRIMARY KEY,
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
  type TEXT NOT NULL,         -- "announcements","textfile","element"
  label TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  position INTEGER NOT NULL,
  scope TEXT DEFAULT 'service',  -- "service" or "global"
  file_path TEXT,             -- for textfile/element types
  custom_content TEXT         -- inline content if not file-based
);

-- Images/assets
CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  blob BLOB NOT NULL,
  created_at TEXT
);

-- Fixed liturgical constants (editable per-church)
CREATE TABLE liturgy_constants (
  key TEXT PRIMARY KEY,       -- "benediction", "departure_hymn", etc.
  value TEXT NOT NULL,
  hymn_id INTEGER REFERENCES hymns(id)
);
```

**Migration path:** On first launch, the app imports all existing loose files
(`schedule.csv`, `csh.tsv`, `elements/*.txt`, etc.) into the new SQLite DB.
After confirming everything looks right, the loose files become a backup.

---

### 2. Image/Asset Manager

Store logos and images as blobs in SQLite. The UI has a full media library:

- **Upload** — drag-and-drop or file picker (PNG, JPG, SVG, PDF)
- **Browse** — grid view of all uploaded images with thumbnails
- **Delete** — with confirmation
- **Insert** — pick an image to use in a template or announcement
- **Logo auto-detect** — if a `church-logo.png` is uploaded, auto-use it in headers

Assets live in the `assets` table. Templates reference them by ID.

---

### 3. Hymnal Manager

Planning Center Services-style hymnal management.

**Import options:**
- **Hymnary.org bulk import** — Enter a range of hymn numbers, app fetches
  metadata via hymnary.org's API (or scraping as fallback). User reviews before
  confirming import.
- **CSV/TSV upload** — Map columns (number, title, tune) → fields
- **Manual entry** — One-off hymn creation

**Hymnal browser:**
- Searchable list (filter by title, tune, number)
- Click to see hymn details
- Edit/delete
- Filter by source (CSH, TPH, BHC, custom)

**In the service editor**, hymn fields autocomplete against this DB.

---

## Part II — Template System

### 4. Template Engine

Templates are HTML+CSS with `{{mustache-style}}` placeholders.

**Why mustache-style (not a full visual editor):**
- Non-programmers can read and edit templates
- No lock-in to a specific visual editor format
- Can be version-controlled as plain text

**Example placeholders:**
```
{{church.name}}
{{church.tagline}}
{{service.date_formatted}}
{{order_items}}           <!-- renders full order of worship -->
{{#each order_items}}...{{/each}}
{{announcements}}
{{second_page_blocks}}
{{#if communion}}...{{/if}}
{{#if service.season}}...{{/if}}
```

**Built-in helpers** (computed at render time):
- `date_formatted` — "June 21, 2026"
- `date_season` — "Eight Sunday after Pentecost"
- `date_liturgical_color` — "Green"

**The canvas renders the template live** as the secretary fills in fields.
No "preview" mode separate from the editor — what you see IS the bulletin.

---

### 5. Bundled Starter Templates

Ship with 4–6 templates covering common formats:

| Template | Description |
|---|---|
| **Classic Half-Sheet** | Your current format: 5.5×8.5 in, two-column |
| **Letter Half-Sheet (2-up)** | Same as Classic, imposition-ready |
| **Letter Full-Page** | Single page, 8.5×11 in |
| **Booklet** | Full-page with facing-page imposition |
| **Modern Card** | A6 card size, minimal |
| **Dark/Formal** | Elegant black-and-white for Maundy Thursday/Good Friday |

Each template ships as a CSS file + HTML layout file, installed to the app's
config directory on first run. Custom templates can be added.

---

### 6. Visual Template Editor (Future)

**Not for v1.** The initial release ships with fixed templates. A future version
adds a visual canvas for drag-and-drop template editing (see Part IV).

---

## Part III — Secretary Workflow UI

### 7. Service Creation Wizard

**Step 1 — Date & Season**
- Pick a Sunday date (calendar picker, defaults to next Sunday)
- Select liturgical season (auto-suggested, editable)
- Check "Communion" if applicable

**Step 2 — Template Selection**
- Grid of template thumbnails
- Pick one — shows a preview

**Step 3 — Fill the fields**
- The canvas shows the live bulletin
- A collapsible **Inspector panel** on the right shows fields relevant to
  the selected element on the canvas
- Tab through: Order of Worship → Announcements → Second Page → Review

**Step 4 — Build & Review**
- Live-updating preview
- Build PDF button
- Download / Print

---

### 8. Canvas View (WYSIWYG)

The main editor shows the bulletin as it will print, scaled to fit the window.

**Interactions:**
- Click an element → inspector shows its fields
- Drag elements to reorder (constrained by template structure)
- Hover shows element type badge
- Double-click text to edit inline (optional, can be form-only)

**Sections (not fully free-form):**
- **Header** — Church name, logo, date, season
- **Order of Worship** — The liturgical flow (capped to standard sections)
- **Announcements** — The weekly announcements block
- **Second Page** — Prayer list, birthdays, officers, custom blocks
- **Footer** — Copyright, website, week-ahead note

Each section is a well-defined slot. The secretary fills it; the template
renders it. This is what "InDesign-like but not overwhelming" means:
real visual feedback, but guardrails that keep the bulletin looking good
without requiring design skill.

---

### 9. Order of Worship Editor (Section-Based)

Instead of a raw TSV editor, the order is built from well-defined sections:

**Sections (fixed, in order):**
1. God Calls Us
2. God Cleanses Us
3. God Consecrates Us
4. God Communes with Us *(optional, shown when communion=true)*
5. God Commissions Us

**Within each section:**
- Add: Hymn, Scripture Reading, Prayer, Responsive Reading, Custom element
- Reorder via drag-and-drop within the section
- Each item has: Name, Scripture Reference, Note, Hymn Number (with autocomplete)
- Fixed elements (Benediction, Doxology, Gloria Patri, Departure Hymn) are
  pre-populated and visually distinct (locked icon, but can be unlocked)

**Responsive Reading builder:**
- Label (e.g., "Psalm 23")
- Parts: Minister → All → Minister → All...
- Add/remove parts
- Each part: Speaker dropdown + text area

---

### 10. Announcements Editor (Visual)

- Live list of announcement cards
- Add: Bullet item, Boxed (centered), Boxed (left-aligned)
- Drag to reorder
- Each card: label field + body textarea
- See the change reflected on the canvas immediately

---

### 11. Second Page Block Manager

- List of blocks: Announcements, Prayer List, Birthdays, Officers, Custom
- Toggle enabled/disabled per block
- Reorder via drag-and-drop
- Click to expand and edit inline
- "Add Custom Block" — pick a name, then edit as raw text or choose an
  element file from the library

---

## Part IV — Polish & Ecosystem

### 12. Visual Template Canvas (Future)

A drag-and-drop layout editor for creating new templates:

- **Toolbox** — Drag section types onto the canvas: Header, Order Block,
  Announcements Block, Text Block, Image Block, Page Break, Spacer
- **Property inspector** — Set width, alignment, font size per element
- **Snap to grid** — Keeps things aligned without requiring precision
- **Zoom** — Fit to window, 50%, 100%, 200%
- **HTML/CSS export** — Download template as `template.html` + `template.css`

**Constraints:**
- Only allows valid section types — can't create a blank canvas
- Prevents breaking the liturgical structure (can't delete required sections
  without a warning)
- Color/font choices from a curated palette (not a full color picker)

---

### 13. Planning Center Services Import (Future)

Import the church's Planning Center Services account data:
- Services and their orders
- Songs/hymns (mapped to the local hymnal DB)
- People (for the prayer list)

This requires a PCO API key entered in settings.

---

### 14. Settings Panel

- **Church identity** — Name, denomination, tagline, standing note
- **Hymnal manager** — Open hymnal import/export
- **Media library** — Open asset manager
- **Liturgy constants** — Edit Benediction, Gloria Patri, Doxology, Departure Hymn
- **Template management** — View/add/delete custom templates
- **Data** — Export all data as ZIP, import from backup, reset workspace
- **About** — Version, licenses, links

---

### 15. Electron App Shell

**Current state:** Rough prototype.
**Target state:** Production desktop app.

- [ ] **Auto-update** — `electron-updater` for seamless updates
- [ ] **Offline-first** — No network required for any core function
- [ ] **Window management** — Remember window size/position, min size enforced
- [ ] **Native menus** — File (New Service, Save, Export PDF…), Edit (Undo, Redo),
      View (Zoom), Help
- [ ] **Global shortcut** — `Cmd/Ctrl+Shift+B` to open app from anywhere
- [ ] **Drag workspace folder onto app** — Opens it as the active workspace
- [ ] **Unsaved changes guard** — Alert on close with unsaved changes
- [ ] **Crash reporting** — `electron-crash-reporter` or self-hosted solution
- [ ] **Spell-check** — Enable spellcheck on all text areas; language matches
      the church's setting
- [ ] **Undo/Redo** — Full undo stack for all editors (using a state machine)
- [ ] **Logging** — `electron-log` to file for troubleshooting

---

### 16. Build & Distribution

- [ ] **macOS build** — Add `osx` target to `electron-builder`
- [ ] **Linux build** — Add `linux` target (AppImage or .deb)
- [ ] **Windows installer** — `nsis` target alongside current `zip`
- [ ] **Code signing** — Apple Developer ($99/yr) + Microsoft signing
- [ ] **Auto-update server** — Simple S3/cloudfront setup for `electron-updater`

---

### 17. Open Source Release

- Push to GitHub public repo
- `README.md` with clear install instructions for all three platforms
- `CONTRIBUTING.md` — Dev setup, architecture overview
- License: MIT (or Apache 2.0)
- Issue tracker for bug reports and feature requests
- `docs/` folder with screenshot tour and FAQ

---

## Part V — Implementation Phases

### Phase 1: Foundation (4–6 weeks)

**Goal:** Get the secretary workflow working end-to-end with the existing
bulletin format as the only template.

1. Replace loose-file storage with SQLite (with import of existing data)
2. Build the service wizard (date → template → fill → build)
3. Implement the WYSIWYG canvas (renders template HTML live)
4. Build section-based order editor (hymns with autocomplete, prayers, responsive)
5. Build announcements editor (visual, live-updating canvas)
6. Build PDF generation from rendered HTML (current approach is fine)
7. Image manager (upload, store in DB, use in templates)
8. Hymnal manager (manual add/edit, CSV import)
9. Ship with 1 template (current half-sheet format, converted to template system)
10. Settings panel (church identity, liturgy constants)
11. Unsaved changes guard + crash resilience

### Phase 2: Polish & Multi-Template (2–3 weeks)

1. Add 3–5 additional bundled templates
2. Template switcher in the service wizard
3. Second page block manager (visual)
4. Improved canvas interactions (click to select, drag to reorder)
5. Responsive reading builder UI
6. Full undo/redo system
7. Spell-check integration
8. macOS + Linux builds

### Phase 3: Hymnal Ecosystem (2–3 weeks)

1. Hymnary.org import (API or scraping fallback)
2. Hymnal export (CSV, PDF hymn sheet generator)
3. Hymn search across all sources
4. Planning Center Services import (future, API-dependent)

### Phase 4: Visual Template Editor (3–4 weeks)

1. Drag-and-drop template canvas
2. Property inspector for layout elements
3. Template save/export as HTML+CSS files
4. User-created templates in the wizard picker

### Phase 5: Open Source & Distribution (1–2 weeks)

1. Public GitHub repo, README, docs
2. Auto-update server setup
3. Code signing
4. Marketing one-pager for church technology blogs

---

## Appendix — Key Libraries

| Purpose | Library | Notes |
|---|---|---|
| Desktop framework | Electron 28+ | Same as current |
| Database | `better-sqlite3` | Synchronous, fast, single-file |
| Template engine | `mustache` or `handlebars` | Familiar syntax, no runtime deps |
| PDF generation | Current `printToPDF` approach | Works well; evaluate `puppeteer` if issues |
| Booklet imposition | `pdf-lib` | Already in use; works fine |
| Drag-and-drop | Native Pointer Events API | Already implemented in drag-drop.js |
| Auto-update | `electron-updater` | Standard solution |
| Logging | `electron-log` | File + console logging |
| Crash reporting | `electron-crash-reporter` | Self-hosted or disabled |
| Image processing | `sharp` | Thumbnailing, resize for media library |
| Spell-check | Native browser spellcheck | Already available; just enable |

---

*Plan written: 2026-06-14. Update as scope and priorities shift.*
