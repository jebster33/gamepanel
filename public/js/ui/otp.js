/* ------------------------------------------------- six-digit code entry */

/*
 * The authenticator-code boxes used by sign-in and by two-factor setup.
 * On success the digits swirl into a phone that ticks; on a wrong code the
 * row shakes and clears. The markup is static in index.html for sign-in and
 * comes from otpMarkup() on the account page.
 */

export function otpMarkup() {
  const digit = (i) =>
    `<input class="otp-digit" inputmode="numeric" maxlength="1" ${i === 0 ? 'autocomplete="one-time-code"' : ''} aria-label="Digit ${i + 1}" style="--i:${i}" />`;
  return `
    <div class="otp-wrap" data-otp-pane="app">
      <div class="otp-row">${[0, 1, 2].map(digit).join('')}<span class="otp-gap"></span>${[3, 4, 5].map(digit).join('')}</div>
      <svg class="otp-phone" viewBox="0 0 80 120" aria-hidden="true">
        <rect class="otp-phone-body" x="14" y="4" width="52" height="104" rx="10" />
        <rect class="otp-phone-screen" x="18" y="12" width="44" height="88" rx="6" />
        <rect class="otp-phone-notch" x="33" y="8" width="14" height="3" rx="1.5" />
        <circle class="otp-phone-ring" cx="40" cy="56" r="14" />
        <path class="otp-phone-check" d="M33 56.5l5 5 9.5-10.5" />
      </svg>
    </div>`;
}

/**
 * Wire the boxes inside `root`. `onCode(code)` runs once all six are filled
 * and should resolve true (accepted) or false (wrong code).
 */
export function wireOtp(root, onCode) {
  const digits = [...root.querySelectorAll('.otp-digit')];
  let busy = false;

  const code = () => digits.map((d) => d.value).join('');
  const fill = (text, from = 0) => {
    const chars = String(text).replace(/\D/g, '').split('');
    chars.forEach((c, k) => {
      if (digits[from + k]) digits[from + k].value = c;
    });
    const next = Math.min(from + chars.length, digits.length - 1);
    digits[next].focus();
    maybeSubmit();
  };

  async function maybeSubmit() {
    if (busy || code().length !== digits.length) return;
    busy = true;
    digits.forEach((d) => d.blur());
    root.classList.add('checking');
    let ok = false;
    try {
      ok = await onCode(code());
    } finally {
      root.classList.remove('checking');
    }
    if (ok) return; // the caller plays the success animation
    root.classList.remove('shake');
    void root.offsetWidth; // restart the animation
    root.classList.add('shake');
    setTimeout(() => {
      root.classList.remove('shake');
      digits.forEach((d) => (d.value = ''));
      digits[0].focus();
      busy = false;
    }, 420);
  }

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      const value = input.value.replace(/\D/g, '');
      input.value = '';
      if (value) fill(value, i);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].value = '';
        digits[i - 1].focus();
        event.preventDefault();
      } else if (event.key === 'ArrowLeft' && i > 0) digits[i - 1].focus();
      else if (event.key === 'ArrowRight' && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener('paste', (event) => {
      event.preventDefault();
      fill(event.clipboardData.getData('text'), i);
    });
    input.addEventListener('focus', () => input.select());
  });

  return {
    focus: () => digits[0]?.focus(),
    reset() {
      busy = false;
      root.classList.remove('success', 'shake', 'checking');
      digits.forEach((d) => {
        d.value = '';
        d.style.removeProperty('--dx');
        d.style.removeProperty('--dy');
      });
    },
    /** Swirl the digits into the phone and tick it. Resolves when it is done. */
    success() {
      const wrap = root.querySelector('.otp-wrap');
      const box = wrap.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      for (const d of digits) {
        const r = d.getBoundingClientRect();
        // Each digit turns around the centre of the row, so together they spiral into it.
        d.style.setProperty('--dx', `${cx - (r.left + r.width / 2)}px`);
        d.style.setProperty('--dy', `${cy - (r.top + r.height / 2)}px`);
      }
      root.classList.add('success');
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      return new Promise((resolve) => setTimeout(resolve, reduced ? 300 : 1750));
    },
  };
}
