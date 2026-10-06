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

/* ------------------------------------------------------------- live map */

/* BlueMap: a 3D map of the world in the browser, on a port of its own. */
export async function renderMapCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/map`);
  } catch {
    return;
  }
  if (!info.supported || !host.isConnected) return;
  const on = info.installed && info.port;
  const url = on ? `http://${location.hostname}:${info.port}` : '';
  host.innerHTML = `
    <div class="card mb-16 row" style="align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-size:26px">🗺️</div>
      <div style="flex:1;min-width:220px">
        <h4 style="margin:0 0 4px">Live map ${on ? '<span class="badge accent">On</span>' : ''}</h4>
        <div class="faint" style="font-size:13px">${
          on
            ? `A 3D map of the world at <a href="${esc(url)}" target="_blank" rel="noopener" class="mono">${esc(url)}</a>. The first render takes a while on a big world. Open TCP ${info.port} so friends can see it.`
            : "Installs BlueMap: a 3D map of your world anyone can open in a browser. BlueMap downloads Minecraft's textures from Mojang, so turning it on means you accept Mojang's EULA for that download."
        }</div>
      </div>
      ${on ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open map</a>` : ''}
      ${can('settings') ? `<button class="btn ${on ? 'btn-ghost' : 'btn-primary'}" id="map-toggle">${on ? 'Turn off' : 'Turn on'}</button>` : ''}
    </div>`;
  host.querySelector('#map-toggle')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    try {
      const r = await api(`/api/servers/${server.id}/map`, { method: 'POST', body: { enabled: !on } });
      toast(r.restartNeeded ? 'Done. Restart the server to apply it.' : on ? 'Live map turned off' : 'Live map is ready. Start the server.');
      renderMapCard(host, server);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = on ? 'Turn off' : 'Turn on';
    }
  });
}
