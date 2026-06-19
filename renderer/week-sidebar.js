// week-sidebar.js — Sidebar listing all service folders

export class WeekSidebar {
  constructor(container, onSelect) {
    this.container      = container;
    this.onSelect       = onSelect; // ({ name, date }) => void
    this.services       = [];
    this.currentService = null;
    this._collapsed     = false;
    this.onAdd          = null; // () => void — set by app.js
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="weeks-header">
        <span class="weeks-title">Services</span>
        <div class="weeks-header-btns">
          <button class="btn btn-ghost btn-xs" id="weeks-add-btn" title="New service">+</button>
          <button class="btn btn-ghost btn-xs" id="weeks-collapse-btn" title="Collapse sidebar">‹</button>
        </div>
      </div>
      <div class="weeks-list" id="weeks-list"></div>
    `;

    this.listEl = this.container.querySelector('#weeks-list');

    this.container.querySelector('#weeks-add-btn').addEventListener('click', () => {
      if (this.onAdd) this.onAdd();
    });

    this.container.querySelector('#weeks-collapse-btn').addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      this.container.classList.toggle('is-collapsed', this._collapsed);
      const btn = this.container.querySelector('#weeks-collapse-btn');
      btn.textContent = this._collapsed ? '›' : '‹';
      btn.title = this._collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    });
  }

  async refresh(workspacePath) {
    this.services = await window.api.db.listServices(workspacePath);
    this._renderList();
  }

  setCurrentService(name) {
    this.currentService = name;
    this._renderList();
  }

  updateServiceMeta(name, updates) {
    const svc = this.services.find(s => s.name === name);
    if (svc) Object.assign(svc, updates);
  }

  addServiceIfMissing(service) {
    if (!service?.name || this.services.find(s => s.name === service.name)) return;
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(service.name);
    if (isDate) {
      // Insert in reverse date order among date services
      const idx = this.services.findIndex(s => /^\d{4}-\d{2}-\d{2}$/.test(s.name) && s.name < service.name);
      if (idx === -1) this.services.push(service);
      else this.services.splice(idx, 0, service);
    } else {
      this.services.unshift(service);
    }
    this._renderList();
  }

  _renderList() {
    this.listEl.innerHTML = '';
    if (this.services.length === 0) {
      this.listEl.innerHTML = '<div class="weeks-empty">No services yet.</div>';
      return;
    }
    this.services.forEach(svc => {
      const el = document.createElement('div');
      el.className = 'weeks-item' + (svc.name === this.currentService ? ' is-current' : '');
      el.textContent = svc.name;
      el.title = svc.date ? `${svc.name} (${svc.date})` : svc.name;
      el.addEventListener('click', () => this.onSelect(svc));
      this.listEl.appendChild(el);
    });
  }
}
