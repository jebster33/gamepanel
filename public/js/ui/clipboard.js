import { $, toast } from '../core/util.js';

/**
 * navigator.clipboard only exists on secure origins, and the panel is usually
 * reached over plain http on a LAN address — so fall back to the old
 * execCommand path instead of silently doing nothing.
 */
export async function copyToClipboard(text, sourceEl) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    scratch.remove();
  }

  if (ok) {
    toast(`Copied ${text}`);
    // Brief inline confirmation on the element itself.
    if (sourceEl && !sourceEl.dataset.copying) {
      const original = sourceEl.textContent;
      sourceEl.dataset.copying = '1';
      sourceEl.classList.add('copied');
      sourceEl.textContent = 'Copied';
      setTimeout(() => {
        sourceEl.textContent = original;
        sourceEl.classList.remove('copied');
        delete sourceEl.dataset.copying;
      }, 1100);
    }
  } else if (sourceEl) {
    // Last resort: select it so the user only has to press Ctrl+C.
    const range = document.createRange();
    range.selectNodeContents(sourceEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Selected the address — press Ctrl+C to copy', 'warn');
  } else {
    toast('Could not copy to the clipboard', 'warn');
  }
}
