// Live breathing trace along the bottom of the stage: the last 40 s of the
// normalised chest signal, older part in muted ink, last few seconds in molten.

const WINDOW_MS = 40_000;
const HOT_MS = 8_000;

export function createTrace(canvas) {
  const ctx = canvas.getContext('2d');
  const points = []; // { t, v }
  let raf = 0;
  let dirty = true;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function push(t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    if (points.length && t <= points[points.length - 1].t) return;
    points.push({ t, v: Math.max(-1.3, Math.min(1.3, v)) });
    const cutoff = t - WINDOW_MS - 1000;
    while (points.length && points[0].t < cutoff) points.shift();
    dirty = true;
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!dirty) return;
    dirty = false;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (points.length < 2) return;
    const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 64;
    const now = points[points.length - 1].t;
    const x = (t) => gutter + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (w - gutter * 2);
    const y = (v) => h * 0.55 - v * h * 0.36;
    const line = (from, colour, width) => {
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        if (p.t < from.start || p.t > from.end) continue;
        const px = x(p.t);
        if (px < gutter - 1) continue;
        if (!started) { ctx.moveTo(px, y(p.v)); started = true; } else ctx.lineTo(px, y(p.v));
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    };
    line({ start: now - WINDOW_MS, end: now - HOT_MS + 40 }, 'rgba(185, 171, 152, 0.55)', 2.5);
    line({ start: now - HOT_MS, end: now }, '#ff7b1c', 4);
    const last = points[points.length - 1];
    ctx.fillStyle = '#ff7b1c';
    ctx.beginPath();
    ctx.arc(x(last.t), y(last.v), 7, 0, Math.PI * 2);
    ctx.fill();
  }
  raf = requestAnimationFrame(draw);

  return {
    push,
    clear() { points.length = 0; dirty = true; },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
