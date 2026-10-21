import { state } from '../core/state.js';
import { $, can, esc } from '../core/util.js';
import { openModal } from './modal.js';

/* -------------------------------------------------------------- keyboard */

// Using the whole panel without a mouse: a skip link, focusable versions of
// things that are clicked but are not buttons, arrow keys in tab strips, the
// sidebar and tables, and a layer of single-key shortcuts (press ? to see
// them). The Ctrl/Cmd+K command palette is its own module (ui/palette.js);
// this one never binds it, it only lists it.

/** Elements the pages click with a handler but draw as spans, divs, rows or bare anchors. */
const CLICKABLE = [
  '.chip[data-cat]',
  '.game-card[data-template]',
  '.srv-row[data-card]',
  'tr.clickable',
  '.file-name[data-dir]',
  '.file-name[data-file]',
  'a[data-dir]:not([href])',
  'a[data-history-file]:not([href])',
  'a[data-open]:not([href])',
  '[data-kb-click]',
].join(',');

/** Containers where the arrow keys move between their buttons and links. */
const ROVING = '[data-kb-roving], .tabs, .seg, #nav, #sidebar-server-list, .history-list, .ed-tabs, .cfg-files';
const ITEMS = 'a[href], button:not([disabled]), [tabindex="0"]';

/** Where `g` then a letter goes. `needs` is a capability the account must hold. */
export const GO_KEYS = [
  { key: 'd', hash: '#/dashboard', label: 'Dashboard' },
  { key: 's', hash: '#/servers', label: 'Servers' },
  { key: 'g', hash: '#/templates', label: 'Games', needs: 'deploy' },
  { key: 'a', hash: '#/activity', label: 'Activity' },
  { key: 'l', hash: '#/audit', label: 'Audit log', admin: true },
  { key: 'b', hash: '#/bans', label: 'Bans', admin: true },
  { key: 'n', hash: '#/nodes', label: 'Nodes', admin: true },
  { key: 'u', hash: '#/users', label: 'Users', admin: true },
  { key: 't', hash: '#/settings', label: 'Settings', admin: true },
  { key: 'w', hash: '#/networks', label: 'Minecraft networks' },
  { key: 'k', hash: '#/clusters', label: 'ARK clusters' },
  { key: 'c', hash: '#/account', label: 'Account' },
];

/** The cheat sheet, as groups of [keys, what it does]. */
export const SHORTCUTS = [
  ['Anywhere', [
    ['?', 'Show this list'],
    ['Ctrl/Cmd + K', 'Command palette'],
    ['/', 'Search on this page'],
    ['n', 'New server'],
    ['g then h', 'Getting started checklist'],
    ['Esc', 'Close a dialog or menu'],
    ['Tab / Shift + Tab', 'Next / previous control'],
  ]],
  ['Go to (press g, then the letter)', GO_KEYS.map((g) => [`g then ${g.key}`, g.label])],
  ['Lists, tabs and menus', [
    ['Arrow keys', 'Move between tabs, sidebar links and table rows'],
    ['Home / End', 'First / last item'],
    ['Enter or Space', 'Open the focused item'],
    ['[ and ]', 'Previous / next tab on a server page'],
  ]],
  ['Server console', [
    ['i', 'Jump to the command line'],
    ['Up / Down', 'Earlier commands'],
    ['Tab', 'Finish a name or command'],
  ]],
  ['File editor', [
    ['Ctrl/Cmd + S', 'Save the file'],
    ['Ctrl/Cmd + Shift + S', 'Save all files'],
    ['Alt + PageUp / PageDown', 'Previous / next open file'],
    ['Alt + W', 'Close the file'],
    ['Esc', 'Hide the editor (files stay open)'],
  ]],
  ['Comparing', [
    ['n / p', 'Next / previous change'],
  ]],
];

/* ---------------------------------------------------------------- helpers */

export function isTyping(el) {
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

const overlayOpen = () => Boolean(document.querySelector('#modal-root .modal-backdrop:not([inert])') || $('#tour') || $('.ed-ws:not(.hidden)'));

function visible(el) {
  return el && el.offsetParent !== null && !el.closest('.hidden');
}

/** Make clickable non-buttons reachable with Tab. Runs again as pages draw. */
function enhance(root = document) {
  root.querySelectorAll?.(CLICKABLE).forEach((el) => {
    if (el.dataset.kb) return;
    el.dataset.kb = '1';
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (el.tagName !== 'A' && !el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
  // A scrolling log should be scrollable with the arrow keys.
  root.querySelectorAll?.('.console:not([tabindex]), .diff:not([tabindex]), .sbs-body:not([tabindex])').forEach((el) => (el.tabIndex = 0));
}

/* -------------------------------------------------------- key handlers */

function activate(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return false;
  const el = event.target;
  if (!el.matches?.(CLICKABLE) || el.dataset.kb !== '1') return false;
  // Space on a link-like thing should not scroll the page.
  event.preventDefault();
  el.click();
  return true;
}

function rove(event) {
  const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!arrows.includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (isTyping(event.target)) return false;
  const box = event.target.closest?.(ROVING);
  if (!box) return false;
  const items = [...box.querySelectorAll(ITEMS)].filter(visible);
  const at = items.indexOf(event.target.closest(ITEMS));
  if (at < 0) return false;
  let next = at;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else next = Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)));
  event.preventDefault();
  items[next].focus();
  return true;
}

/** Up and Down in a table: the control in the same column of the next or previous row. */
function tableMove(event) {
  if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (isTyping(target) && target.type !== 'checkbox') return false;
  const cell = target.closest?.('td');
  const row = cell?.parentElement;
  if (!row || !cell.closest('table')) return false;
  const col = [...row.children].indexOf(cell);
  const here = [...cell.querySelectorAll(ITEMS + ', input')].indexOf(target.closest(ITEMS + ', input'));
  for (let r = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling; r; r = event.key === 'ArrowDown' ? r.nextElementSibling : r.previousElementSibling) {
    const items = [...(r.children[col]?.querySelectorAll(ITEMS + ', input') || [])].filter(visible);
    if (items.length) {
      event.preventDefault();
      items[Math.min(Math.max(here, 0), items.length - 1)].focus();
      return true;
    }
  }
  return false;
}

let chord = null;
let chordTimer = null;
function endChord() {
  chord = null;
  clearTimeout(chordTimer);
  $('#kb-chord')?.remove();
}

function showChord() {
  if (!$('#kb-chord')) {
    const el = document.createElement('div');
    el.id = 'kb-chord';
    el.className = 'kb-chord mono';
    el.textContent = 'g … go to (d s g a c, ? for all)';
    document.body.appendChild(el);
  }
}

function go(entry) {
  if (entry.admin && state.user?.role !== 'admin') return false;
  if (entry.needs && !can(entry.needs)) return false;
  location.hash = entry.hash;
  return true;
}

function focusSearch() {
  const box = [...document.querySelectorAll('.view .search-input, .view input[type="search"], #console-find, .view input[placeholder*="earch"], .view input[placeholder*="ilter"]')].find(visible);
  if (!box) return false;
  box.focus();
  box.select?.();
  return true;
}

function serverTab(delta) {
  const tabs = [...document.querySelectorAll('.tabs a.tab')];
  if (state.route.name !== 'server' || tabs.length < 2) return false;
  const at = Math.max(0, tabs.findIndex((t) => t.classList.contains('active')));
  tabs[(at + delta + tabs.length) % tabs.length].click();
  return true;
}

function shortcut(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return false;
  if (isTyping(event.target) || overlayOpen() || !state.user) return false;
  const key = event.key;
  if (chord) {
    endChord();
    if (key === 'Escape') return true;
    if (key === 'h') {
      import('./onboarding.js').then((m) => m.openGettingStarted());
      return true;
    }
    const entry = GO_KEYS.find((g) => g.key === key.toLowerCase());
    return entry ? go(entry) : false;
  }
  if (key === 'g') {
    chord = true;
    showChord();
    chordTimer = setTimeout(endChord, 1500);
    return true;
  }
  if (key === '?') return openCheatSheet(), true;
  if (key === '/') return focusSearch();
  if (key === 'n' && can('deploy')) return (location.hash = '#/templates'), true;
  if (key === 'i') {
    const input = $('#console-input');
    if (visible(input)) return input.focus(), true;
  }
  if (key === '[') return serverTab(-1);
  if (key === ']') return serverTab(1);
  return false;
}

export function openCheatSheet() {
  if ($('#kb-sheet')) return;
  const mine = (g) => !(g.admin && state.user?.role !== 'admin') && !(g.needs && !can(g.needs));
  const groups = SHORTCUTS.map(([title, rows]) => [title, title.startsWith('Go to') ? rows.filter((_, i) => mine(GO_KEYS[i])) : rows]);
  openModal({
    title: 'Keyboard shortcuts',
    width: 640,
    body: `<div id="kb-sheet" class="kb-sheet">${groups
      .map(
        ([title, rows]) => `<section><h4>${esc(title)}</h4><dl>${rows
          .map(([keys, what]) => `<dt>${keys.split(' ').map((k) => (/^(then|or|and|\+|\/)$/.test(k) ? `<span class="faint">${esc(k)}</span>` : `<kbd>${esc(k)}</kbd>`)).join(' ')}</dt><dd>${esc(what)}</dd>`)
          .join('')}</dl></section>`
      )
      .join('')}<p class="faint">Shortcuts that are a single key pause while you are typing in a box or have a dialog open.</p></div>`,
    actions: [{ label: 'Close', primary: true, close: true }],
  });
}

/* ------------------------------------------------------------------ setup */

let started = false;

export function initKeyboard() {
  if (started) return;
  started = true;
  document.addEventListener('keydown', (event) => {
    if (activate(event) || rove(event) || tableMove(event)) return;
    if (shortcut(event)) event.preventDefault();
  });
  // Skip link: the first Tab stop on every page.
  $('#skip-link')?.addEventListener('click', () => {
    const view = $('#view');
    if (!view) return;
    view.tabIndex = -1;
    view.focus({ preventScroll: false });
  });
  enhance();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      enhance();
    });
  }).observe(document.body, { childList: true, subtree: true });
  // A new page starts at its top for keyboard users too, but only if focus was on something that is now gone.
  window.addEventListener('hashchange', () => {
    setTimeout(() => {
      if (document.activeElement === document.body || !document.activeElement?.isConnected) {
        const view = $('#view');
        if (view) {
          view.tabIndex = -1;
          view.focus({ preventScroll: true });
        }
      }
    }, 60);
  });
}
