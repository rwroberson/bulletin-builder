// elements-editor.js — Editor for files in the elements/ directory

export class ElementsEditor {
  constructor(container) {
    this.container     = container;
    this.workspacePath = null;
    this.files         = [];
    this.selected      = null; // currently open filename
    this.content       = '';
    this.dirty         = false;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="elem-layout">
        <div class="elem-list" id="elem-list"></div>
        <div class="elem-detail" id="elem-detail">
          <div class="elem-detail-empty">Select a file to edit.</div>
        </div>
      </div>
    `;
    this.listEl   = this.container.querySelector('#elem-list');
    this.detailEl = this.container.querySelector('#elem-detail');
  }

  async load(workspacePath) {
    this.workspacePath = workspacePath;
    this.files = await window.api.elements.list(workspacePath);
    this._renderList();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _groups() {
    const map = {};
    for (const f of this.files) {
      const slash = f.indexOf('/');
      const group = slash === -1 ? 'General' : _capitalize(f.slice(0, slash));
      if (!map[group]) map[group] = [];
      map[group].push(f);
    }
    // Always put General first
    const ordered = {};
    if (map['General']) ordered['General'] = map['General'];
    for (const k of Object.keys(map).sort()) {
      if (k !== 'General') ordered[k] = map[k];
    }
    return ordered;
  }

  _renderList() {
    this.listEl.innerHTML = '';
    const groups = this._groups();
    for (const [group, files] of Object.entries(groups)) {
      const hdr = document.createElement('div');
      hdr.className = 'elem-group-header';
      hdr.textContent = group;
      this.listEl.appendChild(hdr);

      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'elem-file-item' + (f === this.selected ? ' is-selected' : '');
        item.textContent = _basename(f);
        item.title = f;
        item.addEventListener('click', () => this._open(f));
        this.listEl.appendChild(item);
      }
    }
  }

  async _open(filename) {
    if (this.dirty && this.selected) {
      if (!confirm(`Save changes to ${_basename(this.selected)} before switching?`)) return;
      await this._save();
    }
    this.selected = filename;
    this.dirty    = false;
    this.content  = await window.api.textfile.read(this.workspacePath, `elements/${filename}`);
    this._renderList();
    this._renderDetail();
  }

  async _save() {
    if (!this.selected) return;
    await window.api.textfile.write(this.workspacePath, `elements/${this.selected}`, this.content);
    this.dirty = false;
    this._renderDetail();
  }

  _renderDetail() {
    if (!this.selected) {
      this.detailEl.innerHTML = '<div class="elem-detail-empty">Select a file to edit.</div>';
      return;
    }
    this.detailEl.innerHTML = `
      <div class="elem-detail-header">
        <span class="elem-detail-filename">${esc(this.selected)}</span>
        <button class="btn btn-primary btn-sm" id="elem-save-btn"${!this.dirty ? ' disabled' : ''}>Save</button>
      </div>
      <textarea class="elem-textarea" id="elem-textarea" spellcheck="false">${esc(this.content)}</textarea>
    `;

    const ta = this.detailEl.querySelector('#elem-textarea');
    ta.addEventListener('input', e => {
      this.content = e.target.value;
      this.dirty   = true;
      this.detailEl.querySelector('#elem-save-btn').disabled = false;
    });

    this.detailEl.querySelector('#elem-save-btn').addEventListener('click', () => this._save());

    // Cmd/Ctrl+S inside the textarea
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); this._save(); }
    });
  }
}

function _capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function _basename(f) { return f.includes('/') ? f.split('/').pop() : f; }

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
