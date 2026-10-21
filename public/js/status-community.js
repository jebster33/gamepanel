/*
 * The status page's community section: the global leaderboard (with game and
 * statistic filters) and, when the admin turned it on, the recent join/leave
 * feed. Names only. Built with text nodes, so nothing from the server is markup.
 */

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids.flat().filter((x) => x != null));
  return node;
}

function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

let slug = '';
let choice = { game: '', metric: '' };
let boardsOn = false;

async function drawBoard() {
  const box = $('community-board');
  if (!box) return;
  try {
    const q = new URLSearchParams();
    if (choice.game) q.set('game', choice.game);
    if (choice.metric) q.set('metric', choice.metric);
    const res = await fetch(`/api/public/status/${encodeURIComponent(slug)}/leaderboards?${q}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Not available');
    choice = { game: data.game || '', metric: data.metric };
    const select = (id, items, value, label) => {
      const s = el('select', { id, 'aria-label': label }, items.map((i) => el('option', { value: i.id, text: i.name || i.label })));
      s.value = value;
      s.addEventListener('change', () => {
        choice = { game: $('lb-game')?.value ?? '', metric: $('lb-metric')?.value ?? '' };
        if (id === 'lb-game') choice.metric = '';
        drawBoard();
      });
      return s;
    };
    box.replaceChildren(
      el(
        'div',
        { class: 'lb-filters' },
        data.games.length > 1 ? select('lb-game', [{ id: '', name: 'All games' }, ...data.games], choice.game, 'Game') : null,
        select('lb-metric', data.metrics, data.metric, 'Statistic')
      ),
      data.rows.length
        ? el('ol', { class: 'lb-list' }, data.rows.map((r) => el('li', {}, el('span', { class: 'lb-name', text: r.name }), el('b', { text: r.display }))))
        : el('p', { class: 'meta', text: 'Nobody on the board yet.' })
    );
  } catch (err) {
    box.replaceChildren(el('p', { class: 'meta', text: err.message }));
  }
}

/** Draw (or refresh) the section from the page data. */
export function renderCommunity(data, pageSlug) {
  const host = $('community');
  if (!host) return;
  slug = pageSlug;
  const feed = data.feed;
  const nodes = [];
  if (data.boards) {
    nodes.push(el('article', { class: 'card' }, el('div', { class: 'name', text: 'Leaderboard' }), el('div', { id: 'community-board' })));
  }
  if (feed?.length) {
    nodes.push(
      el(
        'article',
        { class: 'card' },
        el('div', { class: 'name', text: 'Recent joins and leaves' }),
        el('ul', { class: 'lb-list' }, feed.map((e) => el('li', {}, el('span', { class: 'lb-name', text: `${e.name} ${e.type === 'join' ? 'joined' : 'left'} ${e.server}` }), el('span', { class: 'meta', text: ago(e.t) }))))
      )
    );
  }
  const hadBoard = Boolean($('community-board'));
  // The board keeps its filters between refreshes: only rebuild it when it is not there yet.
  const keep = hadBoard && data.boards ? $('community-board') : null;
  host.replaceChildren(...nodes);
  if (keep) host.querySelector('#community-board')?.replaceWith(keep);
  else if (data.boards) drawBoard();
  boardsOn = Boolean(data.boards);
  return boardsOn;
}
