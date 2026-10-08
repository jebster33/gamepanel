import { api } from '../../core/api.js';
import { esc, fmtTime, toast } from '../../core/util.js';
import { skeleton } from '../../ui/skeleton.js';

/* -------------------------------------------------------- chat moderation */

const STEPS = [
  ['warn', 'Warn them'],
  ['mute', 'Mute'],
  ['kick', 'Kick'],
  ['tempban', 'Ban for a while'],
];

export async function renderModeration(box, server) {
  box.innerHTML = skeleton('card');
  let data;
  try {
    data = await api(`/api/servers/${server.id}/moderation`);
  } catch (err) {
    box.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  const s = data.settings;
  const ladder = [...s.ladder];
  while (ladder.length < 4) ladder.push('');

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h4>Chat moderation</h4>
        <div class="spacer"></div>
        <label class="switch"><input type="checkbox" id="md-on" ${s.enabled ? 'checked' : ''} /><i></i></label>
      </div>
      <p class="faint" style="margin:0 0 14px">The panel reads chat from the console, so it acts right after a message: a warning first, then stronger steps for players who keep going. Strikes are forgotten after a quiet while.</p>

      <div class="md-grid">
        <label class="field"><span>Blocked words</span>
          <textarea id="md-words" rows="5" spellcheck="false" placeholder="One per line. word* also catches words starting with it.">${esc(s.words.join('\n'))}</textarea>
          <div class="hint">Matched as whole words, also when spelled with numbers or symbols (b4d, b.a.d).</div>
        </label>
        <div>
          <div class="checkbox-row"><input type="checkbox" id="md-links" ${s.links ? 'checked' : ''} /><label for="md-links">Block links and server addresses</label></div>
          <label class="field" id="md-allow-wrap" style="margin-left:26px"><span>Allowed sites</span>
            <input id="md-allow" value="${esc(s.allowDomains.join(', '))}" placeholder="discord.gg, yourserver.com" />
          </label>
          <div class="checkbox-row"><input type="checkbox" id="md-caps" ${s.caps ? 'checked' : ''} /><label for="md-caps">Block shouting (mostly CAPITALS)</label></div>
          <div class="checkbox-row"><input type="checkbox" id="md-spam" ${s.spam ? 'checked' : ''} /><label for="md-spam">Block spam (5 messages in 10 seconds, or the same message 3 times)</label></div>
        </div>
      </div>

      <h4 class="mt-16" style="margin-bottom:8px">What happens</h4>
      <div class="md-ladder">
        ${ladder
          .map(
            (step, i) => `<label class="field"><span>${['First time', 'Second time', 'Third time', 'After that'][i]}</span>
          <select data-step="${i}">
            ${i ? '<option value="">Same as before</option>' : ''}
            ${STEPS.map(([id, label]) => `<option value="${id}" ${step === id ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>`
          )
          .join('')}
      </div>
      ${data.canMute ? '' : '<div class="hint" style="margin-top:-6px">No mute plugin found (EssentialsX, LiteBans, AdvancedBan or CMI), so "Mute" kicks instead.</div>'}
      <div class="md-ladder mt-16">
        <label class="field"><span>Mute for (minutes)</span><input type="number" id="md-mute" min="1" max="1440" value="${s.muteMinutes}" /></label>
        <label class="field"><span>Ban for (hours)</span><input type="number" id="md-ban" min="1" max="720" value="${s.banHours}" /></label>
        <label class="field"><span>Forget strikes after (hours)</span><input type="number" id="md-forget" min="1" max="720" value="${s.forgetHours}" /></label>
      </div>
      <label class="field"><span>Never moderate</span>
        <input id="md-exempt" value="${esc(s.exempt.join(', '))}" placeholder="Staff names, comma separated" />
      </label>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="md-save">Save</button></div>
    </div>
    ${
      data.tempBans.length
        ? `<div class="card mt-16">
      <h4 style="margin:0 0 8px">Temporary bans</h4>
      <div class="list">${data.tempBans
        .map(
          (b) => `<div class="list-row"><div class="grow"><div class="title">${esc(b.name)}</div>
            <div class="sub">${esc(b.reason || '')} · ${b.until ? `until ${fmtTime(b.until)}` : 'lifted when the server is next running'}</div></div>
            <button class="btn btn-sm" data-lift="${esc(b.name)}">Lift</button></div>`
        )
        .join('')}</div>
    </div>`
        : ''
    }`;

  const syncLinks = () => box.querySelector('#md-allow-wrap').classList.toggle('hidden', !box.querySelector('#md-links').checked);
  box.querySelector('#md-links').addEventListener('change', syncLinks);
  syncLinks();

  const save = async (btn) => {
    const steps = [...box.querySelectorAll('[data-step]')].map((el) => el.value);
    // "Same as before" ends the ladder.
    const cut = steps.findIndex((v, i) => i && !v);
    const body = {
      enabled: box.querySelector('#md-on').checked,
      words: box.querySelector('#md-words').value,
      links: box.querySelector('#md-links').checked,
      allowDomains: box.querySelector('#md-allow').value,
      caps: box.querySelector('#md-caps').checked,
      spam: box.querySelector('#md-spam').checked,
      ladder: cut === -1 ? steps : steps.slice(0, cut),
      muteMinutes: Number(box.querySelector('#md-mute').value),
      banHours: Number(box.querySelector('#md-ban').value),
      forgetHours: Number(box.querySelector('#md-forget').value),
      exempt: box.querySelector('#md-exempt').value,
    };
    if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/servers/${server.id}/moderation`, { method: 'PUT', body });
      toast(r.settings.enabled ? 'Chat moderation is on' : 'Chat moderation is off');
    } catch (err) {
      toast(err.message, 'error');
    }
    if (btn) btn.disabled = false;
  };
  box.querySelector('#md-save').addEventListener('click', (e) => save(e.currentTarget));
  box.querySelector('#md-on').addEventListener('change', () => save());
  box.querySelectorAll('[data-lift]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${server.id}/moderation/bans/${encodeURIComponent(btn.dataset.lift)}`, { method: 'DELETE' });
        toast(`Lifted the ban on ${btn.dataset.lift}`);
        renderModeration(box, server);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}
