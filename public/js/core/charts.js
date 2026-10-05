import { $ } from './util.js';

/* ---------------------------------------------------------------- charts */

/** Accept #rrggbb or any CSS colour and return it with an alpha channel. */
function hexAlpha(color, alpha) {
  const value = String(color).trim();
  if (value.startsWith('#') && (value.length === 7 || value.length === 4)) {
    const full =
      value.length === 4 ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
    const r = parseInt(full.slice(1, 3), 16);
    const g = parseInt(full.slice(3, 5), 16);
    const b = parseInt(full.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return value;
}

export function drawChart(canvas, series, options = {}) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 120;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const data = series.filter((n) => Number.isFinite(n));
  if (data.length < 2) {
    ctx.fillStyle = 'rgba(148,163,184,.35)';
    ctx.font = '12px system-ui';
    ctx.fillText('Collecting data…', 10, height / 2);
    return;
  }

  const color = options.color || '#4ade80';
  const pad = options.pad ?? 4;
  const max = options.max ?? Math.max(...data, 1) * 1.15;
  const min = options.min ?? 0;
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);
  const yFor = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

  // grid
  if (options.grid !== false) {
    ctx.strokeStyle = 'rgba(148,163,184,.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  const path = new Path2D();
  data.forEach((value, i) => {
    const x = pad + i * stepX;
    const y = yFor(value);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });

  const fill = new Path2D(path);
  fill.lineTo(pad + (data.length - 1) * stepX, height);
  fill.lineTo(pad, height);
  fill.closePath();

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, hexAlpha(color, 0.22));
  gradient.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fill(fill);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
}
