# Phase 1 Sprint Plan — Foundation

**Goal:** Secretary opens app → picks date → picks template → fills in fields → builds PDF.  
**Hard constraint:** No external file formats exposed. Everything in SQLite.  
**Template:** Only the Classic Half-Sheet (current format) for now.

---

## Step 1 — Database Foundation

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 1.1 — Install and configure better-sqlite3

```bash
cd ~/repos/bulletin-builder
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

### 1.2 — Create `src/database/`

```
src/database/
  index.js          # DB singleton, exports the db connection
  schema.sql        # All CREATE TABLE statements
  migrate.js        # Import logic for legacy loose files
```

### 1.3 — `schema.sql`

Full CREATE TABLE statements for:

- `church` — id, name, denomination, tagline, standing_note, logo_blob, logo_mime, default_template
- `hymns` — id, code, title, tune, meter, source
- `templates` — id, slug, name, description, html_layout, css, is_system
- `services` — id, date, template_id, communion, season, created_at, updated_at
- `order_items` — id, service_id, position, type, enabled, name, ref, note, hymn_id, custom_text, file_path
- `announcements` — id, service_id, position, type, label, body, title, content
- `second_page_blocks` — id, service_id, type, label, enabled, position, scope, file_path, custom_content
- `assets` — id, filename, mime, blob, created_at
- `liturgy_constants` — key, value, hymn_id

All tables have `WITHOUT ROWID` on tables where integer primary key is sufficient.
Add SQLite indexes on: `services(date)`, `order_items(service_id)`, `announcements(service_id)`.

### 1.4 — `src/database/index.js`

```js
// Opens or creates the DB at workspace/.bulletin.db
// Exposes:
//   db.prepare(sql) — prepared statements
//   db.transaction(fn) — batched writes
//   getWorkspaceDb(workspacePath) — per-workspace instance
```

### 1.5 — `src/database/migrate.js`

Import logic for each legacy file:

| Legacy file | Import action |
|---|---|
| `schedule.csv` | For each row, INSERT into `services` (date, season) |
| `csh.tsv` | INSERT INTO hymns (code, title, tune, source='CSH') |
| `elements/*.txt` | Store as `liturgy_constants` entries keyed by filename |
| `prayer-list.txt` | Store as `second_page_blocks` default block |
| `birthdays.txt` | Store as `second_page_blocks` default block |
| `bulletin-config.json` | Map to `church` table fields |

On first open of a workspace:
1. Detect legacy files present
2. Run all applicable imports
3. Show a one-time "Migrated N items from existing files" notice
4. Back up original files to `workspace/.bulletin-backup/`

### 1.6 — Verify

- Open the app with a test workspace
- Confirm `.bulletin.db` is created
- Confirm data matches original files
- Confirm original files are backed up

**Deliverable:** `git add src/database/` — commit with message: `feat(db): add SQLite schema, init, and loose-file migrator`

---

## Step 2 — Service Wizard

**Owner:** Archie  
**Time estimate:** 3–4 hours

### 2.1 — New Service Dialog (replaces current service dialog)

**Step 1 — Date & Type**
```
┌─────────────────────────────────────────────┐
│  New Service                          [×]    │
├─────────────────────────────────────────────┤
│                                             │
│  Date:  [____-__-__]  [Calendar picker]    │
│                                             │
│  Service type:                              │
│    (•) Lord's Day                          │
│    ( ) Feast Day (specify: ___________)    │
│    ( ) Special (funeral, wedding, etc.)    │
│                                             │
│  □ Communion this service                   │
│                                             │
│  Season:  [Dropdown: Ordinary Time ▼]        │
│                                             │
│         [Cancel]           [Next →]        │
└─────────────────────────────────────────────┘
```

### 2.2 — Template Selection (Step 2)

```
┌─────────────────────────────────────────────┐
│  New Service — Choose Template        [×]    │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────┐  ┌─────────────┐            │
│  │ [preview]  │  │ [preview]  │  ...       │
│  │ Classic    │  │ Letter     │            │
│  │ Half-Sheet │  │ Full-Page  │            │
│  └─────────────┘  └─────────────┘            │
│                                             │
│  (only Classic active for now; others      │
│   grayed out with "Coming soon" badge)      │
│                                             │
│  [← Back]           [Start Editing →]       │
└─────────────────────────────────────────────┘
```

### 2.3 — On "Start Editing"

- INSERT new service into `services` table
- Navigate to the canvas view
- Pre-populate order of worship with defaults:
  - All fixed liturgy constants (Benediction, Gloria Patri, etc.) inserted
  - Empty slots for hymns and readings (read from schedule.csv if date exists)
  - Communion section inserted if checked

### 2.4 — Modify `workspace:createService` IPC

Remove filesystem mkdir; instead INSERT into DB.

### 2.5 — Update `services` table handling

- `workspace:listServices` reads from DB, not filesystem
- Remove `meta.json` dependency

### 2.6 — Navigation: week sidebar → canvas

When a service is selected in the sidebar, the main view switches to the
canvas (not the old two-tab layout). The old Order/Announcements tabs become
the canvas + inspector panel.

**Deliverable:** `git add src/database/ src/renderer/` — commit: `feat(wizard): multi-step new service dialog with template picker`

---

## Step 3 — WYSIWYG Canvas

**Owner:** Archie  
**Time estimate:** 4–6 hours

### 3.1 — Canvas Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Header bar (same as current)                              │
├─────────────────────────────┬────────────────────────────────┤
│                             │                                │
│   Bulletin canvas            │   Inspector panel              │
│   (live rendered HTML,      │   (fields for selected        │
│   scaled to fit window)      │   element)                    │
│                             │                                │
│   Click element → selects   │   [Order of Worship section]   │
│   Blue border on selected    │   [Hymn #___  Title: ___]      │
│                             │   [Ref: ___  Note: ___]        │
│                             │                                │
│                             │   Service date: 2026-06-21    │
│                             │   Season: Ordinary Time        │
│                             │                                │
└─────────────────────────────┴────────────────────────────────┘
```

### 3.2 — Canvas Rendering

- Read template HTML from `templates` table (slug: `classic-half-sheet`)
- Render with Mustache: merge template + service data + order items + announcements
- Scale the rendered HTML to fit the canvas pane (CSS `transform: scale()`)
- Re-render on every change (debounced 150ms)

### 3.3 — Template HTML for Classic Half-Sheet

Convert the existing bulletin LaTeX style to clean HTML/CSS:

```html
<div class="bulletin half-sheet">
  <header class="bulletin-header">
    <img class="church-logo" src="{{logo_url}}">
    <div class="church-info">
      <div class="church-name">{{church.name}}</div>
      <div class="church-denom">{{church.denomination}}</div>
    </div>
    <div class="service-meta">
      <div class="service-date">{{service.date_formatted}}</div>
      <div class="service-season">{{service.season}}</div>
    </div>
  </header>
  <hr>
  <section class="order-of-worship">
    {{{order_items_html}}}
  </section>
  <hr>
  <section class="announcements">
    {{{announcements_html}}}
  </section>
</div>
```

### 3.4 — Element Selection

- Click any element in the rendered HTML canvas
- Look up the corresponding DOM position → element ID
- Show its fields in the Inspector
- Highlight selected element with blue outline + badge

### 3.5 — Inspector Panel

Dynamically shows fields based on selected element type:

| Element type | Inspector shows |
|---|---|
| Hymn | Number (autocomplete), custom note override |
| Scripture reading | Reference field |
| Prayer | Source dropdown (file or custom text) |
| Responsive reading | Full responsive builder UI |
| Heading | Title field |
| Announcements | Announcement editor |

### 3.6 — Keyboard navigation

- `Tab` / `Shift+Tab` — move between fields
- `↑` / `↓` when a list item is focused — move to prev/next element
- `Enter` on selected element — edit inline
- `Escape` — deselect

### 3.7 — Canvas sizing

- Canvas pane: `flex: 1`
- Inspector pane: `width: 320px`
- Resize handle between them (drag to widen/narrow)
- Zoom control: 50%, 75%, 100%, Fit

**Deliverable:** commit: `feat(canvas): WYSIWYG canvas with live template rendering and inspector panel`

---

## Step 4 — Order Editor (Section-Based)

**Owner:** Archie  
**Time estimate:** 4–5 hours

### 4.1 — Service Sections (fixed structure)

Each section is a collapsible panel in the Inspector:

```
▼ God Calls Us                           [＋ Add item]
   Opening Hymn    #341  ·  Joyful, Joyful    ✎
   Call to Worship  Exodus 15:19            ✎
   Invocation      (fixed, from elements)   🔒

▼ God Cleanses Us                         [＋ Add item]
   Law Reading     Romans 3:19-24           ✎
   Assurance       Romans 5:1-2            🔒

▼ God Consecrates Us                      [＋ Add item]
   Scripture       Acts 2:14-36             ✎
   Hymn            P103  ·  Psalm 23        ✎
   Sermon Text     Acts 2:36                ✎

▼ God Communes with Us  [communion only]   [＋ Add item]

▼ God Commissions Us                      [＋ Add item]
   Closing Hymn    #341                     ✎
   Benediction     Numbers 6:24-26         🔒
   Departure Hymn  Shalom to You           🔒
```

### 4.2 — Section defaults

Auto-populated from `liturgy_constants` table:
- Benediction: Numbers 6:24-26
- Gloria Patri: #436
- Doxology: #434
- Departure Hymn: "Shalom to You" (SOMOS DEL SENOR)

### 4.3 — Adding items

Click "＋ Add item" → popover with options:
- Hymn *(opens hymn search)*
- Scripture Reading
- Prayer *(file picker or custom text)*
- Responsive Reading *(opens builder)*
- Custom LaTeX

### 4.4 — Hymn search popover

```
┌──────────────────────────────────┐
│ 🔍 [____________] (hymn number)  │
│ 341 · Joyful, Joyful · Henderson│
│ P103 · The Lord's My Shepherd    │
│ TPH325 · Crown Him with Kingdom  │
│ [_________] Custom note           │
│          [Cancel] [Insert]       │
└──────────────────────────────────┘
```

Type a number → live filter of hymns starting with that number.
Click to select. Enter custom note. Insert.

### 4.5 — Responsive reading builder

```
Label: [Psalm 23___________]

Part 1: Minister  ▼  [The Lord is my shepherd...]
Part 2: All      ▼  [Surely goodness and mercy...]
[＋ Add part]

[Cancel] [Insert Responsive Reading]
```

### 4.6 — Drag to reorder

Within a section: drag items by the handle.
Between sections: drag items between sections.
Items snap to their section — can't drag a hymn into the middle of God Calls Us.

### 4.7 — Data model

`order_items` table, each item has `type` and section derived from:
- Items have a `section` field (not in original schema — add it)
- Section is determined at insert time based on where it's dropped
- Fixed items (Benediction, etc.) have `is_fixed = 1`

### 4.8 — Save on change

Every change to order items auto-saves (debounced 500ms, with "Saved" indicator).

**Deliverable:** commit: `feat(order): section-based order editor with hymn autocomplete and responsive reading builder`

---

## Step 5 — Announcements Editor (Visual)

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 5.1 — Canvas integration

When user clicks the Announcements section on the canvas, the Inspector
shows the announcements editor (not the order editor).

### 5.2 — Announcement types

| Type | Inspector fields |
|---|---|
| Bullet item | Label (text), Body (textarea) |
| Boxed (centered) | Title (text), Content (textarea) |
| Boxed (left-aligned) | Title (text), Content (textarea) |

### 5.3 — Add/remove/reorder

- "＋ Add Item" / "＋ Add Boxed (centered)" / "＋ Add Boxed (left)"
- Drag to reorder (same FLIP animation as existing drag-drop)
- Click × to delete (with confirm if content is non-empty)

### 5.4 — Canvas re-render on change

Every announcement change → canvas re-renders the announcements section only (not full canvas). Debounced 150ms.

### 5.5 — Existing announcements import

The migrate step reads `YYYY-MM-DD/announcements.txt` and populates the `announcements` table.

**Deliverable:** commit: `feat(announcements): visual announcements editor integrated with canvas`

---

## Step 6 — Second Page Blocks

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 6.1 — Block list in Inspector

When "Second Page" section is selected in the canvas, Inspector shows:

```
┌─ Second Page ──────────────────────────┐
│ ☑ Announcements                         │
│ ☑ Prayer List        [✎ Edit]          │
│ ☑ Birthdays          [✎ Edit]          │
│ ☑ Officers           [✎ Edit]           │
│   + Add block                           │
└─────────────────────────────────────────┘
```

### 6.2 — Block edit

- Prayer List: textarea, comma-separated names, line breaks for line breaks
- Birthdays: textarea, names with dates
- Officers: opens the elements editor (Officers table)
- Custom block: type a name → choose type (textfile or raw LaTeX)

### 6.3 — Canvas rendering

Each block renders in its designated area of the second page.
Disabled blocks are omitted.

### 6.4 — Data model

`second_page_blocks` table. Global defaults stored as rows with `service_id = NULL`.
Per-service overrides stored with `service_id = :service_id`.

**Deliverable:** commit: `feat(blocks): second page block manager with per-service overrides`

---

## Step 7 — Image Manager

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 7.1 — Media Library dialog

Opened from Settings → Media Library (or Cmd/Ctrl+M):

```
┌─ Media Library ────────────────────────────── [×]
├───────────────────────────────────────────────┤
│  [Upload Image]  (PNG, JPG, SVG, PDF)        │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
│  │ [img] │ │ [img] │ │ [img] │ │ [img] │       │
│  │logo.png│ │cross.png│ │dec.png│ │      │       │
│  └──────┘ └──────┘ └──────┘ └──────┘       │
│                                               │
│  Selected: logo.png  (245 × 120 px)          │
│  [Set as Church Logo]  [Delete]  [Copy URL]  │
└───────────────────────────────────────────────┘
```

### 7.2 — Upload

- File picker or drag-and-drop onto the dialog
- Stores blob in `assets` table with mime type
- Shows thumbnail immediately (using `sharp` for image processing)

### 7.3 — Set as logo

- "Set as Church Logo" button
- Updates `church.logo_blob` and `church.logo_mime`
- Logo appears in template on next canvas render

### 7.4 — Delete

- Confirm dialog: "Delete logo.png? This cannot be undone."
- Remove from `assets` table
- If it was the logo, clear `church.logo_blob`

### 7.5 — Using images in announcements

In the announcements editor, an "Insert Image" button opens the media library
in "picker mode" (click to insert image reference into announcement body).

### 7.6 — `sharp` integration

```bash
npm install sharp
```

Use `sharp` to:
- Generate thumbnails (150×150 max) for the media library grid
- Get image dimensions for display
- Convert HEIC/AVIF to PNG for storage (common phone camera formats)

**Deliverable:** commit: `feat(media): image/asset manager with upload, thumbnails, and logo selection`

---

## Step 8 — Hymnal Manager

**Owner:** Archie  
**Time estimate:** 3–4 hours

### 8.1 — Hymnal Manager dialog

Opened from Settings → Hymnal Manager:

```
┌─ Hymnal Manager ────────────────────────────── [×]
├───────────────────────────────────────────────┤
│  [Search: __________________________] [Import]│
│                                               │
│  Showing 423 hymns  (CSH: 341 · TPH: 182)   │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │ 341  Joyful, Joyful   Henderson         │ │
│  │ 342  For the Beauty of the Earth  Hill  │ │
│  │ P103 The Lord's My Shepherd   Scottish   │ │
│  └─────────────────────────────────────────┘ │
│                                               │
│  [Cancel]                          [Done]    │
└───────────────────────────────────────────────┘
```

### 8.2 — Search / filter

- Real-time filter as you type
- Filter by source: All | CSH | TPH | Baptist | Custom
- Sort by: Number | Title | Tune

### 8.3 — Add/edit hymn

Click any hymn → edit inline in the list, or click "＋ Add Hymn":

```
┌─ Add Hymn ───────────────────────────────────
│  Number:  [________]
│  Title:   [________________________]
│  Tune:    [________________________]
│  Source:  [CSH ▼]
│  Meter:   [________]  (optional)
│
│            [Cancel]  [Save Hymn]
└───────────────────────────────────────────────
```

### 8.4 — CSV/TSV import

Click "Import" → file picker → column mapper dialog:

```
┌─ Import Hymns ────────────────────────────────
│  File: songs.tsv
│  Rows found: 182
│
│  Column mapping:
│  Column 1 → [Number ▼]  [Preview: "341"]
│  Column 2 → [Title ▼]   [Preview: "Joyful, Joyful"]
│  Column 3 → [Tune ▼]   [Preview: "Henderson"]
│  Column 4 → [Skip this column ▼]
│
│  Source: [CSH ▼]
│
│  ☑ Skip duplicates (by number)
│
│            [Cancel]  [Import 182 Hymns]
└───────────────────────────────────────────────
```

### 8.5 — Data model

`hymns` table. On import, INSERT INTO ... ON CONFLICT(code) DO UPDATE
for idempotent imports.

### 8.6 — Hymnary.org import (future flag)

Add a "Download from Hymnary.org" button that prompts for a range of hymn
numbers. Placeholder for now (Phase 3 work), but stub UI so the button exists.

**Deliverable:** commit: `feat(hymnal): hymnal manager with search, add/edit, CSV import`

---

## Step 9 — PDF Generation (Integrate with Canvas)

**Owner:** Archie  
**Time estimate:** 1–2 hours

### 9.1 — Build button flow

Current: Click "Build PDF" → run scripts → show PDF.  
New: Click "Build PDF" → show build progress → reveal PDF in preview pane.

### 9.2 — Render full template to HTML

Same Mustache rendering that powers the canvas, but:
- Output is the complete HTML document (with full styles, not scaled)
- Page breaks via CSS `@page` rules
- Images embedded as `data:` URIs from `assets` table

### 9.3 — Print to PDF

Use the existing `printBulletin()` approach (Electron BrowserWindow + printToPDF).
The HTML file is written to `TEMP_DIR/BULLETIN-<uuid>.html` (not the workspace).

### 9.4 — Booklet imposition

Existing `imposeBooklet()` function — keep it.
Output: `workspace/<date>/book.pdf`

### 9.5 — Build progress

Show a modal progress dialog:
```
┌─ Building Bulletin ────────────────────── [×]
│                                               │
│  Rendering…  ████████████░░░░  65%            │
│  Generating PDF… ████████████████  ✓          │
│  Creating booklet… ████████████████  ✓         │
│                                               │
│            [Cancel]                           │
└───────────────────────────────────────────────┘
```

### 9.6 — Error handling

If PDF generation fails, show the error in the dialog with a
"Capture full error log" button that copies `BULLETIN.log` contents to clipboard.

**Deliverable:** commit: `feat(pdf): integrated PDF build pipeline with progress UI and error handling`

---

## Step 10 — Settings Panel

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 10.1 — Settings dialog (restructure)

```
┌─ Settings ─────────────────────────────────── [×]
├───────────────────────────────────────────────┤
│  Church Identity                             │
│    Name:        [Vernal Presbyterian Church] │
│    Denomination:[A Congregation of the EPC  ] │
│    Tagline:     [__________________________] │
│    Standing:    [*Congregation stands_____] │
│    Logo:        [logo.png] [Change…]         │
│                                              │
│  ─────────────────────────────────────────   │
│  Liturgy Defaults                            │
│    Benediction:  [Numbers 6:24-26 ▼] [🔗]  │
│    Gloria Patri: [#436 — GREATOREX ▼] [🔗]  │
│    Doxology:    [#434 — OLD 100TH ▼] [🔗]   │
│    Departure:   [Shalom to You ▼] [🔗]      │
│                                              │
│  ─────────────────────────────────────────   │
│  Advanced                                    │
│    [Open Workspace Folder]                   │
│    [Export All Data…]                         │
│    [Reset Workspace…]                        │
│                                              │
│              [Cancel]   [Save Settings]       │
└──────────────────────────────────────────────┘
```

### 10.2 — Church identity

- Live preview in canvas header as fields change
- Save → UPDATE `church` table

### 10.3 — Liturgy constants editor

Click the link icon (🔗) next to any liturgy constant → opens a
dialog to change which hymn/text is used. These flow into `liturgy_constants`
and affect all new services.

### 10.4 — Open workspace folder

Opens the workspace directory in the system file manager.

### 10.5 — Export all data

Exports the entire SQLite DB as a `.bulletin-db` file + all assets as a ZIP.

### 10.6 — Reset workspace

Dangerous: shows a confirmation dialog typing the church name to confirm.
Deletes `.bulletin.db` and recreates from scratch (runs migration on existing files).

**Deliverable:** commit: `feat(settings): full settings panel with church identity, liturgy constants, and data management`

---

## Step 11 — Unsaved Changes Guard + Polish

**Owner:** Archie  
**Time estimate:** 2–3 hours

### 11.1 — Unsaved changes guard

Add `beforeunload` handler:
- Track `isDirty` flag in app state
- On window close attempt: show native dialog: "You have unsaved changes. Quit without saving?"
- Also: if dirty and user clicks a service in the sidebar, prompt to save first

### 11.2 — Canvas zoom controls

- Zoom dropdown: 50%, 75%, 100%, Fit
- Persist zoom preference in `localStorage`
- Keyboard: `Cmd/Ctrl++`, `Cmd/Ctrl+-`, `Cmd/Ctrl+0` (reset to Fit)

### 11.3 — Auto-save

- Every meaningful change auto-saves after 500ms debounce
- "Saved" indicator in header fades out after 2s
- No explicit "Save" button needed in the main workflow
- Keep "Save" in File menu for explicit saves (keyboard shortcut)

### 11.4 — Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+S` | Save current state |
| `Cmd/Ctrl+W` | Close window (with dirty check) |
| `Cmd/Ctrl+N` | New service |
| `Cmd/Ctrl+,` | Open settings |
| `Cmd/Ctrl+M` | Open media library |
| `Cmd/Ctrl+Shift+S` | Toggle sidebar |
| `Escape` | Deselect / close dialog |

### 11.5 — Window state persistence

- Remember window size and position across sessions
- Remember sidebar collapsed state
- Remember last open service

### 11.6 — Focus management

- After opening a service, focus the canvas
- After closing a dialog, return focus to the triggering element
- No focus traps that prevent keyboard navigation

### 11.7 — Loading states

- Skeleton UI while service data is loading (not blank screen)
- Spinner on build button while building
- Disabled state on buttons during async operations

**Deliverable:** commit: `feat(polish): unsaved-changes guard, keyboard shortcuts, auto-save, window state`

---

## Step 12 — Phase 1 Integration + Testing

**Owner:** Archie  
**Time estimate:** 3–4 hours

### 12.1 — Full workflow test

Run through the complete secretary workflow:

1. Open app → empty state → Open Workspace → select `~/doc/church/bulletin`
2. Migration notice appears → confirm → workspace loaded
3. Click "+ New Service" → pick next Sunday → Communion off → Template: Classic Half-Sheet → "Start Editing"
4. Canvas appears with empty order → add a hymn → add a scripture reading
5. Switch to Announcements section → add an announcement
6. Click "Build PDF" → PDF appears in preview pane
7. Close app → reopen → service still there
8. Change date → new empty service created
9. Delete old service → gone from sidebar

### 12.2 — Data integrity check

- Verify all data round-trips correctly through SQLite
- Verify imported data matches original loose files
- Verify `.bulletin.db` is the canonical store (loose files in `.bulletin-backup/` untouched)

### 12.3 — Edge cases

- Empty workspace (no existing files) → fresh DB created
- Workspace with partial data → partial migration, no crash
- Duplicate hymn numbers on import → skip with warning count
- Missing logo → template renders without logo
- Very long hymn title → text wraps correctly on canvas
- Unicode in church name, announcements → renders correctly

### 12.4 — Performance

- Service load: < 500ms for workspace with 3 years of data
- Canvas re-render: < 100ms after keystroke
- PDF build: < 10s for a typical bulletin

### 12.5 — Phase 1 feature freeze

After this, no new features — only bug fixes for the remaining Phase 1 work.

**Deliverable:** commit: `chore: Phase 1 complete — secretary E2E workflow functional`

---

## Phase 1 Summary

| Step | Component | Hours |
|---|---|---|
| 1 | Database foundation (SQLite schema + migration) | 2–3 |
| 2 | Service wizard | 3–4 |
| 3 | WYSIWYG canvas | 4–6 |
| 4 | Order editor (section-based) | 4–5 |
| 5 | Announcements editor | 2–3 |
| 6 | Second page blocks | 2–3 |
| 7 | Image manager | 2–3 |
| 8 | Hymnal manager | 3–4 |
| 9 | PDF generation integration | 1–2 |
| 10 | Settings panel | 2–3 |
| 11 | Polish (dirty guard, shortcuts, auto-save) | 2–3 |
| 12 | Integration testing | 3–4 |
| **Total** | | **30–40** |

**Pacing:** ~5 hours/week → **6–8 weeks**

---

*Plan maintained by: Archie 🦜*  
*Last updated: 2026-06-14*
