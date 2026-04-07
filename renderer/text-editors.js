// text-editors.js — Prayer list and birthdays text editors

export class TextEditors {
  constructor(container) {
    this.container = container;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="prayer-section">
        <h3>Prayer List</h3>
        <p class="hint">Comma-separated names. Line breaks are fine.</p>
        <textarea id="prayer-list" class="prayer-textarea" rows="6"
          placeholder="John Smith, Jane Doe,&#10;Bob Johnson…"></textarea>
        <div class="save-row">
          <button class="btn btn-secondary btn-sm" id="btn-save-prayer">Save Prayer List</button>
        </div>
      </div>

      <div class="prayer-section">
        <h3>Birthdays</h3>
        <p class="hint">Names with dates in parentheses, comma-separated.</p>
        <textarea id="birthdays" class="prayer-textarea" rows="5"
          placeholder="John Smith (March 15), Jane Doe (April 3)…"></textarea>
        <div class="save-row">
          <button class="btn btn-secondary btn-sm" id="btn-save-birthdays">Save Birthdays</button>
        </div>
      </div>
    `;

    this.prayerTA   = this.container.querySelector('#prayer-list');
    this.birthdaysTA = this.container.querySelector('#birthdays');

    this.container.querySelector('#btn-save-prayer').addEventListener('click',
      () => this.savePrayer());
    this.container.querySelector('#btn-save-birthdays').addEventListener('click',
      () => this.saveBirthdays());
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Called by app.js once a workspace is open */
  setWorkspace(workspacePath) {
    this.workspacePath = workspacePath;
  }

  async loadAll() {
    if (!this.workspacePath) return;
    const [prayer, birthdays] = await Promise.all([
      window.api.textfile.read(this.workspacePath, 'prayer-list.txt'),
      window.api.textfile.read(this.workspacePath, 'birthdays.txt'),
    ]);
    this.prayerTA.value   = prayer   ?? '';
    this.birthdaysTA.value = birthdays ?? '';
  }

  async savePrayer() {
    if (!this.workspacePath) return;
    await window.api.textfile.write(this.workspacePath, 'prayer-list.txt', this.prayerTA.value);
    this._flash(this.prayerTA);
  }

  async saveBirthdays() {
    if (!this.workspacePath) return;
    await window.api.textfile.write(this.workspacePath, 'birthdays.txt', this.birthdaysTA.value);
    this._flash(this.birthdaysTA);
  }

  _flash(el) {
    el.classList.remove('saved-flash');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('saved-flash');
  }
}
