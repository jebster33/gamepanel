import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { promptModal } from '../ui/modal.js';
import { skeleton } from '../ui/skeleton.js';

/* ------------------------------------------------------------------ bans */

/** One ban list for every server, and the appeals banned players send in. */
export async function renderBans(view) {
  setCrumbs('Bans');
  view.innerHTML = `<div class="page-head"><h1>Bans</h1></div><div id="bans-body">${skeleton('list', 'Loading bans…')}</div>`;
  let data;
  try {
    data = await api('/api/bans');
  } catch (err) {
    $('#bans-body').innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  draw(data);
}

const METHOD = { list: 'ban list', command: 'ban command, while running' };

function draw(data) {
  const body = $('#bans-body');
  if (!body) return;
  const open = data.appeals.filter((a) => a.status === 'open');
  const decided = data.appeals.filter((a) => a.status !== 'open').slice(0, 20);
  const appealUrl = `${location.origin}/appeal`;

  body.innerHTML = `
    ${
      open.length
        ? `<div class="card mb-16">
      <div class="card-head"><h4>Appeals waiting <span class="faint" style="letter-spacing:0">${open.length}</span></h4></div>
      <div class="list">${open.map(appealRow).join('')}</div>
    </div>`
        : ''
    }
    <div class="card mb-16">
      <div class="card-head">
        <h4>Shared ban list <span class="faint" style="letter-spacing:0">${data.bans.length}</span></h4>
        <div class="spacer"></div>
        <input class="search-input" id="ban-find" placeholder="Find a player…" style="max-width:200px" />
      </div>
      <form class="ban-add mb-16" id="ban-add">
        <input id="ban-name" placeholder="Player name" maxlength="32" required />
        <input id="ban-reason" placeholder="Reason (shown to them)" maxlength="200" />
        <select id="ban-hours" style="width:auto">
          <option value="0">Permanent</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">1 week</option><option value="720">30 days</option>
        </select>
        <button class="btn btn-primary">Ban everywhere</button>
      </form>
      ${
        data.bans.length
          ? `<div class="list" id="ban-list">${data.bans
              .map(
                (b) => `<div class="list-row" data-find="${esc(b.name.toLowerCase())}">
            <div class="grow"><div class="title">${esc(b.name)}</div>
              <div class="sub">${esc(b.reason || 'No reason given')} · by ${esc(b.by)} ${fmtTime(b.at)}${b.until ? ` · until ${fmtTime(b.until)}` : ''}</div></div>
            <button class="btn btn-sm" data-unban="${esc(b.id)}" data-name="${esc(b.name)}">Lift</button>
          </div>`
              )
              .join('')}</div>`
          : '<p class="faint" style="margin:0">Nobody is banned. A ban added here reaches every server below, including ones that are stopped right now.</p>'
      }
    </div>

    <div class="card mb-16">
      <div class="card-head"><h4>Servers that use it</h4></div>
      <div class="list">${
        data.servers
          .filter((s) => s.method)
          .map(
            (s) => `<div class="list-row">
          <div class="grow"><div class="title">${esc(s.name)}</div><div class="sub">Through its ${METHOD[s.method]}${s.enabled ? ` · ${s.applied} applied` : ''}</div></div>
          <label class="switch"><input type="checkbox" data-server="${esc(s.id)}" ${s.enabled ? 'checked' : ''} /><i></i></label>
        </div>`
          )
          .join('') || '<p class="faint" style="margin:0">None of your servers can ban players from the panel yet (Minecraft Java, Rust, Terraria, Factorio, Project Zomboid and Unturned can).</p>'
      }</div>
    </div>

    <div class="card">
      <div class="card-head">
        <h4>Appeals page</h4>
        <div class="spacer"></div>
        <label class="switch"><input type="checkbox" id="ap-on" ${data.appealSettings.enabled ? 'checked' : ''} /><i></i></label>
      </div>
      <p class="faint" style="margin:0 0 10px">A public page where banned players can ask to be let back in. They get a code to check on it; you accept (which lifts the ban everywhere) or deny with a reply.</p>
      <div class="input-row mb-16"><input class="mono" readonly value="${esc(appealUrl)}" /><a class="btn" href="/appeal" target="_blank" rel="noopener">Open</a></div>
      <label class="field"><span>Text at the top of the page</span>
        <textarea id="ap-intro" rows="3" maxlength="1000" placeholder="Banned by mistake, or ready to come back? Tell us what happened and an admin will look at it.">${esc(data.appealSettings.intro)}</textarea>
      </label>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="ap-save">Save</button></div>
      ${
        decided.length
          ? `<h4 class="mt-16" style="margin-bottom:8px">Decided</h4><div class="list">${decided
              .map(
                (a) => `<div class="list-row"><div class="grow"><div class="title">${esc(a.name)} <span class="${a.status === 'accepted' ? 'good-text' : 'bad-text'}" style="font-weight:500">${a.status}</span></div>
              <div class="sub">${esc(a.decidedBy || '')} ${a.decidedAt ? fmtTime(a.decidedAt) : ''}${a.reply ? ` · "${esc(a.reply)}"` : ''}</div></div></div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;

  const run = async (promise, message) => {
    try {
      const next = await promise;
      if (message) toast(message);
      draw(next);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  $('#ban-add').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#ban-name').value.trim();
    run(api('/api/bans', { method: 'POST', body: { name, reason: $('#ban-reason').value, hours: Number($('#ban-hours').value) } }), `${name} is banned on every server`);
  });
  $('#ban-find').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    body.querySelectorAll('#ban-list [data-find]').forEach((row) => row.classList.toggle('hidden', Boolean(term) && !row.dataset.find.includes(term)));
  });
  body.querySelectorAll('[data-unban]').forEach((btn) =>
    btn.addEventListener('click', () => run(api(`/api/bans/${encodeURIComponent(btn.dataset.unban)}`, { method: 'DELETE' }), `Lifted the ban on ${btn.dataset.name}`))
  );
  body.querySelectorAll('[data-server]').forEach((input) =>
    input.addEventListener('change', () => run(api(`/api/bans/servers/${encodeURIComponent(input.dataset.server)}`, { method: 'PUT', body: { enabled: input.checked } })))
  );
  const saveAppeals = () =>
    run(api('/api/bans/appeal-settings', { method: 'PUT', body: { enabled: $('#ap-on').checked, intro: $('#ap-intro').value } }), $('#ap-on').checked ? 'Appeals are open' : 'Appeals are closed');
  $('#ap-on').addEventListener('change', saveAppeals);
  $('#ap-save').addEventListener('click', saveAppeals);

  body.querySelectorAll('[data-decide]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const accept = btn.dataset.decide === 'accept';
      const reply = await promptModal(accept ? 'Accept the appeal' : 'Deny the appeal', accept ? 'The ban is lifted on every server. A note for them (optional):' : 'Tell them why (optional):', '', { hint: 'They see this when they check their code.' });
      if (reply === null) return;
      run(api(`/api/bans/appeals/${encodeURIComponent(btn.dataset.id)}`, { method: 'POST', body: { decision: btn.dataset.decide, reply } }), accept ? 'Appeal accepted; the ban is lifted' : 'Appeal denied');
    })
  );
}

function appealRow(a) {
  return `<div class="list-row appeal-row">
    <div class="grow">
      <div class="title">${esc(a.name)} <span class="faint" style="font-weight:400">${fmtTime(a.at)}${a.contact ? ` · ${esc(a.contact)}` : ''}</span></div>
      <div class="appeal-text">${esc(a.message)}</div>
    </div>
    <div class="appeal-actions">
      <button class="btn btn-sm btn-primary" data-decide="accept" data-id="${esc(a.id)}">Accept</button>
      <button class="btn btn-sm" data-decide="deny" data-id="${esc(a.id)}">Deny</button>
    </div>
  </div>`;
}
