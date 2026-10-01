// Tooltips for every page of the tools, in place of the browser's own `title` tooltips, which cannot
// be reached by keyboard, cannot be dismissed, vanish before they can be read and look like nothing
// else on the site. Loaded as a page script of its own (index.html, chora.html), so the pages' own
// code needs no change beyond saying what a tooltip says.
//
// What an element says: `data-tip="text"`, or `data-tip-template="id"` for the content of a
// <template> of that id (rich text; no links or controls, as a tooltip cannot be entered). A `title`
// attribute set later, by this site's code or a library's (MapLibre's zoom buttons), is turned into
// `data-tip` as it appears, and its text kept as the element's aria-label if it had no other name.
//
// What it does (WCAG 2.2, 1.4.13 content on hover or focus): it shows on hover and on keyboard focus;
// it stays while the pointer moves onto it (hoverable) and until the pointer or focus leaves
// (persistent); Esc closes it without moving either (dismissible). Each tooltip is an element of
// role="tooltip" that the focusable element names in aria-describedby, from the start, so a screen
// reader reads it as the element's description whether it is showing or not. The focusable element
// is the tooltip's own if it is one, or the link or button it is inside (a toolbox panel's name, in
// its link); an element with neither is made focusable, so that a keyboard can reach every tooltip.
// The exception is a part of an SVG drawing (Chora's timeline): the drawing is one image to a screen
// reader, with its own label, and its rows are not each a stop for the keyboard. On a touch screen a
// tap shows a tooltip and a second tap hides it; a link's first tap shows it, the second follows it.
// It is placed below its element, or above if there is more room there, and kept within the window.

const TIP = '[data-tip], [data-tip-template]';
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const GAP = 8;      // between the element and its tooltip, in CSS pixels
const MARGIN = 8;   // kept clear at the edges of the window
const HIDE_AFTER = 150; // ms after the pointer leaves, so that it can cross onto the tooltip

/**
 * Where a tooltip goes: below the element if it fits, else above if there is more room there; centred
 * on the element, but moved along to stay at least `margin` within the window. Or, asked for 'left'
 * or 'right' (a column of buttons, where below would cover the next one), beside it, centred on it
 * from top to bottom, if it fits on that side; if not, below or above as before. Pure, for the tests.
 * @param {{left:number, top:number, right:number, bottom:number}} anchor the element's box
 * @param {{width:number, height:number}} tip the tooltip's size
 * @param {{width:number, height:number}} view the window's size
 * @param {'below'|'left'|'right'} [prefer]
 * @returns {{left:number, top:number, side:'below'|'above'|'left'|'right'}}
 */
export function place(anchor, tip, view, prefer = 'below', gap = GAP, margin = MARGIN) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const middle = clamp((anchor.top + anchor.bottom) / 2 - tip.height / 2, margin, view.height - margin - tip.height);
  if (prefer === 'left' && anchor.left - gap - tip.width >= margin) return { left: Math.round(anchor.left - gap - tip.width), top: Math.round(middle), side: 'left' };
  if (prefer === 'right' && anchor.right + gap + tip.width <= view.width - margin) return { left: Math.round(anchor.right + gap), top: Math.round(middle), side: 'right' };
  const below = view.height - anchor.bottom - gap - margin, above = anchor.top - gap - margin;
  const side = tip.height <= below || below >= above ? 'below' : 'above';
  const top = clamp(side === 'below' ? anchor.bottom + gap : anchor.top - gap - tip.height, margin, view.height - margin - tip.height);
  const left = clamp((anchor.left + anchor.right) / 2 - tip.width / 2, margin, view.width - margin - tip.width);
  return { left: Math.round(left), top: Math.round(top), side };
}

// Which side a tooltip prefers: its element's data-tip-side, or, for a library's controls that are
// stacked in a column (MapLibre's zoom buttons), the side away from the window's edge they are on.
const SIDES = [['.maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-right', 'left'], ['.maplibregl-ctrl-top-left, .maplibregl-ctrl-bottom-left', 'right']];
const sideOf = (el) => el.getAttribute('data-tip-side') || SIDES.find(([sel]) => el.closest(sel))?.[1] || 'below';

let installed = false, serial = 0;
const tips = new Map();   // element with data-tip → its tooltip element
const owners = new Map(); // element with data-tip → the element whose aria-describedby names its tooltip
let open = null;          // { el, node, via: 'hover' | 'focus' | 'tap' }
let hideTimer = 0, lastTouch = 0, dismissed = null;

const isSvg = (el) => el instanceof SVGElement;
// The element that takes focus for a tooltip: its own, the link or button it is in, or none (SVG).
function ownerOf(el) {
  if (isSvg(el)) return null;
  return el.matches(FOCUSABLE) ? el : el.parentElement?.closest(FOCUSABLE) || el;
}

function adopt(el) {
  if (el.hasAttribute('title')) {
    const t = el.getAttribute('title').trim();
    el.removeAttribute('title');
    if (t && !el.hasAttribute('data-tip-template')) {
      el.setAttribute('data-tip', t);
      // A title that was the element's only name stays its name.
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    }
  }
  if (!el.matches(TIP)) { if (tips.has(el)) drop(el); return; }
  let node = tips.get(el);
  if (!node) {
    node = document.createElement('div');
    node.className = 'tip'; node.setAttribute('role', 'tooltip'); node.id = `tip-${++serial}`; node.hidden = true;
    document.body.append(node);
    tips.set(el, node);
    const owner = ownerOf(el);
    if (owner) {
      if (owner === el && !el.matches(FOCUSABLE)) el.tabIndex = 0;
      const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!ids.includes(node.id)) owner.setAttribute('aria-describedby', [...ids, node.id].join(' '));
      owners.set(el, owner);
    }
  }
  fill(el, node);
  if (open?.el === el) position();   // its text changed while showing: it may now be another size
}

// An element that no longer says anything (its data-tip removed), or has left the page: its tooltip
// goes, and its owner's aria-describedby no longer names it.
function drop(el) {
  const node = tips.get(el), owner = owners.get(el);
  if (open?.el === el) hide();
  if (owner && node) {
    const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== node.id);
    if (ids.length) owner.setAttribute('aria-describedby', ids.join(' ')); else owner.removeAttribute('aria-describedby');
  }
  node?.remove(); tips.delete(el); owners.delete(el);
}

function fill(el, node) {
  const id = el.getAttribute('data-tip-template');
  const tpl = id && document.getElementById(id);
  if (tpl instanceof HTMLTemplateElement) node.replaceChildren(tpl.content.cloneNode(true));
  else node.textContent = el.getAttribute('data-tip') || '';
}

function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.matches('[title], ' + TIP)) adopt(root);
  for (const el of root.querySelectorAll('[title], ' + TIP)) adopt(el);
}

// Tooltips whose element has left the page go with it (Chora redraws its card on every change).
function sweep() {
  for (const el of [...tips.keys()]) if (!el.isConnected) drop(el);
}

function position() {
  if (!open) return;
  const { el, node } = open;
  node.style.left = '0px'; node.style.top = '0px';   // measured where nothing narrows it
  const r = el.getBoundingClientRect();
  const { left, top, side } = place(r, { width: node.offsetWidth, height: node.offsetHeight }, { width: document.documentElement.clientWidth, height: window.innerHeight }, sideOf(el));
  node.style.left = `${left}px`; node.style.top = `${top}px`; node.dataset.side = side;
}

function show(el, via) {
  clearTimeout(hideTimer);
  if (dismissed === el) return;
  const node = tips.get(el);
  if (!node || !(node.textContent.trim() || node.children.length)) return;
  if (open && open.el !== el) hide();
  open = { el, node, via };
  node.hidden = false;
  position();
}

function hide() {
  clearTimeout(hideTimer);
  if (!open) return;
  open.node.hidden = true;
  open = null;
}
// A tooltip shown by hover in place of the one the focused element shows comes back when the
// pointer leaves (unless Esc dismissed it).
function restoreFocused() {
  const f = document.activeElement, el = f && tipFor(f);
  if (el && f.matches(':focus-visible')) show(el, 'focus');
}
const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { hide(); restoreFocused(); }, HIDE_AFTER); };

// The tooltip's element for an element focused: its own, or the first inside it that it is the
// owner of (a link's name). A focused container (a section, a list) opens no descendant's tooltip.
function tipFor(target) {
  if (!target?.matches) return null;
  if (target.matches(TIP) && tips.has(target) && owners.get(target) === target) return target;
  return [...target.querySelectorAll(TIP)].find((x) => tips.has(x) && owners.get(x) === target) || null;
}

export function install(doc = document) {
  if (installed || !doc?.body) return;
  installed = true;
  scan(doc.body);
  new MutationObserver((records) => {
    let removed = false;
    for (const r of records) {
      if (r.type === 'attributes') { if (r.target !== open?.node) adopt(r.target); continue; }
      for (const n of r.addedNodes) if (!n.classList?.contains('tip')) scan(n);
      if (r.removedNodes.length) removed = true;
    }
    if (removed) sweep();
  }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'data-tip', 'data-tip-template'] });

  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    if (open && open.node.contains(e.target)) { clearTimeout(hideTimer); return; }
    const el = e.target.closest?.(TIP);
    if (el && tips.has(el)) show(el, open?.el === el ? open.via : 'hover');
  });
  doc.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const from = e.target.closest?.(TIP);
    if (from && dismissed === from && !from.contains(e.relatedTarget)) dismissed = null;
    if (!open || open.via !== 'hover') return;
    const to = e.relatedTarget;
    if (to && (open.el.contains(to) || open.node.contains(to))) return;
    if (open.el.contains(e.target) || open.node.contains(e.target)) hideSoon();
  });
  doc.addEventListener('focusin', (e) => {
    dismissed = null;
    const el = tipFor(e.target);
    if (el && e.target.matches(':focus-visible')) show(el, 'focus');
    else if (open && open.via === 'focus') hide();
  });
  doc.addEventListener('focusout', (e) => {
    if (dismissed && (e.target === dismissed || e.target.contains(dismissed))) dismissed = null;
    if (open && open.via === 'focus' && (e.target === open.el || e.target.contains(open.el))) hide();
  });
  // Esc closes the tooltip, and goes on to whatever else the page does with Esc: Terra Draw cancels
  // a drawing with it, and the match review closes its form, whether or not a tooltip is open.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    dismissed = open.el; hide();
  }, true);
  // Touch: tap to show, tap again to hide; a tap anywhere else, the tooltip included, hides it.
  doc.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    lastTouch = Date.now();
    if (open && !open.el.contains(e.target)) hide();   // a tap on the tooltip itself closes it too
  }, true);
  doc.addEventListener('click', (e) => {
    if (Date.now() - lastTouch > 800) return;
    const el = e.target.closest?.(TIP);
    if (!el || !tips.has(el)) return;
    if (open?.el === el) { hide(); return; }
    // A link's first tap shows what it is before it is followed; a button acts at once, and says.
    if (e.target.closest('a[href]')) e.preventDefault();
    dismissed = null; show(el, 'tap');
  }, true);
  window.addEventListener('resize', position);
  doc.addEventListener('scroll', position, true);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install());
  else install();
}
