import { api } from '../core/api.js';
import { loadServers } from '../core/boot.js';
import { state } from '../core/state.js';
import { $, $$, can, esc, gameArt, toast } from '../core/util.js';
import { openModal } from '../ui/modal.js';

/* ------------------------------------------------------ ready-made setups */

// A game plus its plugins, settings and schedules, deployed in one click.
// Shown above the games on the Games page.

export async function renderSetups(host) {
  if (!host || !(state.user.role === 'admin' || can('deploy'))) return;
  const data = await api('/api/setups').catch(() => ({ setups: [] }));
  const setups = data.setups.filter((s) => state.user.role === 'admin' || !s.adminOnly);
  if (!setups.length || !host.isConnected) return;
  host.innerHTML = `
    <div class="section-head"><h2>Ready-made setups</h2><span class="faint">A game with its plugins, settings and schedules, in one click.</span></div>
    <div class="grid-cards setup-grid">${setups
      .map(
        (s) => `
      <div class="tile-card game-card setup-card">
        <div class="g-art">${gameArt({ icon: s.icon, logo: s.logo, storeAppId: s.storeAppId }, { wide: true })}</div>
        <div class="t-head"><div class="min-w-0"><h3>${esc(s.name)}</h3><div class="t-meta">${esc(s.templateName)}</div></div></div>
        <p>${esc(s.description)}</p>
        <div class="t-foot">
          ${s.includes.map((i) => `<span class="badge">${esc(i)}</span>`).join('')}
          ${s.custom && state.user.role === 'admin' ? `<button class="btn btn-sm btn-ghost btn-danger" data-setup-delete="${esc(s.id)}" title="Delete this setup">Delete</button>` : ''}
          <button class="btn btn-sm btn-primary" data-setup="${esc(s.id)}">Deploy</button>
        </div>
      </div>`
      )
      .join('')}</div>`;
  $$('[data-setup]', host).forEach((btn) => btn.addEventListener('click', () => openSetupModal(setups.find((s) => s.id === btn.dataset.setup))));
  $$('[data-setup-delete]', host).forEach((btn) =>
    btn.addEventListener('click', async () => {
      const setup = setups.find((s) => s.id === btn.dataset.setupDelete);
      const { confirmModal } = await import('../ui/modal.js');
      if (!(await confirmModal('Delete setup', `Delete the setup "${setup.name}"? Servers made from it are not touched.`, 'Delete'))) return;
      await api(`/api/setups/${encodeURIComponent(setup.id)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      renderSetups(host);
    })
  );
}

function openSetupModal(setup) {
  const modal = openModal({
    title: `Deploy ${esc(setup.name)}`,
    width: 540,
    body: `
      <p class="faint" style="margin-top:0">${esc(setup.description)}</p>
      <div class="form-grid">
        <label><span>Server name</span><input id="su-name" value="${esc(setup.name)}" maxlength="60" /></label>
        <label><span>Memory (MB)</span><input id="su-memory" type="number" min="512" step="512" value="${setup.memory}" /></label>
      </div>
      <div class="hint">The game installs first; the plugins, settings and schedules are added when it finishes. Watch the console.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Deploy',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Creating…';
          try {
            const { server } = await api(`/api/setups/${encodeURIComponent(setup.id)}/deploy`, { method: 'POST', body: { name: $('#su-name').value, memory: Number($('#su-memory').value) } });
            await loadServers();
            modal.close();
            toast(`${server.name} created. Installing now.`);
            location.hash = `#/servers/${server.id}/console`;
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Deploy';
          }
        },
      },
    ],
  });
}
