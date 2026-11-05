// Hand-held view of a finished vessel on the glass canvas. Drag in any direction
// to tumble it (a trackball: tip it right over to see the foot or the mouth), flick
// to keep it rolling, scroll to zoom, double-click to set it back upright.
// Keys when the canvas has focus: arrows turn, + and - zoom, 0 resets.
const RAD_PER_PX = 0.009;
const KEY_TURN = 0.3;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{grab:()=>boolean, turn:(yaw:number,pitch:number)=>void, release:(vx:number,vy:number)=>void,
 *          zoomBy:(f:number)=>void, resetView:()=>void}} stage
 * @param {{onGrab?:()=>void, onRelease?:()=>void}} [hooks]
 */
export function createTurntable(canvas, stage, { onGrab, onRelease } = {}) {
  let enabled = false;
  let drag = null; // { id, x, y, t, vx, vy }

  function setEnabled(on) {
    enabled = !!on;
    canvas.classList.toggle('turnable', enabled);
    if (enabled) {
      canvas.tabIndex = 0;
      canvas.setAttribute('aria-label', 'Glass vessel. Drag or use the arrow keys to turn it, scroll or plus and minus to zoom, double-click or 0 to reset.');
    } else {
      canvas.removeAttribute('tabindex');
      canvas.setAttribute('aria-label', 'Glass vessel');
      if (drag) end();
    }
  }

  function end(e) {
    if (!drag) return;
    const still = e && performance.now() - drag.t > 80; // paused before letting go: no flick
    stage.release(still ? 0 : drag.vx, still ? 0 : drag.vy);
    try { canvas.releasePointerCapture(drag.id); } catch { /* already released */ }
    drag = null;
    canvas.classList.remove('grabbing');
    onRelease?.();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!enabled || drag || e.button !== 0) return;
    if (!stage.grab()) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    canvas.classList.add('grabbing');
    onGrab?.();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const yaw = (e.clientX - drag.x) * RAD_PER_PX;
    const pitch = (e.clientY - drag.y) * RAD_PER_PX;
    stage.turn(yaw, pitch);
    const dt = Math.max(1, now - drag.t) / 1000;
    drag.vx = drag.vx * 0.6 + (yaw / dt) * 0.4;
    drag.vy = drag.vy * 0.6 + (pitch / dt) * 0.4;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, (e) => { if (drag && e.pointerId === drag.id) end(e); });
  }

  canvas.addEventListener('wheel', (e) => {
    if (!enabled) return;
    e.preventDefault();
    stage.zoomBy(Math.exp(-e.deltaY * 0.0015));
    onGrab?.();
    onRelease?.();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    if (!enabled) return;
    stage.resetView();
  });

  canvas.addEventListener('keydown', (e) => {
    if (!enabled) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); stage.zoomBy(1.15); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); stage.zoomBy(1 / 1.15); return; }
    if (e.key === '0' || e.key === 'Home') { e.preventDefault(); stage.resetView(); return; }
    const k = { ArrowLeft: [-KEY_TURN, 0], ArrowRight: [KEY_TURN, 0], ArrowUp: [0, -KEY_TURN], ArrowDown: [0, KEY_TURN] }[e.key];
    if (!k || !stage.grab()) return;
    e.preventDefault();
    onGrab?.();
    stage.turn(k[0], k[1]);
    stage.release(0, 0);
    onRelease?.();
  });

  return { setEnabled };
}
