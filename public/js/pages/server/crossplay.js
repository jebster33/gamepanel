import { api } from '../../core/api.js';
import { esc, toast, can } from '../../core/util.js';

/* ---------------------------------------------------- Bedrock crossplay */

/* Geyser + Floodgate on Paper/Purpur, so phone, console and Windows Bedrock players can join. */

export async function renderCrossplayCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/crossplay`);
  } catch {
    return;
  }
  if (!info.supported) return;
  const on = info.geyser && info.port;
  const addr = `${location.hostname}`;
  host.innerHTML = `
    <div class="card mb-16 row" style="align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-size:26px">📱</div>
      <div style="flex:1;min-width:220px">
        <h4 style="margin:0 0 4px">Bedrock crossplay ${on ? '<span class="badge accent">On</span>' : ''}</h4>
        <div class="faint" style="font-size:13px">${
          on
            ? `Phone, console and Windows players join at <span class="mono">${esc(addr)}</span> port <span class="mono">${info.port}</span> (UDP). They do not need a Java account. Open UDP ${info.port} in your firewall on the Settings tab.`
            : 'Let Bedrock players (phones, Xbox, PlayStation, Switch, Windows) join this Java server. Installs Geyser and Floodgate and gives them their own port.'
        }</div>
      </div>
      ${can('settings') ? `<button class="btn ${on ? 'btn-ghost' : 'btn-primary'}" id="cp-toggle">${on ? 'Turn off' : 'Turn on'}</button>` : ''}
    </div>`;
  host.querySelector('#cp-toggle')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    try {
      const r = await api(`/api/servers/${server.id}/crossplay`, { method: 'POST', body: { enabled: !on } });
      toast(r.restartNeeded ? 'Done. Restart the server to apply it.' : on ? 'Crossplay turned off' : 'Crossplay is ready. Start the server.');
      renderCrossplayCard(host, server);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = on ? 'Turn off' : 'Turn on';
    }
  });
}
