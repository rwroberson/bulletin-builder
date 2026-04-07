// bulletin-form.js — Schedule form with hymn autocomplete

// Map from CSV column names → HTML field ids
const COL_MAP = {
  'Season':           'season',
  'Notes':            'notes',
  'Introit':          'introit',
  'Call to Worship':  'call-to-worship',
  'Opening Hymn':     'opening-hymn',
  'Law Reading':      'law-reading',
  'Assurance':        'assurance',
  'Confession Hymn':  'confession-hymn',
  'OT Reading':       'ot-reading',
  'Scripture Hymn':   'scripture-hymn',
  'Sermon Text':      'sermon-text',
  'Closing Hymn':     'closing-hymn',
};

export class BulletinForm {
  constructor(container, hymnal) {
    this.container = container;
    this.hymnal = hymnal;
    this.hymnFields = {};
    this.render();
  }

  render() {
    this.container.innerHTML = '';

    // ── Date / Season / Communion at the top ─────────────────────────────
    // (Date & Communion are in the header; Season and Notes are here)
    this._section('Service Info', `
      <div class="form-row">
        ${this._textField('Season', 'season', 'Advent, Ordinary Time…')}
        ${this._textField('Notes', 'notes', 'Communion, Presbytery, V…')}
      </div>
    `);

    // ── God Calls Us ─────────────────────────────────────────────────────
    this._section('God Calls Us', `
      <div class="form-row">
        ${this._textField('Introit', 'introit', 'Hymn number, text, or element')}
        ${this._textField('Call to Worship', 'call-to-worship', 'Scripture ref or element name')}
      </div>
      <div class="form-row single">
        ${this._hymnField('Opening Hymn', 'opening-hymn')}
      </div>
    `);

    // ── God Cleanses Us ───────────────────────────────────────────────────
    this._section('God Cleanses Us', `
      <div class="form-row">
        ${this._textField('Law Reading', 'law-reading', 'Scripture reference')}
        ${this._textField('Assurance', 'assurance', 'Scripture ref or element')}
      </div>
      <div class="form-row single">
        ${this._hymnField('Confession Hymn', 'confession-hymn')}
      </div>
    `);

    // ── God Consecrates Us ────────────────────────────────────────────────
    this._section('God Consecrates Us', `
      <div class="form-row">
        ${this._textField('OT Reading', 'ot-reading', 'Scripture reference')}
        ${this._textField('Sermon Text', 'sermon-text', 'Scripture reference')}
      </div>
      <div class="form-row single">
        ${this._hymnField('Scripture Hymn', 'scripture-hymn')}
      </div>
    `);

    // ── God Commissions Us ────────────────────────────────────────────────
    this._section('God Commissions Us', `
      <div class="form-row single">
        ${this._hymnField('Closing Hymn', 'closing-hymn')}
      </div>
    `);

    // Wire up hymn autocomplete components
    this._initHymnFields();
  }

  _section(title, html) {
    const sec = document.createElement('div');
    sec.className = 'form-section';
    sec.innerHTML = `<div class="form-section-title">${title}</div>${html}`;
    this.container.appendChild(sec);
  }

  _textField(label, id, placeholder = '') {
    return `
      <div class="field">
        <label for="f-${id}">${label}</label>
        <input type="text" id="f-${id}" data-field="${id}" placeholder="${placeholder}">
      </div>`;
  }

  _hymnField(label, id) {
    return `
      <div class="field">
        <label>${label}</label>
        <div class="hymn-field" data-hymn-field="${id}">
          <input type="text" class="hymn-input" data-field="${id}"
            placeholder="341 · P103 · TPH325" autocomplete="off" spellcheck="false">
          <div class="hymn-hint"></div>
          <ul class="hymn-dropdown hidden"></ul>
        </div>
      </div>`;
  }

  _initHymnFields() {
    const hymnFieldEls = this.container.querySelectorAll('[data-hymn-field]');
    hymnFieldEls.forEach(wrapper => {
      const id = wrapper.dataset.hymnField;
      const input    = wrapper.querySelector('.hymn-input');
      const hint     = wrapper.querySelector('.hymn-hint');
      const dropdown = wrapper.querySelector('.hymn-dropdown');
      const state    = { selected: '' };

      const search = (q) => {
        if (!q) return [];
        const upper = q.toUpperCase();
        return this.hymnal
          .filter(h => h.num.toUpperCase().startsWith(upper))
          .slice(0, 8);
      };

      const showHint = (entry) => {
        hint.textContent = entry ? `${entry.title}  ·  ${entry.tune}` : '';
      };

      const showDropdown = (results) => {
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

      const closeDropdown = () => dropdown.classList.add('hidden');

      const selectEntry = (num) => {
        const entry = this.hymnal.find(h => h.num === num);
        input.value = num;
        state.selected = num;
        showHint(entry || null);
        closeDropdown();
      };

      input.addEventListener('input', () => {
        const val = input.value.trim();
        state.selected = val;
        if (!val) { hint.textContent = ''; closeDropdown(); return; }
        const results = search(val);
        // Exact match — show hint inline, no dropdown needed
        if (results.length === 1 && results[0].num.toUpperCase() === val.toUpperCase()) {
          showHint(results[0]);
          closeDropdown();
          return;
        }
        if (results.length) showDropdown(results);
        else { closeDropdown(); hint.textContent = ''; }
      });

      input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('li');
        const active = dropdown.querySelector('li.active');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = active ? active.nextElementSibling : items[0];
          if (next) { active?.classList.remove('active'); next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = active?.previousElementSibling;
          if (prev) { active.classList.remove('active'); prev.classList.add('active'); prev.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'Enter' && active) {
          e.preventDefault();
          selectEntry(active.dataset.num);
        } else if (e.key === 'Escape') {
          closeDropdown();
        }
      });

      input.addEventListener('blur', () => {
        setTimeout(() => {
          closeDropdown();
          // On blur, if there's exactly one result, auto-fill it
          if (input.value.trim()) {
            const results = search(input.value.trim());
            if (results.length === 1) showHint(results[0]);
          }
        }, 150);
      });

      dropdown.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (li) { e.preventDefault(); selectEntry(li.dataset.num); }
      });

      this.hymnFields[id] = { input, hint, selectEntry };
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Load a CSV row object into the form */
  load(row) {
    if (!row) return;
    for (const [col, fieldId] of Object.entries(COL_MAP)) {
      const val = row[col] ?? '';
      const hymnField = this.hymnFields[fieldId];
      if (hymnField) {
        hymnField.input.value = val;
        if (val) {
          const entry = this.hymnal.find(h => h.num === val.trim());
          hymnField.hint.textContent = entry ? `${entry.title}  ·  ${entry.tune}` : '';
        } else {
          hymnField.hint.textContent = '';
        }
      } else {
        const input = this.container.querySelector(`[data-field="${fieldId}"]`);
        if (input) input.value = val;
      }
    }
  }

  /** Collect form values and return a CSV row object */
  collect(date) {
    const row = { DATE: date };
    for (const [col, fieldId] of Object.entries(COL_MAP)) {
      const hymnField = this.hymnFields[fieldId];
      if (hymnField) {
        row[col] = hymnField.input.value.trim();
      } else {
        const input = this.container.querySelector(`[data-field="${fieldId}"]`);
        row[col] = input ? input.value.trim() : '';
      }
    }
    return row;
  }
}
