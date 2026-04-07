// builder.js — Build pipeline UI (log streaming + PDF preview)

export class Builder {
  constructor({ logOutput, buildStatus, pdfFrame, pdfPlaceholder }) {
    this.logOutput    = logOutput;
    this.buildStatus  = buildStatus;
    this.pdfFrame     = pdfFrame;
    this.pdfPlaceholder = pdfPlaceholder;
    this.building     = false;

    window.api.build.onLog(({ line, type }) => this._appendLog(line, type));
    window.api.build.onDone((data)          => this._onDone(data));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Start a build.
   * @param {string} workspacePath
   * @param {string} folder         service folder name
   * @param {string} date           YYYY-MM-DD
   * @param {boolean} communion
   */
  start(workspacePath, folder, date, communion) {
    if (this.building) return;
    this.building = true;
    this._clearLog();
    this._setStatus('Building…', 'running');
    window.api.build.start({ workspacePath, folder, date, communion });
  }

  clearLog() {
    this._clearLog();
    this._setStatus('', '');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _clearLog() {
    this.logOutput.innerHTML = '';
  }

  _setStatus(text, cls) {
    this.buildStatus.textContent = text;
    this.buildStatus.className = 'build-status' + (cls ? ` ${cls}` : '');
  }

  _appendLog(line, type = 'info') {
    // Split multi-line chunks and append each line
    const lines = line.split('\n');
    lines.forEach(l => {
      if (!l && lines.length === 1) return; // skip empty single lines
      const div = document.createElement('div');
      div.className = `log-line ${type}`;
      div.textContent = l;
      this.logOutput.appendChild(div);
    });
    // Auto-scroll to bottom
    this.logOutput.scrollTop = this.logOutput.scrollHeight;
  }

  async _onDone({ success, pdfPath, error }) {
    this.building = false;

    if (success) {
      this._setStatus('Build succeeded', 'success');
      await this._loadPDF(pdfPath);
      // Auto-switch to preview tab
      document.querySelector('[data-rtab="preview"]')?.click();
    } else {
      this._setStatus('Build failed', 'error');
    }
  }

  async _loadPDF(pdfPath) {
    const dataUrl = await window.api.pdf.load(pdfPath);
    if (!dataUrl) return;
    this.pdfFrame.src = dataUrl;
    this.pdfFrame.classList.remove('hidden');
    this.pdfPlaceholder.classList.add('hidden');
  }
}
