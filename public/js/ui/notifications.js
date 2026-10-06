import { api } from '../core/api.js';
import { $, esc, fmtTime, toast } from '../core/util.js';

/* --------------------------------------------------------- notifications */

// The bell in the top bar. The list comes from /api/notifications, new ones
// arrive over the live socket. "Read" is remembered per browser.

const SEEN_KEY = 'gp-notes-seen';
const POPUP_KEY = 'gp-notes-popups';
let items = [];

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

const seenAt = () => Number(store.get(SEEN_KEY, '0')) || 0;
const popupsOn = () => store.get(POPUP_KEY, '1') === '1';

function renderBadge() {
  const unread = items.filter((n) => n.at > seenAt()).length;
  const badge = $('#bell-badge');
  if (!badge) return;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', unread === 0);
}

function renderList() {
  const list = $('#bell-list');
  if (!list) return;
  const seen = seenAt();
  list.innerHTML = items.length
    ? items
        .map(
          (n) => `
      <a class="bell-item ${esc(n.level)} ${n.at > seen ? 'unread' : ''}" ${n.serverId ? `href="#/servers/${esc(n.serverId)}"` : ''}>
        <span class="bell-dot"></span>
        <span class="bell-text">
          ${n.title ? `<b>${esc(n.title)}</b>` : ''}
          <span>${esc(n.message)}</span>
          <span class="faint">${fmtTime(n.at)}</span>
        </span>
      </a>`
        )
        .join('')
    : '<div class="faint" style="padding:18px;text-align:center">Nothing yet. Crashes, installs, backups and sign-ins show up here.</div>';
}

function open() {
  $('#bell-panel').classList.remove('hidden');
  $('#bell-btn').setAttribute('aria-expanded', 'true');
  renderList();
  // Opening the list counts as reading it.
  if (items[0]) store.set(SEEN_KEY, String(items[0].at));
  renderBadge();
}

function close() {
  $('#bell-panel')?.classList.add('hidden');
  $('#bell-btn')?.setAttribute('aria-expanded', 'false');
}

function updateDesktopButton() {
  const btn = $('#bell-desktop');
  if (!btn) return;
  // Browsers only allow it on https:// or localhost, and only once asked.
  const possible = 'Notification' in window && window.isSecureContext;
  btn.classList.toggle('hidden', !possible || Notification.permission !== 'default');
}

export async function initNotifications() {
  const data = await api('/api/notifications').catch(() => ({ notifications: [] }));
  items = data.notifications || [];
  renderBadge();
  renderList();
  updateDesktopButton();
}

/** A new event from the live socket. */
export function addNotification(note) {
  if (!note || items.some((n) => n.id === note.id)) return;
  items.unshift(note);
  if (items.length > 60) items.length = 60;
  const panelOpen = !$('#bell-panel')?.classList.contains('hidden');
  if (panelOpen) {
    store.set(SEEN_KEY, String(note.at));
    renderList();
  }
  renderBadge();
  if (!note.loud || panelOpen) return;
  if (popupsOn()) toast(`${note.title ? `${note.title}: ` : ''}${note.message}`, note.level === 'error' ? 'error' : note.level === 'warn' ? 'warn' : 'info', 7000);
  // A desktop alert only matters when the tab is in the background.
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(note.title || 'GamePanel', { body: note.message, tag: note.id, icon: '/img/favicon-64.png' });
    } catch {
      /* some browsers only allow it from a service worker */
    }
  }
}

$('#bell-btn')?.addEventListener('click', (event) => {
  event.stopPropagation();
  if ($('#bell-panel').classList.contains('hidden')) open();
  else close();
});
$('#bell-panel')?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (event.target.closest('.bell-item[href]')) close();
});
document.addEventListener('click', close);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
});

const popups = $('#bell-popups');
if (popups) {
  popups.checked = popupsOn();
  popups.addEventListener('change', () => store.set(POPUP_KEY, popups.checked ? '1' : '0'));
}
$('#bell-desktop')?.addEventListener('click', async () => {
  await Notification.requestPermission().catch(() => null);
  updateDesktopButton();
});
