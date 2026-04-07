// announcements-editor.js — Structured editor for announcements.txt

import { attachDragDrop } from './drag-drop.js';

export class AnnouncementsEditor {
  constructor(container) {
    this.container = container;
    this.items = [];
    this._nextId = 0;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="ann-toolbar">
        <button class="btn btn-sm" id="ann-add-item">+ Bulletin Item</button>
        <button class="btn btn-sm" id="ann-add-boxc">+ Boxed (centered)</button>
        <button class="btn btn-sm" id="ann-add-boxl">+ Boxed (left-aligned)</button>
      </div>
      <div class="ann-list" id="ann-list"></div>
    `;

    this.listEl = this.container.querySelector('#ann-list');
    this.container.querySelector('#ann-add-item').addEventListener('click', () => this._addItem());
    this.container.querySelector('#ann-add-boxc').addEventListener('click', () => this._addBoxed('announcec'));
    this.container.querySelector('#ann-add-boxl').addEventListener('click', () => this._addBoxed('announcel'));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  load(items) {
    this.items = items.map((item, i) => ({ ...item, _id: i }));
    this._nextId = this.items.length;
    this._renderList();
  }

  collect() {
    return this.items.map(({ _id, ...rest }) => rest);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _addItem() {
    this.items.push({ type: 'item', label: '', body: '', _id: this._nextId++ });
    this._renderList();
    // Focus the new label field
    setTimeout(() => {
      const cards = this.listEl.querySelectorAll('.ann-item');
      const last = cards[cards.length - 1];
      last?.querySelector('input')?.focus();
    }, 0);
  }

  _addBoxed(type) {
    this.items.push({ type, title: '', content: '', _id: this._nextId++ });
    this._renderList();
    setTimeout(() => {
      const cards = this.listEl.querySelectorAll('.ann-item');
      const last = cards[cards.length - 1];
      last?.querySelector('input')?.focus();
    }, 0);
  }

  _renderList() {
    this.listEl.innerHTML = '';
    this.items.forEach((item, idx) => {
      const card = this._buildCard(item, idx);
      this.listEl.appendChild(card);
    });
    attachDragDrop(this.listEl, '.ann-item', '.ann-drag', (fromIdx, toIdx) => {
      const [moved] = this.items.splice(fromIdx, 1);
      this.items.splice(toIdx, 0, moved);
      this._renderList();
    });
  }

  _buildCard(item, idx) {
    const card = document.createElement('div');
    card.className = 'ann-item';
    card.dataset.idx = idx;

    const badgeClass = `ann-type-${item.type}`;
    const badgeLabel = item.type === 'item' ? 'Item'
      : item.type === 'announcec' ? 'Box (centered)'
      : item.type === 'announcel' ? 'Box (left)'
      : 'Raw';

    let fieldsHtml;
    if (item.type === 'item') {
      fieldsHtml = `
        <div class="ann-fields">
          <div class="ann-field">
            <label>Label</label>
            <input type="text" class="ann-label" value="${esc(item.label)}" placeholder="e.g. Deacon Fund">
          </div>
          <div class="ann-field">
            <label>Body</label>
            <textarea class="ann-body" rows="2">${esc(item.body)}</textarea>
          </div>
        </div>`;
    } else if (item.type === 'announcec' || item.type === 'announcel') {
      fieldsHtml = `
        <div class="ann-fields">
          <div class="ann-field">
            <label>Title</label>
            <input type="text" class="ann-title" value="${esc(item.title)}" placeholder="Announcement title">
          </div>
          <div class="ann-field">
            <label>Content</label>
            <textarea class="ann-content" rows="3">${esc(item.content)}</textarea>
          </div>
        </div>`;
    } else {
      fieldsHtml = `
        <div class="ann-fields">
          <div class="ann-field">
            <label>Raw LaTeX</label>
            <textarea class="ann-raw" rows="2" style="font-family:var(--mono);font-size:12px">${esc(item.text ?? '')}</textarea>
          </div>
        </div>`;
    }

    card.innerHTML = `
      <div class="ann-item-header">
        <span class="ann-drag" title="Drag to reorder">⠿</span>
        <span class="ann-type-badge ${badgeClass}">${badgeLabel}</span>
        <div class="ann-item-actions">
          <button class="btn btn-ghost btn-xs ann-del" title="Delete" style="color:var(--error)">×</button>
        </div>
      </div>
      ${fieldsHtml}
    `;

    // ── Live sync back to items array ───────────────────────────────────
    const sync = () => this._syncCard(card, idx);
    card.querySelectorAll('input, textarea').forEach(el => el.addEventListener('input', sync));

    // ── Buttons ─────────────────────────────────────────────────────────
    card.querySelector('.ann-del').addEventListener('click', () => {
      this.items.splice(idx, 1);
      this._renderList();
    });

    return card;
  }

  _syncCard(card, idx) {
    const item = this.items[idx];
    if (!item) return;
    if (item.type === 'item') {
      item.label = card.querySelector('.ann-label')?.value ?? '';
      item.body  = card.querySelector('.ann-body')?.value ?? '';
    } else if (item.type === 'announcec' || item.type === 'announcel') {
      item.title   = card.querySelector('.ann-title')?.value ?? '';
      item.content = card.querySelector('.ann-content')?.value ?? '';
    } else {
      item.text = card.querySelector('.ann-raw')?.value ?? '';
    }
  }

}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
