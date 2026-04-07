'use strict';

const fs   = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

// ── Print bulletin HTML → PDF ─────────────────────────────────────────────────

/**
 * Render the given HTML to a PDF via Electron's printToPDF.
 *
 * The HTML is written to htmlPath (a debug artifact; also avoids data: URL
 * length limits and font file:// CSP issues with loadURL).
 *
 * @param {string} htmlContent - Complete <!DOCTYPE html> string
 * @param {string} htmlPath    - Where to write the intermediate HTML file
 * @param {string} pdfPath     - Where to write the output PDF
 */
async function printBulletin(htmlContent, htmlPath, pdfPath) {
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');

  // Give the hidden window explicit dimensions so Chromium has a real
  // viewport to render into. Without this, the viewport may be zero-sized
  // and printToPDF produces a blank page.
  // Width ≈ 5.5in at 96 dpi; height ≈ 2 pages at 8.5in × 96 dpi.
  const win = new BrowserWindow({
    show: false,
    width: 528,
    height: 1632,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(htmlPath);

    // Wait for web fonts to finish loading before capturing the PDF,
    // otherwise Chromium may fall back to the system serif.
    await win.webContents.executeJavaScript('document.fonts.ready');

    // preferCSSPageSize: true tells Chromium to honour the @page { size }
    // declaration in the CSS (5.5in × 8.5in) rather than using the window's
    // screen viewport size as the page size.
    const pdfBuffer = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
    });

    fs.writeFileSync(pdfPath, pdfBuffer);
  } finally {
    win.destroy();
  }
}

// ── Booklet imposition ─────────────────────────────────────────────────────────
//
// Takes a bulletin PDF (portrait half-sheet, 5.5 × 8.5 in) and arranges its
// pages into a landscape letter (11 × 8.5 in) 2-up booklet layout suitable
// for duplex printing and folding.
//
// Page order for a 4-page booklet (1 physical sheet, duplex):
//   Sheet front:  [page 4 — left]  [page 1 — right]
//   Sheet back:   [page 2 — left]  [page 3 — right]
//
// General formula for N pages (padded to multiple of 4), sheet k (0-indexed):
//   Front: left  = page (N - 2k),     right = page (2k + 1)
//   Back:  left  = page (2k + 2),     right = page (N - 2k - 1)
//
// Pages are placed in portrait orientation within the landscape sheet;
// no rotation is applied. Duplex printing should be set to "flip along
// short edge" (tumble) in your printer driver.

/**
 * @param {string} bulletinPdfPath - Path to BULLETIN.pdf
 * @param {string} bookPdfPath     - Where to write book.pdf
 */
async function imposeBooklet(bulletinPdfPath, bookPdfPath) {
  const { PDFDocument } = require('pdf-lib');

  const srcBytes  = fs.readFileSync(bulletinPdfPath);
  const srcDoc    = await PDFDocument.load(srcBytes);
  const pageCount = srcDoc.getPageCount();

  // Pad to the next multiple of 4
  const paddedCount = Math.ceil(pageCount / 4) * 4;

  const pageIndices = Array.from({ length: pageCount }, (_, i) => i);
  const outDoc = await PDFDocument.create();

  // Embed pages from source PDF into the output document
  const embeddedPages = await outDoc.embedPdf(srcBytes, pageIndices);

  // Half-sheet page dimensions in points (1 in = 72 pt)
  const W = 5.5 * 72; // 396 pt
  const H = 8.5 * 72; // 612 pt

  // Helper: get embedded page by 1-based page number (null for blank padding)
  const getPage = (pageNum1) => {
    const idx = pageNum1 - 1;
    return (idx >= 0 && idx < embeddedPages.length) ? embeddedPages[idx] : null;
  };

  const numSheets = paddedCount / 4;

  for (let k = 0; k < numSheets; k++) {
    // Front side of sheet k
    const frontLeft  = getPage(paddedCount - 2 * k);      // outer page (back cover direction)
    const frontRight = getPage(2 * k + 1);                 // inner page (front cover direction)

    // Back side of sheet k
    const backLeft   = getPage(2 * k + 2);                 // inner page (inside left)
    const backRight  = getPage(paddedCount - 2 * k - 1);   // outer page (inside right)

    for (const [left, right] of [[frontLeft, frontRight], [backLeft, backRight]]) {
      // Landscape letter: 11 × 8.5 in = 2W × H pts
      const outPage = outDoc.addPage([W * 2, H]);
      if (left)  outPage.drawPage(left,  { x: 0, y: 0, width: W, height: H });
      if (right) outPage.drawPage(right, { x: W, y: 0, width: W, height: H });
    }
  }

  const pdfBytes = await outDoc.save();
  fs.writeFileSync(bookPdfPath, Buffer.from(pdfBytes));
}

module.exports = { printBulletin, imposeBooklet };
