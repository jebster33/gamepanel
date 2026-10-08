import { $ } from '../core/util.js';

/* ----------------------------------------------------------- interactions */

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One delegated pointer listener drives every cursor spotlight: find the
 * hovered `.spot` element and hand it the pointer position as percentages.
 * Coalesced into a rAF so a fast mouse cannot outpace the compositor.
 */
let spotTarget = null;
let spotEvent = null;
let spotQueued = false;

document.addEventListener(
  'pointermove',
  (event) => {
    const el = event.target.closest?.('.spot');
    spotTarget = el;
    spotEvent = event;
    if (!el || spotQueued) return;
    spotQueued = true;
    requestAnimationFrame(() => {
      spotQueued = false;
      if (!spotTarget || !spotEvent) return;
      const rect = spotTarget.getBoundingClientRect();
      spotTarget.style.setProperty('--mx', `${((spotEvent.clientX - rect.left) / rect.width) * 100}%`);
      spotTarget.style.setProperty('--my', `${((spotEvent.clientY - rect.top) / rect.height) * 100}%`);
    });
  },
  { passive: true }
);

/** Stagger the entrance of a freshly rendered view, cheaply and once. */
export function revealChildren(root, selector = ':scope > *') {
  if (reducedMotion || !root) return;
  const nodes = [...root.querySelectorAll(selector)].slice(0, 14);
  nodes.forEach((node, i) => {
    node.style.setProperty('--i', String(i));
    node.classList.remove('reveal');
    // Force a reflow so re-renders replay the animation instead of skipping it.
    void node.offsetWidth;
    node.classList.add('reveal');
  });
}

/** Count a number up on first paint — only for values that do not tick. */
export function countUp(el, target, duration = 700) {
  if (!el) return;
  const end = Number(target) || 0;
  // A hidden tab never fires requestAnimationFrame, so never animate into it —
  // the value would sit at zero until the next poll.
  if (reducedMotion || end === 0 || document.hidden) {
    el.textContent = String(end);
    return;
  }
  const started = performance.now();
  let finished = false;
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    // easeOutExpo keeps the last digits from crawling
    const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
    el.textContent = String(Math.round(end * eased));
    if (progress < 1) requestAnimationFrame(step);
    else finished = true;
  };
  requestAnimationFrame(step);
  // Backstop: some environments throttle rAF to a standstill (background tab,
  // remote/offscreen rendering). Never leave the number stuck mid-count.
  setTimeout(() => {
    if (!finished) el.textContent = String(end);
  }, duration + 400);
}

/** A short sideways shake: "that didn't work", without moving anything else. */
export function shake(el) {
  if (reducedMotion || !el?.animate) return;
  el.animate(
    [{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }],
    { duration: 360, easing: 'ease-out' }
  );
}

/** Let a live value glow for a moment when it changes. */
export function flash(el) {
  if (reducedMotion || !el) return;
  el.classList.remove('tick');
  void el.offsetWidth;
  el.classList.add('tick');
}

/** Fade an element out before it is swapped away; resolves straight away without motion. */
export function fadeAway(el, duration = 220) {
  if (reducedMotion || !el?.animate) return Promise.resolve();
  const anim = el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(0.98)' }],
    { duration, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
  );
  // A background tab can stall the animation: never hold up signing in.
  return Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, duration + 150))]).then(() => anim);
}
