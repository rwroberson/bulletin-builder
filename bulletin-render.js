'use strict';

const fs   = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-implemented from main.js to keep this module independent.
function extractBracedArg(str, start) {
  if (str[start] !== '{') return null;
  let depth = 0;
  let content = '';
  for (let i = start + 1; i < str.length; i++) {
    if (str[i] === '\\') {
      content += str[i] + (str[i + 1] ?? '');
      i++;
    } else if (str[i] === '{') {
      depth++; content += '{';
    } else if (str[i] === '}') {
      if (depth === 0) return { content, end: i };
      depth--; content += '}';
    } else {
      content += str[i];
    }
  }
  return null;
}

// ── Inline LaTeX → HTML ───────────────────────────────────────────────────────
// Handles the subset of inline LaTeX used in bulletin elements files.

function inlineToHtml(text) {
  if (!text) return '';
  let result = '';
  let i = 0;
  const s = String(text);

  while (i < s.length) {
    const ch = s[i];

    // Brace groups: {\small text}, {\bf text}, or plain {text}
    if (ch === '{') {
      const arg = extractBracedArg(s, i);
      if (arg) {
        const inner = arg.content;
        // Switch command at start of group (e.g. {\small text})
        const sw = inner.match(/^\\(small|footnotesize|scriptsize|bf|it|em|large|Large|normalsize|centering)\s*/);
        if (sw) {
          const body = inlineToHtml(inner.slice(sw[0].length));
          if (sw[1] === 'small' || sw[1] === 'footnotesize' || sw[1] === 'scriptsize') {
            result += `<span class="small-text">${body}</span>`;
          } else if (sw[1] === 'bf') {
            result += `<strong>${body}</strong>`;
          } else if (sw[1] === 'it' || sw[1] === 'em') {
            result += `<em>${body}</em>`;
          } else {
            result += body;
          }
        } else {
          result += inlineToHtml(inner);
        }
        i = arg.end + 1;
        continue;
      }
      // Unmatched { — output literally
      result += esc(ch);
      i++;
      continue;
    }

    // LaTeX commands
    if (ch === '\\') {
      // Double backslash → line break
      if (s[i + 1] === '\\') {
        result += '<br>';
        i += 2;
        continue;
      }

      // Match command name
      const cmdMatch = s.slice(i).match(/^\\([a-zA-Z]+\*?)/);
      if (!cmdMatch) {
        // Escaped special char like \{, \}, \%, \&, \#, \$, \_, \^, \~
        const special = s[i + 1];
        if (special && '{}'.includes(special)) { result += esc(special); i += 2; }
        else if (special === '%') { i += 2; } // LaTeX comment char
        else if (special === '&') { result += '&amp;'; i += 2; }
        else if (special === '#' || special === '$' || special === '_') { result += esc(special); i += 2; }
        else if (special === '^') { result += '†'; i += 2; }
        else if (special === '~') { result += '~'; i += 2; }
        else { result += esc(ch); i++; }
        continue;
      }

      const cmd = cmdMatch[1];
      const afterCmd = i + 1 + cmd.length; // position after the command name

      // Commands that take one braced argument
      const ONE_ARG_CMDS = {
        textbf: (x) => `<strong>${x}</strong>`,
        textit: (x) => `<em>${x}</em>`,
        emph:   (x) => `<em>${x}</em>`,
        textsc: (x) => `<span style="font-variant:small-caps">${x}</span>`,
        textsuperscript: (x) => `<sup>${x}</sup>`,
        textsubscript:   (x) => `<sub>${x}</sub>`,
        textrm: (x) => x,
        texttt: (x) => `<code>${x}</code>`,
        underline: (x) => `<u>${x}</u>`,
      };

      if (ONE_ARG_CMDS[cmd] && s[afterCmd] === '{') {
        const arg = extractBracedArg(s, afterCmd);
        if (arg) {
          result += ONE_ARG_CMDS[cmd](inlineToHtml(arg.content));
          i = arg.end + 1;
          continue;
        }
      }

      // Commands that take one argument but are SKIPPED (whitespace/layout)
      if (['hspace', 'hspace*', 'vspace', 'vspace*', 'kern'].includes(cmd) && s[afterCmd] === '{') {
        const arg = extractBracedArg(s, afterCmd);
        if (arg) { i = arg.end + 1; continue; }
      }

      // Skip to end of line (parameter-less layout commands)
      if (['hangindent', 'hangafter'].includes(cmd)) {
        const end = s.indexOf('\n', i);
        i = end === -1 ? s.length : end + 1;
        continue;
      }

      // No-op commands (skip the command name only)
      if (['noindent', 'par', 'centering', 'raggedright', 'raggedleft',
           'null', 'relax', 'normalfont', 'rmfamily', 'sffamily', 'ttfamily',
           'small', 'footnotesize', 'scriptsize', 'large', 'Large', 'LARGE',
           'bf', 'it', 'em', 'rm', 'sf', 'tt', 'bfseries', 'itshape',
           'break', 'clearpage', 'newpage', 'smallskip', 'medskip', 'bigskip',
           'nobreak', 'allowbreak'].includes(cmd)) {
        i += 1 + cmd.length;
        continue;
      }

      // Unknown command with argument — skip the name, include the arg content
      if (s[afterCmd] === '{') {
        const arg = extractBracedArg(s, afterCmd);
        if (arg) {
          result += inlineToHtml(arg.content);
          i = arg.end + 1;
          continue;
        }
      }

      // Unknown command without argument — skip the name
      i += 1 + cmd.length;
      continue;
    }

    // ^ → dagger (build-order.sh uses ^ for dagger notation)
    if (ch === '^') { result += '†'; i++; continue; }

    // Newlines in inline context → space
    if (ch === '\n') { result += ' '; i++; continue; }
    if (ch === '\r') { i++; continue; }

    // Regular character
    result += esc(ch);
    i++;
  }

  return result;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function renderHeading(titleHtml) {
  return `<div class="bulletin-head"><hr><span class="bulletin-head-title">${titleHtml}</span><hr></div>`;
}

function renderBulletinLine(nameHtml, refHtml, noteHtml) {
  return `<div class="bulletin-line"><span class="el-name">${nameHtml}</span><span class="el-ref">${refHtml}</span><span class="el-note">${noteHtml}</span></div>`;
}

// ── Elements file parser (block-level) ────────────────────────────────────────
// Handles the LaTeX macro subset used in lords-prayer.txt, confessions/*.tex,
// ten-commandments.txt, apostles-creed.txt, officers.txt, etc.

function renderTabular(content) {
  // content is everything between \begin{tabular} and \end{tabular}
  // First part is the column spec {c c} — skip to first }
  const specEnd = content.indexOf('}');
  const body = specEnd === -1 ? content : content.slice(specEnd + 1);

  // Split by \\ (row separator in tabular)
  const rows = body
    .split('\\\\')
    .map(r => r.trim().replace(/[\r\n\t]+/g, ' '))
    .filter(r => r && r !== '\\end{tabular}');

  const tableRows = rows.map(row => {
    const cells = row.split('&').map(c =>
      `<td>${inlineToHtml(c.trim())}</td>`
    );
    return `<tr>${cells.join('')}</tr>`;
  });

  return `<table class="officers-table"><tbody>${tableRows.join('')}</tbody></table>`;
}

function parseElementFile(content) {
  const html  = [];
  let i       = 0;
  let textBuf = '';

  const flushText = () => {
    const t = textBuf.trim();
    if (t) html.push(`<p class="elem-text">${inlineToHtml(t)}</p>`);
    textBuf = '';
  };

  while (i < content.length) {
    if (content[i] === '\r') { i++; continue; }

    // Two consecutive newlines → paragraph break
    if (content[i] === '\n' && content[i - 1] === '\n') {
      flushText();
      i++;
      continue;
    }

    const rest = content.slice(i);

    // ── Strip commands ────────────────────────────────────────────────────
    if (rest.startsWith('\\hangindent=') || rest.startsWith('\\hangafter=')) {
      const end = content.indexOf('\n', i);
      i = end === -1 ? content.length : end + 1;
      continue;
    }
    if (rest.startsWith('\\noindent')) { i += 9; continue; }
    if (rest.startsWith('\\par')) {
      flushText();
      i += 4;
      while (i < content.length && /[ \t]/.test(content[i])) i++;
      continue;
    }

    // \hspace*{...} or \hspace{...}
    const hspaceM = rest.match(/^\\hspace\*?\{/);
    if (hspaceM) {
      const argStart = i + hspaceM[0].length - 1;
      const arg = extractBracedArg(content, argStart);
      if (arg) { i = arg.end + 1; continue; }
    }

    // ── Block commands ────────────────────────────────────────────────────

    // \responsemin{...}
    if (rest.startsWith('\\responsemin{')) {
      flushText();
      const arg = extractBracedArg(content, i + '\\responsemin'.length);
      if (arg) {
        html.push(`<div class="response-min">${inlineToHtml(arg.content)}</div>`);
        i = arg.end + 1;
        continue;
      }
    }

    // \responseall{...}
    if (rest.startsWith('\\responseall{')) {
      flushText();
      const arg = extractBracedArg(content, i + '\\responseall'.length);
      if (arg) {
        html.push(`<div class="response-all">${inlineToHtml(arg.content)}</div>`);
        i = arg.end + 1;
        continue;
      }

    // \bulletinline{el}{ref}{note}
    if (rest.startsWith('\\bulletinline{')) {
      flushText();
      const a1 = extractBracedArg(content, i + '\\bulletinline'.length);
      if (a1) {
        let cs = a1.end + 1;
        while (cs < content.length && content[cs] !== '{') cs++;
        const a2 = extractBracedArg(content, cs);
        if (a2) {
          cs = a2.end + 1;
          while (cs < content.length && content[cs] !== '{') cs++;
          const a3 = extractBracedArg(content, cs);
          if (a3) {
            html.push(renderBulletinLine(
              inlineToHtml(a1.content),
              inlineToHtml(a2.content),
              inlineToHtml(a3.content),
            ));
            i = a3.end + 1;
            continue;
          }
        }
      }
    }

    // \bulletinhead{title}
    if (rest.startsWith('\\bulletinhead{')) {
      flushText();
      const arg = extractBracedArg(content, i + '\\bulletinhead'.length);
      if (arg) {
        html.push(renderHeading(inlineToHtml(arg.content)));
        i = arg.end + 1;
        continue;
      }
    }

    // \subsection*{title} or \subsection{title}
    const subsecM = rest.match(/^\\subsection\*?\{/);
    if (subsecM) {
      flushText();
      const argStart = i + subsecM[0].length - 1;
      const arg = extractBracedArg(content, argStart);
      if (arg) {
        html.push(`<h3 class="section-head">${esc(arg.content)}</h3>`);
        i = arg.end + 1;
        continue;
      }
    }

    // \vspace*{...} or \vspace{...}
    const vspaceM = rest.match(/^\\vspace\*?\{/);
    if (vspaceM) {
      flushText();
      const argStart = i + vspaceM[0].length - 1;
      const arg = extractBracedArg(content, argStart);
      if (arg) {
        html.push(`<div style="margin-top:${esc(arg.content)}"></div>`);
        i = arg.end + 1;
        continue;
      }
    }

    // \begin{tabular}...\end{tabular}
    if (rest.startsWith('\\begin{tabular}')) {
      flushText();
      const endTag = '\\end{tabular}';
      const endIdx = content.indexOf(endTag, i);
      if (endIdx !== -1) {
        const tabContent = content.slice(i + '\\begin{tabular}'.length, endIdx);
        html.push(renderTabular(tabContent));
        i = endIdx + endTag.length;
        continue;
      }
    }

    // \begin{center} / \end{center} — no-op (content is already centered on page)
    if (rest.match(/^\\(?:begin|end)\{(?:center|flushleft|flushright|document)\}/)) {
      const end = content.indexOf('}', i);
      i = end === -1 ? content.length : end + 1;
      continue;
    }

    // \clearpage — page break
    if (rest.startsWith('\\clearpage') || rest.startsWith('\\newpage')) {
      flushText();
      html.push('<div class="page-break"></div>');
      i += rest.startsWith('\\clearpage') ? 10 : 8;
      continue;
    }

    // Everything else goes into the text buffer for inline processing
    textBuf += content[i];
    i++;
  }

  flushText();
  return html.join('\n');
}

// ── TSV items → HTML ──────────────────────────────────────────────────────────

function tsvItemsToHtml(items, workspacePath, folder) {
  const dateDir = path.join(workspacePath, folder);
  const html = [];

  for (const item of items) {
    if (item.enabled === false) continue;

    if (item.type === 'heading') {
      html.push(renderHeading(inlineToHtml(item.title)));

    } else if (item.type === 'element') {
      // Skip music PDF file paths (absolute paths to .pdf files)
      if (/\.pdf$/i.test(item.name) || item.name.startsWith('~') || item.name.startsWith('/')) {
        continue;
      }
      if (item.name === 'Minister') {
        html.push(`<div class="response-min">${inlineToHtml(item.ref)}</div>`);
      } else if (item.name === 'ALL') {
        html.push(`<div class="response-all">${inlineToHtml(item.ref)}</div>`);
      } else {
        html.push(renderBulletinLine(
          inlineToHtml(item.name),
          inlineToHtml(item.ref),
          inlineToHtml(item.note),
        ));
      }

    } else if (item.type === 'raw') {
      const text = item.text ?? '';

      // \input{path}
      const inputMatch = text.match(/^\\input\{([^}]+)\}/);
      if (inputMatch) {
        const elemPath = path.resolve(dateDir, inputMatch[1]);
        if (fs.existsSync(elemPath)) {
          const content = fs.readFileSync(elemPath, 'utf8');
          html.push(parseElementFile(content));
        }
        // silently skip if file missing
        continue;
      }

      // \clearpage
      if (/^\\clearpage\b/.test(text)) {
        html.push('<div class="page-break"></div>');
        continue;
      }

      // \vspace{...}
      const vspaceM = text.match(/^\\vspace\*?\{([^}]+)\}/);
      if (vspaceM) {
        html.push(`<div style="margin-top:${esc(vspaceM[1])}"></div>`);
        continue;
      }

      // \responsemin{...}, \responseall{...} (from order editor)
      if (text.startsWith('\\responsemin{')) {
        const arg = extractBracedArg(text, '\\responsemin'.length);
        if (arg) html.push(`<div class="response-min">${inlineToHtml(arg.content)}</div>`);
        continue;
      }
      if (text.startsWith('\\responseall{')) {
        const arg = extractBracedArg(text, '\\responseall'.length);
        if (arg) html.push(`<div class="response-all">${inlineToHtml(arg.content)}</div>`);

      // Music PDF include via \includegraphics or similar — skip
      if (/\\includegraphics|\\includepdf/.test(text)) continue;

      // Other raw LaTeX — skip silently
    }
  }

  return html.join('\n');
}

// ── TSV parser (mirrors main.js parseTSV) ─────────────────────────────────────

function parseTSV(content) {
  return content.split('\n')
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

// ── Announcements → HTML ──────────────────────────────────────────────────────

function announcementsToHtml(items) {
  if (!items || items.length === 0) return '';
  const html = [];

  for (const item of items) {
    if (item.type === 'item') {
      const label = esc(item.label || '');
      const body  = inlineToHtml(item.body || '');
      html.push(`<div class="ann-item"><span class="ann-label">${label}</span> ${body}</div>`);
    } else if (item.type === 'announcec') {
      html.push(
        `<div class="ann-box ann-centered">` +
        `<div class="ann-title">${esc(item.title)}</div>` +
        `<div class="ann-content">${inlineToHtml(item.content)}</div>` +
        `</div>`
      );
    } else if (item.type === 'announcel') {
      html.push(
        `<div class="ann-box ann-left">` +
        `<div class="ann-title">${esc(item.title)}</div>` +
        `<div class="ann-content">${inlineToHtml(item.content)}</div>` +
        `</div>`
      );
    }
    // 'raw' items (commented-out lines, structural boilerplate) → skip
  }

  return html.join('\n');
}

// ── Side-file (prayer list / birthdays) → HTML ───────────────────────────────

function sideFileToHtml(content) {
  if (!content || !content.trim()) return '';
  // Extract \subsection*{...} heading
  const headM = content.match(/\\subsection\*?\{([^}]+)\}/);
  const heading = headM ? `<h3 class="section-head">${esc(headM[1])}</h3>` : '';
  const body = content
    .replace(/\\subsection\*?\{[^}]+\}/g, '')
    .trim();
  return heading + (body ? `<p class="side-text">${inlineToHtml(body)}</p>` : '');
}

// ── Logo / graphic discovery ──────────────────────────────────────────────────

function findGraphic(workspacePath, patterns) {
  const graphicsDir = path.join(workspacePath, 'graphics');
  if (!fs.existsSync(graphicsDir)) return null;
  try {
    const files = fs.readdirSync(graphicsDir);
    for (const pat of patterns) {
      const found = files.find(f => pat.test(f.toLowerCase()));
      if (found) return pathToFileURL(path.join(graphicsDir, found)).href;
    }
  } catch { /* ignore */ }
  return null;
}

// ── CSS generation ────────────────────────────────────────────────────────────

function buildCSS(fontsDir) {
  const fontFile = (name) => pathToFileURL(path.join(fontsDir, name)).href;

  return `
@font-face {
  font-family: 'Coelacanth';
  src: url('${fontFile('Coelacanth.otf')}') format('opentype');
  font-weight: normal; font-style: normal;
}
@font-face {
  font-family: 'Coelacanth';
  src: url('${fontFile('CoelacanthBold.otf')}') format('opentype');
  font-weight: bold; font-style: normal;
}
@font-face {
  font-family: 'Coelacanth';
  src: url('${fontFile('CoelacanthIt.otf')}') format('opentype');
  font-weight: normal; font-style: italic;
}
@font-face {
  font-family: 'Coelacanth';
  src: url('${fontFile('CoelacanthSemibd.otf')}') format('opentype');
  font-weight: 600; font-style: normal;
}

@page {
  size: 5.5in 8.5in;
  margin: 0.25in;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  font-family: 'Coelacanth', Georgia, serif;
  font-size: 11pt;
  line-height: 1.3;
  margin: 0;
  padding: 0;
  color: #000;
}

/* ── Header ────────────────────────────────────────────── */
.bulletin-header {
  text-align: center;
  margin-bottom: 0.06in;
}
.church-logo {
  display: block;
  margin: 0 auto;
  max-width: 92%;
  max-height: 1.4in;
}
.denomination {
  font-size: 9.5pt;
  margin: 0.04in 0 0.02in;
}
.header-rule {
  border: none;
  border-top: 0.5pt solid #000;
  margin: 0.04in 0;
}
.service-title {
  margin: 0;
  font-size: 11pt;
  font-variant: small-caps;
}

/* ── Order of worship ──────────────────────────────────── */
.order-section { font-size: 10.5pt; }

.bulletin-head {
  display: flex;
  align-items: center;
  gap: 0.12in;
  margin: 0.1in 0 0.04in;
  font-size: 9pt;
}
.bulletin-head hr {
  flex: 1;
  border: none;
  border-top: 0.5pt solid #000;
  margin: 0;
}
.bulletin-head-title { font-style: italic; white-space: nowrap; }

.bulletin-line {
  position: relative;
  min-height: 1.35em;
  margin: 1pt 0;
}
.el-name {
  position: absolute;
  left: 0;
  font-weight: bold;
  font-size: 10.5pt;
}
.el-ref {
  display: block;
  text-align: center;
  font-style: italic;
  font-size: 9pt;
}
.el-note {
  position: absolute;
  right: 0;
  font-size: 9pt;
}

/* ── Responsive readings ───────────────────────────────── */
.response-min {
  padding-left: 0.22in;
  margin: 2pt 0;
  font-size: 9.5pt;
}
.response-all {
  padding-left: 0.22in;
  text-indent: -0.22in;
  margin: 2pt 0;
  font-weight: bold;
  font-size: 9pt;
}

/* ── Divider (cross + rule) ────────────────────────────── */
.bulletin-divider {
  display: flex;
  align-items: center;
  margin: 0.08in 0 0.02in;
}
.divider-rule {
  flex: 1;
  border: none;
  border-top: 0.5pt solid #000;
}
.cross-img {
  width: 0.25in;
  height: auto;
  margin: 0 0.05in;
}
.standing-note {
  font-size: 8.5pt;
  margin: 0.01in 0 0;
  font-style: italic;
}

/* ── Page breaks ───────────────────────────────────────── */
.page-break { page-break-after: always; height: 0; }

/* ── Announcements page ────────────────────────────────── */
.announcements-page { text-align: center; }
.ann-heading { font-size: 11pt; font-weight: bold; margin: 0 0 0.06in; }

.ann-list { text-align: left; margin: 0.04in 0; }
.ann-item { margin: 0.05in 0; font-size: 10pt; }
.ann-label { font-weight: bold; }

.ann-box {
  border: 0.5pt solid #000;
  padding: 0.05in 0.08in;
  margin: 0.06in auto;
  text-align: left;
  width: 98%;
}
.ann-centered .ann-content { text-align: center; }
.ann-box .ann-title {
  text-align: center;
  font-weight: bold;
  font-size: 11pt;
  margin-bottom: 3pt;
}

/* ── Prayer / birthday sections ────────────────────────── */
.prayer-section, .birthdays-section { margin: 0.08in 0; font-size: 10pt; }
.side-text { margin: 0.02in 0; }

/* ── Officers ──────────────────────────────────────────── */
.officers-section { font-size: 9pt; margin-top: 0.1in; }
.officers-table {
  width: auto;
  margin: 0 auto;
  border-collapse: collapse;
  text-align: center;
}
.officers-table td { padding: 0 0.12in 0.01in; }

/* ── Element file content ──────────────────────────────── */
.elem-text { margin: 2pt 0; font-size: 10.5pt; }
.section-head {
  font-size: 10pt;
  font-weight: bold;
  text-align: center;
  margin: 0.06in 0 0.02in;
}
.small-text { font-size: 9pt; }

/* ── Print tweaks ──────────────────────────────────────── */
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render the full bulletin as an HTML string.
 *
 * @param {object} params
 * @param {string}   params.workspacePath  - Absolute path to the bulletin workspace
 * @param {string}   params.folder         - Service folder name (e.g. "2026-04-12")
 * @param {string}   params.date           - ISO date string YYYY-MM-DD
 * @param {string}   params.tsvContent     - Raw order.tsv content
 * @param {string}   params.fontsDir       - Absolute path to app's fonts/ directory
 * @param {Array}    params.announcementItems - Parsed announcement items (from main.js parseAnnouncements)
 * @returns {string} Complete <!DOCTYPE html> string
 */

const DEFAULT_SECOND_PAGE_BLOCKS = [
  { id: 'announcements', type: 'announcements', label: 'Announcements',  enabled: true },
  { id: 'prayer-list',   type: 'textfile',      label: 'Prayer List',    file: 'prayer-list.txt',       scope: 'workspace', enabled: true },
  { id: 'birthdays',     type: 'textfile',      label: 'Birthdays',      file: 'birthdays.txt',         scope: 'workspace', enabled: true },
  { id: 'officers',      type: 'element',       label: 'Officers',       file: 'elements/officers.txt', scope: 'workspace', enabled: true },
];

function renderBlock(block, { workspacePath, folder, announcementItems }) {
  if (block.type === 'announcements') {
    const html = announcementsToHtml(announcementItems || []);
    return html ? `<div class="ann-list">${html}</div>` : '';
  }
  const filePath = block.scope === 'service'
    ? path.join(workspacePath, folder, block.file)
    : path.join(workspacePath, block.file);
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  const html = block.type === 'element'
    ? parseElementFile(content)
    : sideFileToHtml(content);
  if (!html) return '';
  const wrapClass = `block-${block.id.replace(/[^a-z0-9]/g, '-')}`;
  return `<div class="${wrapClass}">${html}</div>`;
}

function renderBulletinHTML({
  workspacePath,
  folder,
  date,
  tsvContent,
  fontsDir,
  announcementItems,
  churchConfig = {},
}) {
  // ── Date formatting ──────────────────────────────────────────────────────
  let dateStr = date || '';
  try {
    const [y, m, d] = (date || '').split('-').map(Number);
    if (y && m && d) {
      dateStr = new Intl.DateTimeFormat('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      }).format(new Date(Date.UTC(y, m - 1, d)));
    }
  } catch { /* leave as-is */ }

  // ── Logo / cross ─────────────────────────────────────────────────────────
  let logoUrl = null;
  if (churchConfig.logoFile) {
    const lp = path.join(workspacePath, 'graphics', churchConfig.logoFile);
    if (fs.existsSync(lp)) logoUrl = pathToFileURL(lp).href;
  }
  if (!logoUrl) {
    logoUrl = findGraphic(workspacePath, [/logo.*bw/, /bw.*logo/, /new-logo/, /church-logo/, /logo/]);
  }
  const crossUrl = findGraphic(workspacePath, [/cross/]);

  // ── Order of worship ─────────────────────────────────────────────────────
  const tsvItems   = parseTSV(tsvContent || '');
  const orderHtml  = tsvItemsToHtml(tsvItems, workspacePath, folder);

  // ── Second page blocks ────────────────────────────────────────────────────
  const blocks = churchConfig.secondPageBlocks ?? DEFAULT_SECOND_PAGE_BLOCKS;
  const secondPageHtml = blocks
    .filter(b => b.enabled)
    .map(b => renderBlock(b, { workspacePath, folder, announcementItems }))
    .filter(Boolean)
    .join('\n\n');

  // ── Divider (cross rule) ──────────────────────────────────────────────────
  const dividerHtml = crossUrl
    ? `<div class="bulletin-divider"><hr class="divider-rule"><img class="cross-img" src="${crossUrl}"><hr class="divider-rule"></div>`
    : `<div class="bulletin-divider"><hr class="divider-rule"></div>`;

  // ── Assemble HTML ─────────────────────────────────────────────────────────
  const css = buildCSS(fontsDir);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src file:; img-src file: data:">
<style>${css}</style>
</head>
<body>

<div class="bulletin-header">
${logoUrl ? `  <img class="church-logo" src="${logoUrl}" alt="Church logo">` : ''}
${churchConfig.denominationLine != null
  ? (churchConfig.denominationLine ? `  <p class="denomination">${esc(churchConfig.denominationLine)}</p>` : '')
  : `  <p class="denomination">A Congregation of the <em>Evangelical Presbyterian Church</em></p>`}
  <hr class="header-rule">
  <p class="service-title"><strong>${esc(churchConfig.serviceTitle ?? 'Lord\'s Day Service')}<br>${esc(dateStr)}</strong></p>
</div>

<div class="order-section">
${orderHtml}
</div>

${dividerHtml}
${(churchConfig.standingNote != null ? churchConfig.standingNote : '*The congregation is invited to stand.')
  ? `<p class="standing-note">${esc(churchConfig.standingNote ?? '*The congregation is invited to stand.')}</p>`
  : ''}

<div class="page-break"></div>

<div class="announcements-page">

${secondPageHtml}

</div>

</body>
</html>`;
}

module.exports = { renderBulletinHTML };
