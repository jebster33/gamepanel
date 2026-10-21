import { api } from '../../core/api.js';
import { $, esc, fmtTime, toast } from '../../core/util.js';
import { renderMarkdown } from '../../ui/markdown.js';

/* ----------------------------------------------------------- server notes */

const STARTER = `## Rules
- 

## Wipe plan
- [ ] 

## Passwords to rotate
- 
`;

export async function renderNotesTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span></div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/notes`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }

  const view = () => {
    const meta = data.updatedAt ? `Last changed by ${esc(data.updatedBy || 'someone')} ${esc(fmtTime(data.updatedAt))}` : 'Nothing written yet';
    host.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
          <h4 style="margin:0">Notes</h4>
          ${data.canEdit ? '<button class="btn btn-sm" id="notes-edit">Edit</button>' : ''}
        </div>
        <div class="md">${data.text ? renderMarkdown(data.text) : `<span class="faint">${data.canEdit ? 'Rules, wipe plans, things to remember. Everyone with access to this server can read these notes.' : 'No notes for this server yet.'}</span>`}</div>
        <div class="hint mt-8">${meta}</div>
      </div>`;
    $('#notes-edit')?.addEventListener('click', edit);
  };

  const edit = () => {
    host.innerHTML = `
      <div class="card">
        <h4>Edit notes</h4>
        <textarea id="notes-text" rows="18" spellcheck="true" style="width:100%;font-family:var(--mono, monospace)"></textarea>
        <div class="hint mt-8">Markdown: # headings, **bold**, - lists, - [ ] tasks, \`code\`, [links](https://…). Everyone with access to this server can read these notes, so keep real passwords elsewhere.</div>
        <div class="row mt-8" style="gap:8px"><button class="btn btn-primary" id="notes-save">Save</button><button class="btn" id="notes-cancel">Cancel</button></div>
      </div>`;
    const box = $('#notes-text');
    box.value = data.text || STARTER;
    box.focus();
    $('#notes-cancel').addEventListener('click', view);
    $('#notes-save').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const saved = await api(`/api/servers/${server.id}/notes`, { method: 'PUT', body: { notes: box.value, basedOn: data.updatedAt } });
        data = { ...data, ...saved };
        toast('Notes saved');
        view();
      } catch (err) {
        toast(err.message, 'error');
        event.currentTarget.disabled = false;
      }
    });
  };

  view();
}
