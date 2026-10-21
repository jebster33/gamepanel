import { api } from '../../core/api.js';
import { $, esc, toast } from '../../core/util.js';

/**
 * Welcome mode and the rotating message of the day, under the chat
 * announcements card. {player} {server} {online} work in every message.
 */
export function renderCommunityMessages(host, server) {
  const chat = server.playerCommands?.length || (server.templateId || '').startsWith('minecraft');
  if (!chat || !host) return;
  const java = (server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
  const motd = server.motd || {};
  const card = document.createElement('div');
  card.className = 'card mt-16';
  card.innerHTML = `
    <div class="card-head"><h4>Welcome and message of the day</h4></div>
    <p class="faint" style="margin:0 0 10px">Messages can use <code>{player}</code>, <code>{server}</code> and <code>{online}</code>. The welcome text itself is set in the card above.</p>
    <div class="checkbox-row"><input type="checkbox" id="cm-every" ${server.welcome?.mode === 'every' ? 'checked' : ''} /><label for="cm-every">Welcome players every time they join, not only the first time</label></div>
    ${
      java
        ? `<div class="checkbox-row mt-16"><input type="checkbox" id="cm-motd-on" ${motd.enabled ? 'checked' : ''} /><label for="cm-motd-on">Rotate the server-list message (MOTD)</label></div>
    <textarea id="cm-motd" rows="3" maxlength="2500" placeholder="&amp;aWelcome to {server}&#10;&amp;e{online} players online now">${esc((motd.messages || []).join('\n'))}</textarea>
    <div class="row mt-16" style="gap:8px;align-items:center">
      <span class="faint">Change every</span>
      <select id="cm-every-min" style="width:auto">${[15, 30, 60, 180, 360, 720, 1440].map((n) => `<option value="${n}" ${(motd.everyMinutes || 60) === n ? 'selected' : ''}>${n >= 60 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} minutes`}</option>`).join('')}</select>
      <select id="cm-order" style="width:auto"><option value="rotate">In order</option><option value="random" ${motd.order === 'random' ? 'selected' : ''}>Random</option></select>
    </div>
    <p class="faint" style="margin:8px 0 0">Use &amp;a, &amp;e ... for colours. Minecraft reads the MOTD when it starts, so a new line shows after the next restart (right away while a wake-on-join server sleeps).</p>`
        : ''
    }
    <div class="row mt-16"><button class="btn btn-sm" id="cm-save">Save</button></div>`;
  host.appendChild(card);
  $('#cm-save', card).addEventListener('click', async () => {
    const body = { welcome: { enabled: $('#an-welcome')?.checked ?? Boolean(server.welcome?.enabled), message: $('#an-welcome-msg')?.value ?? server.welcome?.message ?? '', mode: $('#cm-every', card).checked ? 'every' : 'first' } };
    if (java) body.motd = { enabled: $('#cm-motd-on', card).checked, messages: $('#cm-motd', card).value.split('\n'), everyMinutes: Number($('#cm-every-min', card).value), order: $('#cm-order', card).value };
    try {
      const out = await api(`/api/servers/${server.id}/community-messages`, { method: 'PUT', body });
      server.welcome = out.welcome;
      server.motd = out.motd;
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
