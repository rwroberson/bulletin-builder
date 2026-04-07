// drag-drop.js — FLIP-animated drag-and-drop via Pointer Events
//
// Attach to any flex list. A placeholder div slides through the list to show
// the drop target; displaced siblings animate out of the way with FLIP.
//
// Usage:
//   attachDragDrop(listEl, '.item-selector', '.handle-selector', (from, to) => {});

/**
 * @param {HTMLElement} listEl
 * @param {string}      itemSel   CSS selector for draggable cards (direct children)
 * @param {string}      handleSel CSS selector for the drag handle inside each card
 * @param {(from: number, to: number) => void} onDrop  called only when position changed
 */
export function attachDragDrop(listEl, itemSel, handleSel, onDrop) {
  listEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const handle = e.target.closest(handleSel);
    if (!handle) return;
    const card = handle.closest(itemSel);
    if (!card || !listEl.contains(card)) return;
    e.preventDefault();
    startDrag(e, card, listEl, itemSel, onDrop);
  });
}

function startDrag(e, dragCard, listEl, itemSel, onDrop) {
  const allCards = [...listEl.querySelectorAll(itemSel)];
  const fromIdx  = allCards.indexOf(dragCard);
  if (fromIdx === -1) return;

  // "others" stays in the original DOM order throughout the drag; we only
  // move the placeholder, not the cards themselves.
  const others = allCards.filter(c => c !== dragCard);
  let toIdx    = fromIdx;

  const rect   = dragCard.getBoundingClientRect();
  const startY = e.clientY;

  // ── Placeholder ────────────────────────────────────────────────────────
  const ph = document.createElement('div');
  ph.className = 'dnd-ph';
  ph.style.height     = rect.height + 'px';
  ph.style.flexShrink = '0';
  listEl.insertBefore(ph, dragCard); // takes the card's slot

  // ── Lift card out of normal flow ───────────────────────────────────────
  Object.assign(dragCard.style, {
    position:      'fixed',
    top:           rect.top + 'px',
    left:          rect.left + 'px',
    width:         rect.width + 'px',
    zIndex:        '1000',
    margin:        '0',
    pointerEvents: 'none',
    transform:     'scale(1.03) rotate(0.4deg)',
    boxShadow:     '0 16px 40px rgba(0,0,0,.22)',
    transition:    'box-shadow .15s, transform .15s',
  });
  dragCard.classList.add('dnd-lifting');

  // ── Move placeholder + FLIP-animate siblings ───────────────────────────
  const movePh = (newToIdx) => {
    if (newToIdx === toIdx) return;

    // FLIP — First: capture current positions before the DOM change
    const beforeTops = others.map(c => c.getBoundingClientRect().top);

    // FLIP — Last: move the placeholder (DOM mutation)
    listEl.insertBefore(ph, others[newToIdx] ?? null);
    toIdx = newToIdx;

    // FLIP — Invert: apply opposite transforms so cards appear unmoved
    others.forEach((c, i) => {
      const dy = beforeTops[i] - c.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) {
        c.style.transition = '';
        c.style.transform  = '';
        return;
      }
      c.style.transition = 'none';
      c.style.transform  = `translateY(${dy}px)`;
    });

    // Force the browser to register the starting transforms
    listEl.offsetHeight; // eslint-disable-line no-unused-expressions

    // FLIP — Play: release transforms with a transition → cards animate
    others.forEach(c => {
      c.style.transition = 'transform .2s cubic-bezier(.25,.1,0,1)';
      c.style.transform  = '';
    });
  };

  // ── Pointer move: track cursor, update placeholder slot ────────────────
  const onMove = (e) => {
    // Keep lifted card under the cursor
    dragCard.style.top = (rect.top + e.clientY - startY) + 'px';

    // Which slot is the cursor nearest to?
    const cy = e.clientY;
    let newToIdx = others.length; // default: after everything
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (cy < r.top + r.height * 0.5) { newToIdx = i; break; }
    }
    movePh(newToIdx);
  };

  // ── Pointer up: commit or cancel ───────────────────────────────────────
  const onUp = () => {
    ph.remove();
    dragCard.style.cssText = '';
    dragCard.classList.remove('dnd-lifting');
    others.forEach(c => { c.style.transition = ''; c.style.transform = ''; });

    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup',   onUp);

    if (toIdx !== fromIdx) onDrop(fromIdx, toIdx);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup',   onUp);
}
