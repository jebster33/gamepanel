import { api } from '../../core/api.js';
import { esc, toast, can } from '../../core/util.js';
import { state } from '../../core/state.js';

/* ------------------------------------------------------- JVM flag presets */

/*
 * One-click Java flags for Minecraft servers. The Memory setting still sets
 * -Xms/-Xmx; presets only add garbage-collector and tuning flags, some sized
 * from that memory. Takes effect on the next start. Administrators only.
 */

export async function renderJvmCard(host, server) {
  if (!can('settings')) return;
  let v;
  try {
    v = await api(`/api/servers/${server.id}/jvm`);
  } catch {
    return;
  }
  if (!v.supported) return;
  const admin = state.user?.role === 'admin';
  let pick = v.preset;
  const draw = () => {
    const cur = v.presets.find((p) => p.id === pick);
    host.innerHTML = `
      <div class="card mb-16">
        <h4 style="margin:0 0 4px">Java flags</h4>
        <div class="faint" style="font-size:13px;margin-bottom:10px">Memory is set from the server's Memory setting (<span class="mono">${esc(v.memoryFlags)}</span>). Pick a preset for the rest; it applies on the next start.</div>
        <div class="mcjvm-list" role="radiogroup" aria-label="Java flag preset">
          ${v.presets
            .map(
              (p) => `<label class="mcjvm-opt ${pick === p.id ? 'sel' : ''}"><input type="radio" name="jvm" value="${esc(p.id)}" ${pick === p.id ? 'checked' : ''} ${admin ? '' : 'disabled'} />
                <span><b>${esc(p.name)}</b><br /><span class="faint" style="font-size:12.5px">${esc(p.line)}</span>${p.warn ? `<br /><span class="amber" style="font-size:12.5px">${esc(p.warn)}</span>` : ''}</span></label>`
            )
            .join('')}
          <label class="mcjvm-opt ${pick === 'custom' ? 'sel' : ''}"><input type="radio" name="jvm" value="custom" ${pick === 'custom' ? 'checked' : ''} ${admin ? '' : 'disabled'} /><span><b>Custom</b><br /><span class="faint" style="font-size:12.5px">Your own flags. Memory flags (-Xms, -Xmx) are not allowed here.</span></span></label>
        </div>
        <label class="field mt-8"><span>${pick === 'custom' ? 'Flags' : 'Flags this preset sets'}</span><textarea id="jvm-flags" rows="3" class="mono" ${pick === 'custom' && admin ? '' : 'readonly'} spellcheck="false">${esc(pick === 'custom' ? v.current : cur?.flags ?? '')}</textarea></label>
        ${admin ? '<div class="row" style="justify-content:flex-end"><button class="btn btn-sm btn-primary" id="jvm-apply">Apply</button></div>' : '<div class="faint" style="font-size:12.5px">Only administrators can change Java flags.</div>'}
      </div>`;
    host.querySelectorAll('input[name=jvm]').forEach((r) =>
      r.addEventListener('change', () => {
        if (pick === 'custom') v.current = host.querySelector('#jvm-flags').value;
        pick = r.value;
        draw();
      })
    );
    host.querySelector('#jvm-apply')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        v = await api(`/api/servers/${server.id}/jvm`, { method: 'PUT', body: { preset: pick, custom: host.querySelector('#jvm-flags').value } });
        pick = v.preset;
        toast('Saved. Restart the server to use the new flags.');
        draw();
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });
  };
  draw();
}
