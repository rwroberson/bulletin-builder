// app.js — Main renderer entry point

import { OrderEditor }         from './order-editor.js';
import { AnnouncementsEditor } from './announcements-editor.js';
import { Builder }             from './builder.js';
import { WeekSidebar }         from './week-sidebar.js';
import { ElementsEditor }      from './elements-editor.js';

// ── State ────────────────────────────────────────────────────────────────────

let workspacePath    = null;
let currentCommunion = false;
let hymnal           = [];
let elementFiles     = [];
let orderEditor      = null;
let annEditor        = null;
let builder          = null;
let weekSidebar      = null;
let elementsEditor   = null;
let currentFolder    = null;   // service folder name (may differ from date)
let globalConfig     = {};     // cached bulletin-config.json
let blocksMode       = 'global'; // 'global' | 'service'
let activeBlockId    = null;   // currently selected block id in the Second Page tab
let blockContentMap  = {};     // blockId → string content (for textfile/element blocks)

// ── DOM refs ─────────────────────────────────────────────────────────────────

const emptyState      = document.getElementById('empty-state');
const mainUI          = document.getElementById('main-ui');
const mainLayout      = document.getElementById('main-layout');
const elementsView    = document.getElementById('elements-view');
const workspacePathEl = document.getElementById('workspace-path');
const dateInput       = document.getElementById('bulletin-date');
const btnBuild        = document.getElementById('btn-build');
const btnSave         = document.getElementById('btn-save');
const btnOpenWs       = document.getElementById('btn-open-workspace');
const btnChangeWs     = document.getElementById('btn-change-workspace');
const btnLibrary      = document.getElementById('btn-library');
const btnSettings     = document.getElementById('btn-settings');
const btnClearLog     = document.getElementById('btn-clear-log');
const logOutput       = document.getElementById('log-output');
const buildStatus     = document.getElementById('build-status');
const pdfFrame        = document.getElementById('pdf-frame');
const pdfPlaceholder  = document.getElementById('pdf-placeholder');
const serviceDialog   = document.getElementById('service-dialog');
const settingsDialog  = document.getElementById('settings-dialog');

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextSunday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay();
  const add = day === 0 ? 7 : 7 - day;
  d.setDate(d.getDate() + add);
  return d.toISOString().split('T')[0];
}

function setDate(dateStr) { dateInput.value = dateStr || ''; }
function getDate() { return dateInput.value; }

// ── Workspace init ────────────────────────────────────────────────────────────

async function openWorkspace(path) {
  workspacePath = path;
  workspacePathEl.textContent = path;

  [hymnal, elementFiles] = await Promise.all([
    window.api.hymnal.load(path),
    window.api.elements.list(path),
  ]);

  globalConfig = (await window.api.config.read(path)) ?? {};

  orderEditor = new OrderEditor(document.getElementById('tab-order'), hymnal, elementFiles);
  orderEditor.onRefresh = async () => {
    try {
      const items = await window.api.order.generate(path, getDate(), currentCommunion);
      orderEditor.load(items);
    } catch (err) {
      alert(`Failed to generate order: ${err.message}`);
    }
  };
  orderEditor.onSave = async (tsv) => {
    if (currentFolder) await window.api.order.save(path, currentFolder, tsv);
  };
  orderEditor.onCommunionChange = async (enabled) => {
    currentCommunion = enabled;
    if (currentFolder) {
      await window.api.workspace.setServiceMeta(workspacePath, currentFolder, { communion: enabled });
      weekSidebar?.updateServiceMeta(currentFolder, { communion: enabled });
    }
  };
  orderEditor.onGetCommunionTemplate = () =>
    window.api.communion.getTemplate(workspacePath);

  annEditor = new AnnouncementsEditor(document.getElementById('ann-editor-container'));

  builder = new Builder({ logOutput, buildStatus, pdfFrame, pdfPlaceholder });

  // Elements editor (in the Library view)
  elementsEditor = new ElementsEditor(document.getElementById('elements-container'));
  await elementsEditor.load(path);

  // Week sidebar
  weekSidebar = new WeekSidebar(document.getElementById('panel-weeks'), async (svc) => {
    setDate(svc.date || svc.name);
    weekSidebar.setCurrentService(svc.name);
    await loadService(svc.name, svc.date || svc.name);
  });
  weekSidebar.onAdd = () => showServiceDialog();
  await weekSidebar.refresh(path);
  weekSidebar.setCurrentService(currentFolder);

  await loadService(currentFolder || getDate(), getDate());

  emptyState.classList.add('hidden');
  mainUI.classList.remove('hidden');

  // First-run wizard: show if no bulletin-config.json exists yet
  if (!Object.keys(globalConfig).length) {
    showChurchSetupDialog();
  }
}

async function loadService(folder, date) {
  if (!workspacePath || !folder) return;
  currentFolder = folder;

  const [annItems, orderItems, svcConfig] = await Promise.all([
    window.api.announcements.read(workspacePath, folder),
    window.api.order.load(workspacePath, folder),
    window.api.config.readService(workspacePath, folder),
  ]);

  annEditor?.load(annItems ?? []);
  orderEditor?.load(orderItems ?? []);

  // Determine communion state from meta.json
  const svcMeta = weekSidebar?.services?.find(s => s.name === folder);
  currentCommunion = !!(svcMeta?.communion);
  orderEditor?.setHasCommunion(currentCommunion);

  weekSidebar?.addServiceIfMissing({ name: folder, date: date || folder });
  weekSidebar?.setCurrentService(folder);

  // Load block list for this service
  const hasServiceBlocks = svcConfig?.secondPageBlocks != null;
  blocksMode = hasServiceBlocks ? 'service' : 'global';
  const effectiveBlocks = hasServiceBlocks
    ? svcConfig.secondPageBlocks
    : (globalConfig.secondPageBlocks ?? DEFAULT_SECOND_PAGE_BLOCKS);

  // Reset content cache for the new service
  blockContentMap = {};
  activeBlockId = null;
  showBlockEditor(null);

  renderBlocksList(effectiveBlocks, annBlocksContainer);
  updateBlocksModeBadge();

  // Auto-select the first block
  const firstBlock = effectiveBlocks[0];
  if (firstBlock) await selectBlock(firstBlock.id, effectiveBlocks);
}

async function saveAll() {
  if (!workspacePath || !currentFolder) return;

  // Flush active text editor into the cache before saving
  flushActiveTextEditor();

  const blocks = collectBlocks(annBlocksContainer);
  const saves = [
    window.api.announcements.write(workspacePath, currentFolder, annEditor.collect()),
  ];
  if (orderEditor?.dirty) {
    saves.push(window.api.order.save(workspacePath, currentFolder, orderEditor.toTSV()));
  }

  // Save block content cache
  for (const [blockId, content] of Object.entries(blockContentMap)) {
    const block = blocks.find(b => b.id === blockId);
    if (!block || block.type === 'announcements') continue;
    const relPath = block.scope === 'service'
      ? `${currentFolder}/${block.file}`
      : block.file;
    saves.push(window.api.textfile.write(workspacePath, relPath, content));
  }

  // Save block list config
  if (blocksMode === 'service') {
    saves.push(window.api.config.writeService(workspacePath, currentFolder, { secondPageBlocks: blocks }));
  } else {
    globalConfig = { ...globalConfig, secondPageBlocks: blocks };
    saves.push(window.api.config.write(workspacePath, globalConfig));
  }
  await Promise.all(saves);

  btnSave.textContent = 'Saved';
  btnSave.style.color = 'var(--success)';
  setTimeout(() => { btnSave.textContent = 'Save'; btnSave.style.color = ''; }, 1200);
}

// ── Service wizard (multi-step) ──────────────────────────────────────────────

/**
 * Two-step wizard:
 *   Step 1 — Date & Type (date, communion toggle)
 *   Step 2 — Template picker (Classic Half-Sheet only for now)
 */

let _wiz = { step: 1, date: '', communion: false };

function showServiceDialog() {
  _wiz = { step: 1, date: nextSunday(), communion: false };
  _renderWizardStep1();
  serviceDialog.classList.remove('hidden');
}

function hideServiceDialog() {
  serviceDialog.classList.add('hidden');
  document.getElementById('svc-dialog-box').classList.remove('wide');
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

function _renderWizardStep1() {
  const header = document.getElementById('svc-dialog-header');
  const body   = document.getElementById('svc-dialog-body');
  const actions = document.getElementById('svc-dialog-actions');

  header.textContent = 'New Service';
  document.getElementById('svc-dialog-box').classList.remove('wide');
  body.innerHTML = `
    <div class="dialog-field">
      <label for="wiz-date">Date</label>
      <input type="date" id="wiz-date" value="${_wiz.date}" autocomplete="off">
    </div>
    <div class="dialog-field-check">
      <label class="dialog-check-label">
        <input type="checkbox" id="wiz-communion"${_wiz.communion ? ' checked' : ''}>
        Communion this service
      </label>
    </div>
    <div class="dialog-field" style="margin-top:4px">
      <label for="wiz-name">Service name <span class="dialog-hint">(optional — defaults to date)</span></label>
      <input type="text" id="wiz-name" placeholder="e.g. Good Friday" autocomplete="off">
    </div>
  `;
  actions.innerHTML = `
    <button class="btn" id="wiz-cancel">Cancel</button>
    <button class="btn btn-primary" id="wiz-next">Next →</button>
  `;

  document.getElementById('wiz-cancel').addEventListener('click', hideServiceDialog);
  document.getElementById('wiz-next').addEventListener('click', () => {
    _wiz.date      = document.getElementById('wiz-date').value;
    _wiz.communion = document.getElementById('wiz-communion').checked;
    _wiz.name      = document.getElementById('wiz-name').value.trim();
    if (!_wiz.date) {
      document.getElementById('wiz-date').focus();
      return;
    }
    _renderWizardStep2();
  });
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

function _renderWizardStep2() {
  const header  = document.getElementById('svc-dialog-header');
  const body   = document.getElementById('svc-dialog-body');
  const actions = document.getElementById('svc-dialog-actions');

  header.textContent = 'Choose Template';
  document.getElementById('svc-dialog-box').classList.add('wide');
  body.innerHTML = `
    <p style="font-size:13px;color:var(--text-2);margin:0 0 12px">
      Select a bulletin template for this service.
    </p>
    <div class="wiz-templates">
      <div class="wiz-template wiz-template-active" id="wiz-tmpl-classic">
        <div class="wiz-template-preview wiz-template-preview--classic">
          <div class="tp-church">Vernal Presbyterian</div>
          <div class="tp-rule"></div>
          <div class="tp-section">God Calls Us</div>
          <div class="tp-line"></div>
          <div class="tp-line tp-line--short"></div>
          <div class="tp-section">God Cleanses Us</div>
          <div class="tp-line"></div>
          <div class="tp-section">Announcements</div>
        </div>
        <div class="wiz-template-name">Classic Half-Sheet</div>
        <div class="wiz-template-check">✓</div>
      </div>
      <div class="wiz-template wiz-template-locked" id="wiz-tmpl-letter">
        <div class="wiz-template-preview">
          <div style="color:var(--text-3);font-size:11px;padding-top:20px">Coming soon</div>
        </div>
        <div class="wiz-template-name">Letter Full-Page</div>
        <div class="wiz-template-check">🔒</div>
      </div>
    </div>
  `;
  actions.innerHTML = `
    <button class="btn" id="wiz-back">← Back</button>
    <button class="btn btn-primary" id="wiz-create">Start Editing</button>
  `;

  document.getElementById('wiz-back').addEventListener('click', _renderWizardStep1);
  document.getElementById('wiz-create').addEventListener('click', _wizardCreate);
}

async function _wizardCreate() {
  hideServiceDialog();
  const result = await window.api.db.createService(workspacePath, {
    date:         _wiz.date,
    templateSlug: 'classic-half-sheet',
    communion:    _wiz.communion,
    season:       'Ordinary Time',
  });
  if (!result?.ok) {
    alert('Failed to create service: ' + (result?.error ?? 'unknown error'));
    return;
  }
  // Refresh the sidebar from DB
  await weekSidebar?.refresh(workspacePath);
  weekSidebar?.setCurrentService(_wiz.date);
  await loadService(_wiz.date, _wiz.date);
  if (_wiz.communion && orderEditor) {
    await orderEditor.setCommunion(true);
  }
}

serviceDialog.addEventListener('click', e => { if (e.target === serviceDialog) hideServiceDialog(); });


// ── Second-page block list ────────────────────────────────────────────────────

const DEFAULT_SECOND_PAGE_BLOCKS = [
  { id: 'announcements', type: 'announcements', label: 'Announcements',  enabled: true },
  { id: 'prayer-list',   type: 'textfile',      label: 'Prayer List',    file: 'prayer-list.txt',       scope: 'workspace', enabled: true },
  { id: 'birthdays',     type: 'textfile',      label: 'Birthdays',      file: 'birthdays.txt',         scope: 'workspace', enabled: true },
  { id: 'officers',      type: 'element',       label: 'Officers',       file: 'elements/officers.txt', scope: 'workspace', enabled: true },
];

function renderBlocksList(blocks, container) {
  container.innerHTML = '';
  blocks.forEach((block, idx) => {
    const isBuiltin = block.id === 'announcements' || block.id === 'prayer-list' ||
                      block.id === 'birthdays' || block.id === 'officers';
    const row = document.createElement('div');
    row.className = 'block-row';
    if (block.id === activeBlockId) row.classList.add('block-row-active');
    row.dataset.id = block.id;

    // Clicking the row selects it for editing
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      selectBlock(block.id, collectBlocks(container));
    });

    const moveCol = document.createElement('div');
    moveCol.className = 'block-row-move';

    const upBtn = document.createElement('button');
    upBtn.className = 'block-move-btn btn btn-ghost btn-xs';
    upBtn.textContent = '↑';
    upBtn.disabled = idx === 0;
    upBtn.title = 'Move up';
    upBtn.addEventListener('click', () => {
      flushActiveTextEditor();
      const current = collectBlocks(container);
      const i = current.findIndex(b => b.id === block.id);
      if (i > 0) { [current[i - 1], current[i]] = [current[i], current[i - 1]]; }
      renderBlocksList(current, container);
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'block-move-btn btn btn-ghost btn-xs';
    downBtn.textContent = '↓';
    downBtn.disabled = idx === blocks.length - 1;
    downBtn.title = 'Move down';
    downBtn.addEventListener('click', () => {
      flushActiveTextEditor();
      const current = collectBlocks(container);
      const i = current.findIndex(b => b.id === block.id);
      if (i < current.length - 1) { [current[i], current[i + 1]] = [current[i + 1], current[i]]; }
      renderBlocksList(current, container);
    });

    moveCol.append(upBtn, downBtn);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'block-enabled-check';
    checkbox.checked = block.enabled;
    checkbox.title = 'Include in bulletin';
    checkbox.addEventListener('click', e => e.stopPropagation());

    const labelEl = document.createElement(isBuiltin ? 'span' : 'input');
    if (isBuiltin) {
      labelEl.className = 'block-label-static';
      labelEl.textContent = block.label ?? '';
    } else {
      labelEl.type = 'text';
      labelEl.className = 'block-label-input';
      labelEl.value = block.label ?? '';
      labelEl.placeholder = 'Section name';
      labelEl.addEventListener('click', e => e.stopPropagation());
    }

    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'block-scope-select';
    [['workspace', 'Every week'], ['service', 'This week']].forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = text;
      if (block.scope === val) opt.selected = true;
      scopeSelect.appendChild(opt);
    });
    if (isBuiltin) { scopeSelect.style.display = 'none'; }
    scopeSelect.addEventListener('click', e => e.stopPropagation());

    const delBtn = document.createElement('button');
    delBtn.className = 'block-delete-btn btn btn-ghost btn-xs';
    delBtn.textContent = '×';
    delBtn.title = 'Remove section';
    if (isBuiltin) { delBtn.style.visibility = 'hidden'; }
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = collectBlocks(container);
      const remaining = current.filter(b => b.id !== block.id);
      delete blockContentMap[block.id];
      if (activeBlockId === block.id) { showBlockEditor(null); activeBlockId = null; }
      renderBlocksList(remaining, container);
    });

    row.append(moveCol, checkbox, labelEl, scopeSelect, delBtn);
    container.appendChild(row);
  });
}

function collectBlocks(container) {
  return Array.from(container.querySelectorAll('.block-row')).map(row => {
    const id = row.dataset.id;
    const labelEl = row.querySelector('.block-label-input, .block-label-static');
    const label = labelEl instanceof HTMLInputElement ? labelEl.value.trim() : (labelEl?.textContent ?? '');
    const scope   = row.querySelector('.block-scope-select')?.value ?? 'workspace';
    const enabled = row.querySelector('.block-enabled-check').checked;
    const def = DEFAULT_SECOND_PAGE_BLOCKS.find(b => b.id === id);
    const type  = def ? def.type  : 'textfile';
    const file  = def ? def.file  : `${id}.txt`;
    const block = { id, type, label, enabled };
    if (type !== 'announcements') { block.file = file; block.scope = scope; }
    return block;
  });
}

// ── Block content editor ──────────────────────────────────────────────────────

const annEditorContainer = document.getElementById('ann-editor-container');
const blockTextEditor    = document.getElementById('block-text-editor');
const blockNoSelection   = document.getElementById('block-no-selection');

function showBlockEditor(type) {
  annEditorContainer.classList.toggle('hidden', type !== 'announcements');
  blockTextEditor.classList.toggle('hidden', type !== 'textfile' && type !== 'element');
  blockNoSelection.classList.toggle('hidden', type !== null);
}

function flushActiveTextEditor() {
  if (activeBlockId && blockTextEditor && !blockTextEditor.classList.contains('hidden')) {
    blockContentMap[activeBlockId] = blockTextEditor.value;
  }
}

async function selectBlock(blockId, blocks) {
  // Flush current editor before switching
  flushActiveTextEditor();

  // Highlight selected row
  annBlocksContainer.querySelectorAll('.block-row').forEach(r => {
    r.classList.toggle('block-row-active', r.dataset.id === blockId);
  });

  const block = (blocks ?? collectBlocks(annBlocksContainer)).find(b => b.id === blockId);
  if (!block) { showBlockEditor(null); activeBlockId = null; return; }
  activeBlockId = blockId;

  if (block.type === 'announcements') {
    showBlockEditor('announcements');
    return;
  }

  // Load content if not cached
  if (!(blockId in blockContentMap)) {
    const relPath = block.scope === 'service'
      ? `${currentFolder}/${block.file}`
      : block.file;
    blockContentMap[blockId] = await window.api.textfile.read(workspacePath, relPath) ?? '';
  }

  blockTextEditor.value = blockContentMap[blockId];
  showBlockEditor(block.type);
}

// ── Block list toggle (global ↔ service) ──────────────────────────────────────

const annBlocksContainer = document.getElementById('ann-blocks-list');
const annBlocksToggleBtn = document.getElementById('ann-blocks-toggle');
const annBlocksModeBadge = document.getElementById('ann-blocks-mode-badge');
const annAddBlockBtn     = document.getElementById('ann-add-block');

function updateBlocksModeBadge() {
  if (blocksMode === 'service') {
    annBlocksModeBadge.textContent = 'Custom for this service';
    annBlocksModeBadge.className = 'blocks-mode-badge blocks-mode-service';
    annBlocksToggleBtn.textContent = 'Reset to global default';
  } else {
    annBlocksModeBadge.textContent = 'Global default';
    annBlocksModeBadge.className = 'blocks-mode-badge blocks-mode-global';
    annBlocksToggleBtn.textContent = 'Customize for this service';
  }
}

annBlocksToggleBtn.addEventListener('click', async () => {
  if (!currentFolder) return;
  if (blocksMode === 'global') {
    // Copy global blocks as a service-specific starting point
    blocksMode = 'service';
    // blocks list already shows the right content — just update UI
  } else {
    // Revert to global: delete service config and reload global blocks
    blocksMode = 'global';
    await window.api.config.writeService(workspacePath, currentFolder, null);
    renderBlocksList(globalConfig.secondPageBlocks ?? DEFAULT_SECOND_PAGE_BLOCKS, annBlocksContainer);
  }
  updateBlocksModeBadge();
});

annAddBlockBtn.addEventListener('click', () => {
  flushActiveTextEditor();
  const id = `custom-${Date.now()}`;
  const current = collectBlocks(annBlocksContainer);
  current.push({ id, type: 'textfile', label: 'New Section', file: `${id}.txt`, scope: 'service', enabled: true });
  blockContentMap[id] = '';
  renderBlocksList(current, annBlocksContainer);
  const rows = annBlocksContainer.querySelectorAll('.block-row');
  const newRow = rows[rows.length - 1];
  newRow?.querySelector('.block-label-input')?.select();
  selectBlock(id, current);
});

// ── Church config helpers ─────────────────────────────────────────────────────

function configFromFields(prefix) {
  return {
    churchName:      document.getElementById(`${prefix}-church-name`).value.trim(),
    denominationLine: document.getElementById(`${prefix}-denomination`).value.trim(),
    serviceTitle:    document.getElementById(`${prefix}-service-title`).value.trim(),
    standingNote:    document.getElementById(`${prefix}-standing-note`).value.trim(),
    logoFile:        document.getElementById(`${prefix}-logo`).value.trim(),
  };
}

function populateConfigFields(prefix, config) {
  document.getElementById(`${prefix}-church-name`).value    = config?.churchName      ?? '';
  document.getElementById(`${prefix}-denomination`).value   = config?.denominationLine ?? '';
  document.getElementById(`${prefix}-service-title`).value  = config?.serviceTitle    ?? '';
  document.getElementById(`${prefix}-standing-note`).value  = config?.standingNote    ?? '';
  document.getElementById(`${prefix}-logo`).value           = config?.logoFile        ?? '';
}

// ── Settings dialog ───────────────────────────────────────────────────────────

btnSettings.addEventListener('click', async () => {
  if (!workspacePath) return;
  const [tsv] = await Promise.all([
    window.api.communion.getTemplate(workspacePath),
  ]);
  document.getElementById('settings-communion-tsv').value = tsv;
  populateConfigFields('cfg', globalConfig);
  settingsDialog.classList.remove('hidden');
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  settingsDialog.classList.add('hidden');
});
settingsDialog.addEventListener('click', e => {
  if (e.target === settingsDialog) settingsDialog.classList.add('hidden');
});
document.getElementById('settings-save').addEventListener('click', async () => {
  const tsv    = document.getElementById('settings-communion-tsv').value;
  const config = { ...globalConfig, ...configFromFields('cfg') };
  // Preserve secondPageBlocks — edited in the Announcements tab, not here
  if (globalConfig.secondPageBlocks) config.secondPageBlocks = globalConfig.secondPageBlocks;
  globalConfig = config;
  await Promise.all([
    window.api.communion.saveTemplate(workspacePath, tsv),
    window.api.config.write(workspacePath, config),
  ]);
  settingsDialog.classList.add('hidden');
});

// ── Church setup wizard ───────────────────────────────────────────────────────

const churchSetupDialog = document.getElementById('church-setup-dialog');

function showChurchSetupDialog() {
  populateConfigFields('setup', {});
  churchSetupDialog.classList.remove('hidden');
  setTimeout(() => document.getElementById('setup-church-name').focus(), 50);
}

document.getElementById('setup-skip').addEventListener('click', () => {
  churchSetupDialog.classList.add('hidden');
});

document.getElementById('setup-save').addEventListener('click', async () => {
  const config = configFromFields('setup');
  await window.api.config.write(workspacePath, config);
  churchSetupDialog.classList.add('hidden');
});

// ── Library toggle ────────────────────────────────────────────────────────────

btnLibrary.addEventListener('click', () => {
  const libraryOpen = !elementsView.classList.contains('hidden');
  elementsView.classList.toggle('hidden', libraryOpen);
  mainLayout.classList.toggle('hidden', !libraryOpen);
  btnLibrary.classList.toggle('active', !libraryOpen);
  btnLibrary.textContent = libraryOpen ? 'Library' : '← Bulletin';
});

// ── Tab routing ───────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  document.querySelectorAll('.rtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rtab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.rtab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`rtab-${btn.dataset.rtab}`)?.classList.remove('hidden');
    });
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

btnOpenWs.addEventListener('click', async () => {
  const path = await window.api.workspace.open();
  if (path) await openWorkspace(path);
});

btnChangeWs.addEventListener('click', async () => {
  const path = await window.api.workspace.open();
  if (path) await openWorkspace(path);
});

btnSave.addEventListener('click', saveAll);

btnBuild.addEventListener('click', async () => {
  if (!workspacePath || !currentFolder) return;
  await saveAll();
  const date = getDate();
  if (!date) { alert('Please select a date first.'); return; }
  document.querySelector('[data-rtab="log"]')?.click();
  builder.start(workspacePath, currentFolder, date, currentCommunion);
});

btnClearLog.addEventListener('click', () => builder?.clearLog());

dateInput.addEventListener('change', async () => {
  const d = getDate();
  currentFolder = d;
  weekSidebar?.setCurrentService(d);
  await loadService(d, d);
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveAll(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  initTabs();
  // Ensure the Order tab is active on load (HTML defaults to it now)
  document.querySelector('[data-tab="order"]')?.click();
  setDate(nextSunday());

  const saved = await window.api.workspace.get();
  if (saved) await openWorkspace(saved);
}

init().catch(console.error);
