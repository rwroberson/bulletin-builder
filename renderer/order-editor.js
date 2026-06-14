// order-editor.js — Editable order-of-worship list backed by order.tsv

import { attachDragDrop } from './drag-drop.js';

export class OrderEditor {
  constructor(container, hymnal = [], elementFiles = []) {
    this.container    = container;
    this.hymnal       = hymnal;
    this.elementFiles = elementFiles;
    this.items        = [];
    this._nextId              = 0;
    this._dirty               = false;
    this._communion           = false;
    this.onRefresh            = null; // async () => void
    this.onSave               = null; // async (tsvString) => void
    this.onCommunionChange    = null; // (bool) => void
    this.onGetCommunionTemplate = null; // () => Promise<string>
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="order-toolbar">
        <button class="btn btn-sm" id="order-refresh">↺ Refresh from Schedule</button>
        <div class="order-tb-sep"></div>
        <div class="order-add-wrap">
          <button class="btn btn-sm" id="order-add-trigger">+ Add</button>
          <ul class="order-add-menu hidden" id="order-add-menu">
            <li data-type="hymn">Hymn</li>
            <li data-type="element">Liturgical Element</li>
            <li data-type="heading">Section Heading</li>
            <li data-type="prayer">Prayer</li>
            <li data-type="responsive">Responsive Reading</li>
            <li data-type="raw">Custom LaTeX</li>
          </ul>
        </div>
        <div class="order-tb-sep"></div>
        <label class="order-communion-label" title="Include communion liturgy in this service">
          <input type="checkbox" id="order-communion-check" class="order-communion-check">
          Communion
        </label>
      </div>
      <div id="order-list" class="order-list"></div>
      <div class="order-save-row">
        <span id="order-count" class="order-count"></span>
        <button class="btn btn-secondary" id="order-save">Save Order</button>
      </div>
    `;

    this.listEl  = this.container.querySelector('#order-list');
    this.countEl = this.container.querySelector('#order-count');

    this.container.querySelector('#order-refresh').addEventListener('click', () => this._onRefresh());

    const trigger = this.container.querySelector('#order-add-trigger');
    const menu    = this.container.querySelector('#order-add-menu');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => { this._add(li.dataset.type); menu.classList.add('hidden'); });
    });
    document.addEventListener('click', () => menu.classList.add('hidden'));

    this.container.querySelector('#order-save').addEventListener('click', () => this._onSave());

    const commCheck = this.container.querySelector('#order-communion-check');
    commCheck.addEventListener('change', async () => {
      await this.setCommunion(commCheck.checked);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  load(items) {
    this.items  = (items ?? []).map(item => ({ ...item, _id: this._nextId++ }));
    this._dirty = false;
    this._renderList();
    this._updateCount();
  }

  /** Sync the communion checkbox without touching items (called on service load). */
  setHasCommunion(enabled) {
    this._communion = enabled;
    this._updateCommunionToggle();
  }

  /**
   * Toggle communion on/off, inserting or removing the liturgy section.
   * When enabling: fetches the template via onGetCommunionTemplate and inserts
   * items before "God Commissions Us" (or at end). Does nothing if a communion
   * heading already exists.
   * When disabling: removes everything from the communion heading up to the next
   * heading (prompts the user first).
   */
  async setCommunion(enabled) {
    if (enabled) {
      // Check for an existing communion heading
      const hasCommunion = this.items.some(i =>
        i.type === 'heading' && /communes|communion|supper/i.test(i.title ?? ''),
      );
      if (!hasCommunion) {
        let templateItems = [];
        if (this.onGetCommunionTemplate) {
          const tsv = await this.onGetCommunionTemplate();
          templateItems = parseTSVItems(tsv).map(i => ({ ...i, _communion: true, _id: this._nextId++ }));
        }
        if (templateItems.length > 0) {
          // Insert before "God Commissions" heading, otherwise append
          const commIdx = this.items.findIndex(i =>
            i.type === 'heading' && /commission/i.test(i.title ?? ''),
          );
          if (commIdx !== -1) this.items.splice(commIdx, 0, ...templateItems);
          else this.items.push(...templateItems);
          this._dirty = true;
          this._renderList();
          this._updateCount();
        }
      }
      this._communion = true;
    } else {
      // Find the communion section (heading + following items up to next heading)
      const startIdx = this.items.findIndex(i =>
        i.type === 'heading' && /communes|communion|supper/i.test(i.title ?? ''),
      );
      if (startIdx !== -1) {
        const endIdx = this.items.findIndex((i, idx) => idx > startIdx && i.type === 'heading');
        const count = endIdx === -1 ? this.items.length - startIdx : endIdx - startIdx;
        if (!confirm(`Remove the communion section (${count} item${count !== 1 ? 's' : ''})?`)) {
          this._updateCommunionToggle(); // reset checkbox
          return;
        }
        this.items.splice(startIdx, count);
        this._dirty = true;
        this._renderList();
        this._updateCount();
      }
      this._communion = false;
    }
    this._updateCommunionToggle();
    if (this.onCommunionChange) this.onCommunionChange(this._communion);
  }

  /** Serialize enabled items to TSV for tex-order.sh */
  toTSV() {
    return this.items
      .filter(item => item.enabled !== false)
      .map(item => {
        if (item.type === 'heading') {
          return `HD\t${item.title ?? ''}`;
        }
        if (item.type === 'hymn') {
          // Format ref as "number — Title" when we have the title; else just number.
          // Note column: custom text if provided, otherwise the tune.
          const ref  = item.number
            ? (item.title ? `${item.number} \u2014 ${item.title}` : item.number)
            : '';
          const note = item.custom || item.tune || '';
          return `${item.name ?? ''}\t${ref}\t${note}`;
        }
        if (item.type === 'element') {
          return `${item.name ?? ''}\t${item.ref ?? ''}\t${item.note ?? ''}`;
        }
        if (item.type === 'prayer') {
          if (item.source === 'file' && item.file) return `\\input{elements/${item.file}}`;
          return item.text?.trim() ?? '';
        }
        if (item.type === 'responsive') {
          const lines = [];
          if (item.label) lines.push(`${item.label}\t\t`);
          for (const p of (item.parts ?? [])) {
            if (!p.text.trim()) continue;
            if (p.speaker === 'All') {
              lines.push(`\\responseall{${p.text}}`);
            } else if (p.speaker === 'Unison') {
              lines.push(`\\responseunison{${p.text}}`);
            } else {
              // Minister
              lines.push(`${p.speaker}\t${p.text}\t`);
            }
          }
          return lines.join('\n');
        }
        if (item.type === 'raw') {
          return item.text ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n') + '\n';
  }

  get dirty() { return this._dirty; }

  // ── Private ──────────────────────────────────────────────────────────────

  _updateCommunionToggle() {
    const cb = this.container.querySelector('#order-communion-check');
    if (cb) cb.checked = this._communion;
  }

  _add(type) {
    const defaults = {
      hymn:       { name: 'Hymn', number: '', title: '', tune: '', custom: '' },
      element:    { name: '', ref: '', note: '' },
      heading:    { title: '' },
      prayer:     { source: 'file', file: '', text: '' },
      responsive: { label: '', parts: [{ speaker: 'Minister', text: '' }, { speaker: 'All', text: '' }] },
      raw:        { text: '' },
    };
    this.items.push({ type, enabled: true, _id: this._nextId++, ...defaults[type] });
    this._dirty = true;
    this._renderList();
    this._updateCount();
    setTimeout(() => {
      const cards = this.listEl.querySelectorAll('.order-item');
      cards[cards.length - 1]?.querySelector('input, textarea')?.focus();
    }, 0);
  }

  _renderList() {
    this.listEl.innerHTML = '';
    if (this.items.length === 0) {
      this.listEl.innerHTML = `
        <div class="order-empty">
          No elements yet. Click <strong>↺ Refresh from Schedule</strong> to generate the
          order from your schedule form, or add elements manually.
        </div>`;
      return;
    }
    this.items.forEach((item, idx) => this.listEl.appendChild(this._buildCard(item, idx)));
    // attachDragDrop must survive re-renders — set it up only once
    if (!this._dragBound) {
      this._setupDragDrop();
      this._dragBound = true;
    }
  }

  /** Set up drag-drop on listEl. Called once; survives _renderList rebuilds. */
  _setupDragDrop() {
    attachDragDrop(this.listEl, '.order-item', '.order-drag', (fromIdx, toIdx) => {
      const [moved] = this.items.splice(fromIdx, 1);
      this.items.splice(toIdx, 0, moved);
      this._dirty = true;
      this._renderList();
      this._updateCount();
    });
  }

  _buildCard(item, idx) {
    const card       = document.createElement('div');
    card.dataset.idx = idx;

    // ── Heading: special section-divider layout ───────────────────────────
    if (item.type === 'heading') {
      card.className = 'order-item order-type-heading';
      card.innerHTML = `
        <span class="order-drag" title="Drag to reorder">⠿</span>
        <input type="text" class="order-heading-input"
          value="${esc(item.title)}" placeholder="Section heading…">
        <button class="btn btn-ghost btn-xs order-del" title="Remove">×</button>
      `;
      card.querySelector('.order-heading-input').addEventListener('input', e => {
        item.title  = e.target.value;
        this._dirty = true;
      });
      card.querySelector('.order-del').addEventListener('click', () => {
        this.items.splice(idx, 1);
        this._dirty = true;
        this._renderList();
        this._updateCount();
      });
      return card;
    }

    const disabled   = item.enabled === false;
    card.className   = `order-item order-type-${item.type}${disabled ? ' is-disabled' : ''}`;

    const badgeLabels = { element: 'Element', hymn: 'Hymn', prayer: 'Prayer', responsive: 'Responsive', raw: 'LaTeX' };
    const badgeLabel  = badgeLabels[item.type] ?? item.type;

    let bodyHtml;
    if (item.type === 'hymn') {
      bodyHtml = `
        <input type="text" class="order-field order-name" value="${esc(item.name)}"
          placeholder="Label (e.g. Opening Hymn)">
        <div class="hymn-field order-hymn-lookup">
          <input type="text" class="hymn-input order-hymn-num"
            value="${esc(item.number)}" placeholder="341 · P103 · TPH325"
            autocomplete="off" spellcheck="false">
          <div class="hymn-hint order-hymn-hint"></div>
          <ul class="hymn-dropdown hidden"></ul>
        </div>
        <input type="text" class="order-field order-custom" value="${esc(item.custom)}"
          placeholder="Custom note (optional — overrides tune in the bulletin)">`;

    } else if (item.type === 'element') {
      bodyHtml = `
        <div class="order-element-fields">
          <input type="text" class="order-field order-name"  value="${esc(item.name)}"  placeholder="Element name">
          <input type="text" class="order-field order-ref"   value="${esc(item.ref)}"   placeholder="Scripture ref">
          <input type="text" class="order-field order-note"  value="${esc(item.note)}"  placeholder="Right-side note">
        </div>`;

    } else if (item.type === 'prayer') {
      const fileOpts = this.elementFiles
        .map(f => `<option value="${esc(f)}"${item.file === f ? ' selected' : ''}>${esc(f)}</option>`)
        .join('');
      bodyHtml = `
        <div class="prayer-source-row">
          <label class="prayer-src-label">
            <input type="radio" class="prayer-src-radio" name="prayer-src-${item._id}" value="file"
              ${item.source !== 'custom' ? 'checked' : ''}> From elements file
          </label>
          <label class="prayer-src-label">
            <input type="radio" class="prayer-src-radio" name="prayer-src-${item._id}" value="custom"
              ${item.source === 'custom' ? 'checked' : ''}> Custom LaTeX
          </label>
        </div>
        <div class="prayer-file-row"${item.source === 'custom' ? ' hidden' : ''}>
          <select class="order-field prayer-file-select">
            <option value="">— select a file —</option>
            ${fileOpts}
          </select>
        </div>
        <div class="prayer-custom-row"${item.source !== 'custom' ? ' hidden' : ''}>
          <textarea class="order-field order-raw prayer-text" rows="3">${esc(item.text ?? '')}</textarea>
        </div>`;

    } else if (item.type === 'responsive') {
      const partsHtml = (item.parts ?? []).map((p, pi) => `
        <div class="resp-part" data-part="${pi}" data-speaker="${esc(p.speaker)}">
          <div class="resp-part-header">
            <select class="order-field resp-speaker" data-part="${pi}">
              <option value="Minister"${p.speaker === 'Minister' ? ' selected' : ''}>Minister</option>
              <option value="All"${p.speaker === 'All' ? ' selected' : ''}>All</option>
              <option value="Unison"${p.speaker === 'Unison' ? ' selected' : ''}>Unison</option>
            </select>
            <button class="btn btn-ghost btn-xs resp-del-part" data-part="${pi}" title="Remove part">×</button>
          </div>
          <textarea class="order-field resp-text" rows="2" data-part="${pi}">${esc(p.text)}</textarea>
        </div>`).join('');
      bodyHtml = `
        <input type="text" class="order-field responsive-label" value="${esc(item.label)}"
          placeholder="Label (e.g. Call to Worship)">
        <div class="resp-parts">${partsHtml}</div>
        <button class="btn btn-ghost btn-sm resp-add-part">+ Add Part</button>
        <div class="resp-hints">
          <span class="resp-hint-min">Minister = bold / indented</span>
          <span class="resp-hint-all">All = regular</span>
          <span class="resp-hint-unison">Unison = small-caps, centered</span>
        </div>`;

    } else {
      bodyHtml = `
        <textarea class="order-field order-raw" rows="2">${esc(item.text ?? '')}</textarea>`;
    }

    card.innerHTML = `
      <div class="order-item-gutter">
        <span class="order-drag" title="Drag to reorder">⠿</span>
        <input type="checkbox" class="order-toggle" ${disabled ? '' : 'checked'}
          title="Include in bulletin">
      </div>
      <div class="order-item-body">
        <span class="order-badge order-badge-${item.type}">${badgeLabel}</span>
        ${bodyHtml}
      </div>
      <div class="order-item-actions">
        <button class="btn btn-ghost btn-xs order-del" title="Remove">×</button>
      </div>
    `;

    // ── Sync inputs → item object ─────────────────────────────────────────
    if (item.type === 'hymn') {
      card.querySelector('.order-name').addEventListener('input', e => {
        item.name   = e.target.value;
        this._dirty = true;
      });
      card.querySelector('.order-custom').addEventListener('input', e => {
        item.custom = e.target.value;
        this._dirty = true;
      });
      // Wire hymn number autocomplete
      wireHymnAutocomplete(
        card.querySelector('.order-hymn-num'),
        card.querySelector('.order-hymn-hint'),
        card.querySelector('.hymn-dropdown'),
        this.hymnal,
        (number, title, tune) => {
          item.number = number;
          item.title  = title;
          item.tune   = tune;
          this._dirty = true;
          this._updateCount();
        },
      );

    } else if (item.type === 'element') {
      card.querySelector('.order-name').addEventListener('input', e => { item.name = e.target.value; this._dirty = true; });
      card.querySelector('.order-ref') .addEventListener('input', e => { item.ref  = e.target.value; this._dirty = true; });
      card.querySelector('.order-note').addEventListener('input', e => { item.note = e.target.value; this._dirty = true; });

    } else if (item.type === 'prayer') {
      const fileRow   = card.querySelector('.prayer-file-row');
      const customRow = card.querySelector('.prayer-custom-row');
      card.querySelectorAll('.prayer-src-radio').forEach(radio => {
        radio.addEventListener('change', () => {
          item.source = radio.value;
          this._dirty = true;
          fileRow.hidden   = item.source === 'custom';
          customRow.hidden = item.source !== 'custom';
        });
      });
      card.querySelector('.prayer-file-select').addEventListener('change', e => {
        item.file   = e.target.value;
        this._dirty = true;
      });
      card.querySelector('.prayer-text').addEventListener('input', e => {
        item.text   = e.target.value;
        this._dirty = true;
      });

    } else if (item.type === 'responsive') {
      card.querySelector('.responsive-label').addEventListener('input', e => {
        item.label  = e.target.value;
        this._dirty = true;
      });
      card.querySelectorAll('.resp-speaker').forEach(sel => {
        sel.addEventListener('change', e => {
          const pi = Number(e.target.dataset.part);
          item.parts[pi].speaker = e.target.value;
          this._dirty = true;
          // Update visual preview border
          const partEl = card.querySelector(`.resp-part[data-part="${pi}"]`);
          if (partEl) partEl.dataset.speaker = e.target.value;
        });
      });
      card.querySelectorAll('.resp-text').forEach(ta => {
        ta.addEventListener('input', e => {
          const pi = Number(e.target.dataset.part);
          item.parts[pi].text = e.target.value;
          this._dirty = true;
        });
      });
      card.querySelectorAll('.resp-del-part').forEach(btn => {
        btn.addEventListener('click', () => {
          const pi = Number(btn.dataset.part);
          item.parts.splice(pi, 1);
          this._dirty = true;
          this._renderList();
          this._updateCount();
        });
      });
      card.querySelector('.resp-add-part').addEventListener('click', () => {
        const last = item.parts[item.parts.length - 1];
        // Cycle: Minister → All → Unison → Minister
        const order = ['Minister', 'All', 'Unison'];
        const next  = !last ? 'All'
          : last.speaker === 'Minister' ? 'All'
          : last.speaker === 'All'      ? 'Unison'
          : 'Minister';
        item.parts.push({ speaker: next, text: '' });
        this._dirty = true;
        this._renderList();
        this._updateCount();
      });

    } else {
      card.querySelector('.order-raw').addEventListener('input', e => { item.text = e.target.value; this._dirty = true; });
    }

    // ── Toggle enabled ────────────────────────────────────────────────────
    card.querySelector('.order-toggle').addEventListener('change', e => {
      item.enabled = e.target.checked;
      this._dirty  = true;
      card.classList.toggle('is-disabled', !item.enabled);
      this._updateCount();
    });

    // ── Delete ────────────────────────────────────────────────────────────
    card.querySelector('.order-del').addEventListener('click', () => {
      this.items.splice(idx, 1);
      this._dirty = true;
      this._renderList();
      this._updateCount();
    });

    return card;
  }

  _updateCount() {
    const enabled  = this.items.filter(i => i.enabled !== false);
    const hymns    = enabled.filter(i => i.type === 'hymn').length;
    const elements = enabled.filter(i => i.type === 'element').length;
    const total    = this.items.length;
    if (!total) { this.countEl.textContent = ''; return; }
    const parts = [];
    if (hymns)    parts.push(`${hymns} hymn${hymns    !== 1 ? 's' : ''}`);
    if (elements) parts.push(`${elements} element${elements !== 1 ? 's' : ''}`);
    this.countEl.textContent = parts.join(', ') + ` · ${total} total`;
  }

  async _onRefresh() {
    if (this._dirty && this.items.length > 0) {
      if (!confirm('Regenerate order from the current schedule? Unsaved edits will be lost.')) return;
    }
    if (this.onRefresh) await this.onRefresh();
  }

  async _onSave() {
    if (this.onSave) {
      await this.onSave(this.toTSV());
      this._dirty = false;
    }
  }
}

// ── Hymn autocomplete helper ──────────────────────────────────────────────────

/**
 * Wire up autocomplete behaviour on a hymn number input.
 * Reuses the same hymn-field / hymn-dropdown / hymn-hint DOM that bulletin-form
 * uses, so existing styles apply automatically.
 *
 * @param {HTMLInputElement} input
 * @param {HTMLElement}      hint
 * @param {HTMLElement}      dropdown
 * @param {{ num: string, title: string, tune: string }[]} hymnal
 * @param {(number: string, title: string, tune: string) => void} onChange
 */
function wireHymnAutocomplete(input, hint, dropdown, hymnal, onChange) {
  // Populate hint for any pre-filled value
  if (input.value) {
    const entry = hymnal.find(h => h.num === input.value);
    if (entry) hint.textContent = `${entry.title}  ·  ${entry.tune}`;
  }

  const search = (q) => {
    const u = q.toUpperCase();
    return hymnal.filter(h => h.num.toUpperCase().startsWith(u)).slice(0, 8);
  };

  const showDd = (results) => {
    dropdown.innerHTML = '';
    results.forEach(r => {
      const li = document.createElement('li');
      li.dataset.num = r.num;
      li.innerHTML = `<span class="hymn-num">${r.num}</span>`
                   + `<span class="hymn-title">${r.title}</span>`
                   + `<span class="hymn-tune">${r.tune}</span>`;
      dropdown.appendChild(li);
    });
    dropdown.classList.remove('hidden');
  };

  const closeDd = () => dropdown.classList.add('hidden');

  const select = (num) => {
    const entry = hymnal.find(h => h.num === num);
    input.value         = num;
    hint.textContent    = entry ? `${entry.title}  ·  ${entry.tune}` : '';
    closeDd();
    onChange(num, entry?.title ?? '', entry?.tune ?? '');
  };

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (!val) {
      hint.textContent = '';
      closeDd();
      onChange('', '', '');
      return;
    }
    const results = search(val);
    // Exact match → show hint inline, no dropdown
    if (results.length === 1 && results[0].num.toUpperCase() === val.toUpperCase()) {
      hint.textContent = `${results[0].title}  ·  ${results[0].tune}`;
      closeDd();
      onChange(results[0].num, results[0].title, results[0].tune);
      return;
    }
    if (results.length) showDd(results);
    else { closeDd(); hint.textContent = ''; onChange(val, '', ''); }
  });

  input.addEventListener('keydown', e => {
    const items  = [...dropdown.querySelectorAll('li')];
    const active = dropdown.querySelector('li.active');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      active?.classList.remove('active');
      next?.classList.add('active');
      next?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      active?.classList.remove('active');
      prev?.classList.add('active');
      prev?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      select(active.dataset.num);
    } else if (e.key === 'Escape') {
      closeDd();
    }
  });

  input.addEventListener('blur', () => setTimeout(closeDd, 150));

  dropdown.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); select(li.dataset.num); }
  });
}

function parseTSVItems(content) {
  return (content ?? '').split('\n')
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

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
