// Dashboard hero: a grid of 2D squares that slowly fade in and out,
// lime to transparent, thinning and shrinking toward the bottom edge so
// the grid breaks up into the page instead of ending in a hard fade.

const CELL = 28;
const HEIGHT = 240;
const FRAME_MS = 50;

function hash(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function mountHero(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0;
  let h = 0;
  let rgb = '198,244,50';
  let lastColor = 0;
  let last = 0;

  const readColor = (now) => {
    if (now - lastColor < 1000 && lastColor) return;
    lastColor = now;
    const cs = getComputedStyle(canvas);
    const light = document.documentElement.dataset.theme === 'light';
    const c = (cs.getPropertyValue(light ? '--lime-text' : '--lime') || '#c6f432').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(',');
  };

  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (now) => {
    readColor(now);
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    for (let j = 0; j < rows; j++) {
      const v = j / rows; // 0 top .. 1 bottom
      const keep = 1 - v * v; // chance a square exists at this depth
      for (let i = 0; i < cols; i++) {
        const a = hash(i, j);
        if (a > keep) continue;
        const b = hash(j + 91, i + 17);
        // slow, per-square breathing: ~12-30s cycles
        const wave = 0.5 + 0.5 * Math.sin(t * (0.2 + b * 0.3) + a * 40);
        const alpha = wave * wave * 0.2 * (1 - v * 0.7);
        if (alpha < 0.012) continue;
        const s = (CELL - 6) * (1 - v * 0.45);
        const off = (CELL - s) / 2;
        ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx.fillRect(i * CELL + off, j * CELL + off, s, s);
      }
    }
  };

  const loop = (now) => {
    if (!canvas.isConnected) return;
    if (!document.hidden && now - last >= FRAME_MS) {
      last = now;
      draw(now);
    }
    if (!reduce.matches) requestAnimationFrame(loop);
  };

  size();
  const ro = new ResizeObserver(() => {
    size();
    if (reduce.matches) draw(performance.now());
  });
  ro.observe(canvas);
  if (reduce.matches) draw(2000);
  else requestAnimationFrame(loop);
}

export const HERO_HEIGHT = HEIGHT;
