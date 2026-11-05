// The glass stage: renderer, scene, animation loop and the public Glass API
// (see build-notes/CONTRACT.md).
import * as THREE from 'three';
import {
  buildProfile, wallProfile, profileHeight, profileMaxR, makeRecipe, parseRecipe,
  normalizeBreath, normalizeFinish, PROFILE_POINTS,
} from './vessel-profile.js';
import { createParticles, KIND } from './particles.js';
import { paletteFor } from './palette.js';
import { createLathe, updateLathe } from './lathe.js';
import { createStudioEnvironment } from './env.js';
import {
  createGlassMaterial, createHaloMaterial, createShadowMaterial,
  createPipeMaterial, createPipeGeometry, GLOW_SAMPLES,
} from './materials.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c1 = 1.2, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

const FOV = 26;
const CAM = new THREE.Vector3(0, 1.9, 10);
const TILT = 0.05; // pipe angled slightly up toward the gaffer
const CUT_MS = 4000;
const WALL_POINTS = PROFILE_POINTS * 2 + 2;
const FINISH_TYPE = { gold: 1, crackle: 2, opal: 3 };
const EMBER_RATE = 3; // per second
const STEAM_RATE = 6; // puffs per second while the glass cools
const STEAM_MS = [350, 3300]; // window inside the cut when steam rises

export function createGlassStage(canvas, { reducedMotion = false } = {}) {
  if (!canvas) throw new Error('createGlassStage needs a canvas');
  let rm = !!reducedMotion;

  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // With WEBGL_multisampled_render_to_texture (mostly mobile/XR GPUs) three skips the
  // back-face transmission pass, so the vessel's far wall would vanish. Hide the
  // extension from three so it always takes the normal multisample path.
  {
    const ext = renderer.extensions;
    const has = ext.has.bind(ext);
    ext.has = (name) => (name === 'WEBGL_multisampled_render_to_texture' ? false : has(name));
  }

  const scene = new THREE.Scene();
  const envRT = createStudioEnvironment(renderer);
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  camera.position.copy(CAM);
  camera.lookAt(0, 0, 0);

  // pivot: orientation + fit scale. spinner: rotation about the vessel axis.
  const pivot = new THREE.Group();
  const spinner = new THREE.Group();
  pivot.add(spinner);
  scene.add(pivot);

  const geometry = createLathe(WALL_POINTS, 72);
  const glass = createGlassMaterial();
  glass.material.envMap = envRT.texture; // explicit, so envMapIntensity is honoured
  glass.material.envMapIntensity = 1;
  const vessel = new THREE.Mesh(geometry, glass.material);
  vessel.frustumCulled = false;
  spinner.add(vessel);

  const halo = createHaloMaterial();
  const cardGeo = new THREE.PlaneGeometry(1, 1);
  const haloMesh = new THREE.Mesh(cardGeo, halo.material);
  haloMesh.renderOrder = 10;
  haloMesh.frustumCulled = false;
  pivot.add(haloMesh);

  const shadow = createShadowMaterial();
  const shadowMesh = new THREE.Mesh(cardGeo, shadow.material);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.renderOrder = 0;
  scene.add(shadowMesh);

  const pipeGeo = createPipeGeometry();
  const pipeMat = createPipeMaterial();
  const pipe = new THREE.Mesh(pipeGeo, pipeMat);
  pivot.add(pipe);

  const fire = new THREE.PointLight(0xff7a2a, 0, 0, 1.6);
  pivot.add(fire);

  // sparks, embers, cut glint and steam share one pool in world space
  const particles = createParticles();
  scene.add(particles.points);

  // Before the cut the glass has no colour of its own (it is molten); the palette
  // fades in only while it cools.
  const NEUTRAL = { attenuation: new THREE.Color(0xe2c7aa), tint: new THREE.Color(0x7a5a40), rim: new THREE.Color(0xf2dcc4) };
  const PAL = { attenuation: new THREE.Color(), tint: new THREE.Color(), rim: new THREE.Color() };
  function applyPalette(p) {
    PAL.attenuation.set(p.attenuation);
    PAL.tint.set(p.color);
    PAL.rim.set(p.rim);
  }
  function applyTint(m) {
    glass.material.attenuationColor.copy(NEUTRAL.attenuation).lerp(PAL.attenuation, m);
    glass.uniforms.uTint.value.copy(NEUTRAL.tint).lerp(PAL.tint, m);
    glass.uniforms.uRim.value.copy(NEUTRAL.rim).lerp(PAL.rim, m);
  }
  // Furnace heat 0..1 -> visual heat: a gather on the pipe always glows at least a dull red.
  const HEAT_FLOOR = 0.32;
  const hotHeat = (v) => HEAT_FLOOR + (1 - HEAT_FLOOR) * v;

  // ---- state ----
  const S = {
    mode: 'hot', // 'hot' | 'cutting' | 'cooled'
    breaths: [],
    live: { swell: 0, peak: 0, target: 0, depth: 0.5, active: false },
    breathSwell: 0, // current (not peak-held) swell, for the whole-gather breathing
    furnace: 1,
    heatTarget: 1,
    heat: 1,
    tintMix: 0,
    finish: 0,
    rare: null, // rare surface finish: null | 'gold' | 'crackle' | 'opal'
    embers: false,
    emberAcc: 0,
    steamAcc: 0,
    frozen: false,
    dim: 1,
    spin: 0,
    pose: 0, // 0 = on the pipe (horizontal), 1 = upright
    palette: paletteFor({ breathRate: 12, pulse: 72 }),
    display: buildProfile([]),
    finalProfile: null, // set when cooled or loaded from a recipe
    beatT: 1,
    beatStrength: 0,
    cut: null, // { t0, resolve, pipeStart: Vector3, pipeDir: Vector3 }
    fit: { s: 1, H: 1, R: 0.35 },
    time: 0,
    fps: 60,
  };
  applyPalette(S.palette);

  let viewW = 1, viewH = 1, aspect = 1, cssH = 1;
  function resize() {
    const el = canvas.parentElement || canvas;
    const w = Math.max(1, el.clientWidth || canvas.clientWidth || 1);
    const h = Math.max(1, el.clientHeight || canvas.clientHeight || 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    aspect = w / h;
    cssH = h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    particles.setScale(h * renderer.getPixelRatio(), FOV);
    viewH = 2 * CAM.length() * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    viewW = viewH * aspect;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas.parentElement || canvas);
  resize();



  function targetProfile() {
    if (S.finalProfile) return S.finalProfile;
    const live = S.mode === 'hot' && S.live.active ? { swell: Math.max(S.live.swell, S.live.peak * 0.85), depth: S.live.depth } : null;
    return buildProfile(S.breaths, { live, finish: S.finish });
  }

  // poses -------------------------------------------------------------------
  // Keep the vessel inside roughly the middle 40% of the width (UI columns live at the sides).
  // Sizes are also capped in CSS pixels so big windows (1920x1080) do not get a huge vessel.
  const px = (n) => (n * viewH) / cssH; // CSS pixels -> world units at the vessel
  const fitBlow = (H, R) => Math.min(Math.min(0.36 * viewW, px(620)) / H, Math.min(0.42 * viewH, px(330)) / (2 * R), 1.2);
  const fitUpright = (H, R) => Math.min(Math.min(0.6 * viewH, px(400)) / H, Math.min(0.36 * viewW, px(380)) / (2 * R), 1.25);

  // public API ----------------------------------------------------------------
  function setHeat(v) {
    S.furnace = clamp(Number(v) || 0, 0, 1);
    if (S.mode !== 'hot') return;
    S.heatTarget = hotHeat(S.furnace);
    if (rm) S.heat = S.heatTarget;
  }

  function breath({ chest = 0, phase = 'hold', depth = 0.5 } = {}) {
    if (S.mode !== 'hot' || S.frozen) return;
    const c = clamp(Number(chest) || 0, -1, 1);
    const s = clamp((c + 1) / 2, 0, 1);
    S.live.active = true;
    S.live.target = s;
    S.live.depth = clamp(Number(depth) || 0, 0, 1);
    void phase;
  }

  function commitBreath(b = {}) {
    if (S.mode !== 'hot' || S.frozen) return;
    S.breaths.push(normalizeBreath(b));
    S.live.peak = 0;
    S.live.swell = Math.min(S.live.swell, 0.15);
  }

  function heartbeat(strength = 1) {
    S.beatT = 0;
    S.beatStrength = clamp(Number(strength) || 0.6, 0, 1);
  }

  function setPalette({ breathRate, pulse } = {}) {
    S.palette = paletteFor({ breathRate, pulse });
    applyPalette(S.palette);
    return S.palette;
  }

  // particles ------------------------------------------------------------------
  const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();
  /** Random point on the outer wall (world space) between profile fractions u0..u1,
   *  turned to the camera side, with its outward normal in _n. */
  function surfacePoint(u0, u1) {
    const d = S.display;
    const i = clamp(Math.floor(lerp(u0, u1, Math.random()) * (d.length - 1)), 1, d.length - 2);
    const a = d[i - 1], b = d[i + 1];
    let nr = b[1] - a[1], ny = a[0] - b[0];
    const len = Math.hypot(nr, ny) || 1;
    nr /= len; ny /= len;
    let th = Math.random() * Math.PI * 2;
    for (let k = 0; k < 2; k++, th += Math.PI) {
      const cs = Math.cos(th), sn = Math.sin(th);
      _p.set(d[i][0] * cs, d[i][1], d[i][0] * sn).applyMatrix4(vessel.matrixWorld);
      _n.set(nr * cs, ny, nr * sn).transformDirection(vessel.matrixWorld);
      if (_n.dot(_c.copy(camera.position).sub(_p)) > 0) break;
    }
    return _p;
  }

  /** A burst of hot sparks off the glass (called on each committed breath). */
  function sparks(strength = 0.6) {
    if (rm || S.mode === 'cooled') return;
    const st = clamp(Number(strength) || 0, 0, 1);
    const n = Math.round(4 + 9 * st);
    vessel.updateWorldMatrix(true, false);
    for (let k = 0; k < n; k++) {
      surfacePoint(0.12, 0.85);
      const sp = (0.8 + 1.5 * Math.random()) * (0.7 + 0.5 * st);
      particles.emit(KIND.spark, _p.x, _p.y, _p.z,
        _n.x * sp + (Math.random() - 0.5) * 0.5, _n.y * sp + 0.7 + Math.random(), _n.z * sp,
        0.45 + Math.random() * 0.4, 0.04 + 0.03 * Math.random(), 0.018, 0.8 + 0.4 * st);
    }
  }

  /** Slow drift of embers rising from below and behind the glass (warm-up). */
  function embers(on) {
    S.embers = !!on;
    S.emberAcc = 0;
  }

  function spawnEmber() {
    const H = profileHeight(S.display), R = profileMaxR(S.display), s = S.fit.s;
    vessel.updateWorldMatrix(true, false);
    vessel.localToWorld(_c.set(0, H * 0.5, 0));
    const span = Math.max(H, 2 * R) * s * 1.4;
    particles.emit(KIND.ember,
      _c.x + (Math.random() - 0.5) * span, _c.y - R * s * 1.1 - Math.random() * 0.5, -0.3 - Math.random() * 0.8,
      (Math.random() - 0.5) * 0.1, 0.2 + Math.random() * 0.2, 0,
      3.5 + Math.random() * 2, 0.022 + Math.random() * 0.02, 0.018, 0.45 + Math.random() * 0.45);
  }

  function spawnSteam() {
    vessel.updateWorldMatrix(true, false);
    surfacePoint(0.35, 0.97);
    particles.emit(KIND.steam, _p.x, _p.y, _p.z,
      _n.x * 0.08 + (Math.random() - 0.5) * 0.08, 0.2 + Math.random() * 0.18, _n.z * 0.05,
      2.2 + Math.random(), 0.2 + Math.random() * 0.1, 1.0 + Math.random() * 0.4, 0.045 + Math.random() * 0.035);
  }

  /** Brief bright glint where the pipe parts from the glass. */
  function glint() {
    vessel.updateWorldMatrix(true, false);
    vessel.localToWorld(_c.set(0, profileHeight(S.display), 0));
    const dir = S.cut.pipeDir;
    // just outside the mouth on the pipe side and a touch toward the camera, so the
    // glass in front does not hide it
    _c.addScaledVector(dir, 0.1);
    _c.z += 0.2;
    particles.emit(KIND.glint, _c.x, _c.y, _c.z, 0, 0, 0, 0.26, 0.34, 0.12, 1.2);
    for (let k = 0; k < 9; k++) {
      _n.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      _n.addScaledVector(dir, -_n.dot(dir)).normalize();
      const sp = 1.6 + Math.random() * 1.6;
      particles.emit(KIND.glint, _c.x, _c.y, _c.z,
        _n.x * sp + dir.x * 0.4, _n.y * sp + dir.y * 0.4, _n.z * sp + dir.z * 0.4,
        0.14 + Math.random() * 0.22, 0.034, 0.01, 1.1);
    }
  }

  /** Rare finish shown as the glass cools: null | 'gold' | 'crackle' | 'opal'. */
  function setFinish(name) {
    S.rare = normalizeFinish(name);
    glass.uniforms.uFinishType.value = FINISH_TYPE[S.rare] || 0;
    return S.rare;
  }

  function freeze(on) {
    S.frozen = !!on;
    if (S.frozen) S.live.target = S.live.swell;
  }

  function cut() {
    if (S.mode === 'cutting') return S.cut.promise;
    if (S.mode !== 'hot') return Promise.resolve();
    S.mode = 'cutting';
    S.live.active = false;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    // pipe leaves the vessel in world space along its own axis
    pipe.updateWorldMatrix(true, false);
    scene.attach(pipe);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(pipe.quaternion).normalize();
    S.cut = { t: 0, start: performance.now(), resolve, promise, pipeStart: pipe.position.clone(), pipeDir: dir, heat0: S.heat };
    heartbeat(0.8);
    S.steamAcc = 0;
    if (rm) finishCut();
    else glint();
    return promise;
  }

  function finishCut() {
    S.finish = 1;
    S.finalProfile = buildProfile(S.breaths, { finish: 1 });
    S.pose = 1;
    S.heat = S.heatTarget = 0;
    S.tintMix = 1;
    S.mode = 'cooled';
    pipe.visible = false;
    const r = S.cut?.resolve;
    S.cut = null;
    r?.();
  }

  const snapCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
  const snapBox = new THREE.Box3();
  const tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3();
  // Offscreen snapshot: render into a float target, then a finishing pass applies the same
  // ACES + sRGB the screen gets (three skips both when rendering to a target) and writes
  // straight alpha for the PNG. The visible canvas is never resized or touched.
  let snapRT = null, snapOut = null;
  const finishMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uExposure: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; uniform float uExposure; varying vec2 vUv;
      vec3 rrt(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
      vec3 aces(vec3 c){
        const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
        const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
        c *= uExposure / 0.6;
        return clamp(outM * rrt(inM * c), 0.0, 1.0);
      }
      vec3 toSRGB(vec3 c){ return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
      void main(){
        vec4 s = texture2D(tSrc, vUv);
        float a = clamp(s.a, 0.0, 1.0);
        // The glass is not alpha-blended: it writes colour c with a low alpha into a
        // premultiplied canvas, so the screen shows c + bg * (1 - a) (glass adds light).
        // A straight-alpha PNG can only show that if alpha >= max(c), so lift alpha to fit.
        vec3 c = toSRGB(aces(max(s.rgb, 0.0)));
        float a2 = max(a, max(c.r, max(c.g, c.b)));
        gl_FragColor = vec4(a2 > 0.002 ? c / a2 : vec3(0.0), a2);
      }`,
  });
  const finishQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), finishMat);
  finishQuad.frustumCulled = false;
  const finishScene = new THREE.Scene();
  finishScene.add(finishQuad);
  const finishCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function disposeSnap() {
    snapRT?.dispose(); snapOut?.dispose();
    finishMat.dispose(); finishQuad.geometry.dispose();
  }

  /** Render the vessel tightly framed (about 85% of the image height) on transparent bg. */
  function renderSnapshot(w = 400, h = 480) {
    w = Math.max(16, Math.min(2048, Math.round(w))); h = Math.max(16, Math.min(2048, Math.round(h)));
    update(0);
    scene.updateMatrixWorld(true);
    snapBox.setFromObject(vessel, true);
    snapBox.getCenter(tmpV);
    snapBox.getSize(tmpS);
    const a = w / h, t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const fillH = tmpS.y / 0.85, fillW = Math.max(tmpS.x, tmpS.z) / 0.85;
    const dist = Math.max(fillH / (2 * t), fillW / (2 * t * a)) + tmpS.z / 2;
    snapCam.aspect = a;
    snapCam.updateProjectionMatrix();
    snapCam.position.copy(CAM).normalize().multiplyScalar(dist).add(tmpV);
    snapCam.lookAt(tmpV);

    if (!snapRT || snapRT.width !== w || snapRT.height !== h) {
      snapRT?.dispose(); snapOut?.dispose();
      snapRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      snapOut = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
    }
    const pipeWas = pipe.visible, haloWas = haloMesh.visible, fxWas = particles.points.visible;
    pipe.visible = false; haloMesh.visible = false; particles.points.visible = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(snapRT);
    renderer.clear();
    renderer.render(scene, snapCam);
    finishMat.uniforms.tSrc.value = snapRT.texture;
    finishMat.uniforms.uExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(snapOut);
    renderer.render(finishScene, finishCam);
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(snapOut, 0, 0, w, h, px);
    renderer.setRenderTarget(prev);
    pipe.visible = pipeWas; haloMesh.visible = haloWas; particles.points.visible = fxWas;

    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const ctx = c2.getContext('2d');
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row); // flip Y
    ctx.putImageData(img, 0, 0);
    return c2.toDataURL('image/png');
  }

  function snapshot(opts = {}) {
    const pngDataUrl = renderSnapshot(opts.width, opts.height);
    const profile = S.finalProfile || buildProfile(S.breaths, { finish: S.finish });
    const recipe = makeRecipe({ profile, palette: S.palette, breaths: S.breaths, finish: S.rare });
    return { pngDataUrl, recipe };
  }

  function loadRecipe(input) {
    const r = parseRecipe(input);
    if (S.cut) { const res = S.cut.resolve; S.cut = null; res?.(); }
    S.breaths = r.breaths.slice();
    S.palette = r.palette && r.palette.attenuation ? { ...paletteFor(r.palette), ...r.palette } : paletteFor(r.palette || {});
    applyPalette(S.palette);
    setFinish(r.finish);
    particles.clear();
    S.embers = false;
    S.finalProfile = r.profile;
    S.display = r.profile.map((p) => p.slice());
    S.mode = 'cooled';
    S.finish = 1;
    S.heat = S.heatTarget = 0;
    S.tintMix = 1;
    S.pose = 1;
    S.live.active = false;
    pipe.visible = false;
    snapFit = true;
    return r;
  }

  function reset() {
    if (S.cut) { const res = S.cut.resolve; S.cut = null; res?.(); }
    S.mode = 'hot';
    S.breaths = [];
    S.finalProfile = null;
    S.finish = 0;
    setFinish(null);
    particles.clear();
    S.embers = false;
    S.pose = 0;
    S.live = { swell: 0, peak: 0, target: 0, depth: 0.5, active: false };
    S.heatTarget = hotHeat(S.furnace);
    if (rm) S.heat = S.heatTarget;
    S.tintMix = 0;
    S.frozen = false;
    pivot.add(pipe);
    pipe.visible = true;
    pipe.rotation.set(0, 0, 0);
    S.display = buildProfile([]);
    snapFit = true;
  }

  // frame ---------------------------------------------------------------------
  let snapFit = true;
  let wall = wallProfile(S.display);

  function update(dt) {
    S.time += rm ? 0 : dt;
    const L = S.live;

    // live breath smoothing
    if (S.mode === 'hot' && !S.frozen) {
      L.swell = rm ? L.target : damp(L.swell, L.target, 9, dt);
      L.peak = Math.max(L.peak * Math.exp(-dt * 0.08), L.swell);
    }
    S.breathSwell = damp(S.breathSwell, S.mode === 'hot' && L.active ? L.swell : 0, 6, dt);

    // cut timeline
    if (S.mode === 'cutting' && S.cut) {
      const C = S.cut;
      C.t = performance.now() - C.start; // wall clock: the promise lands on time even if frames drop
      const t = C.t / CUT_MS;
      const pipeT = clamp(C.t / 900, 0, 1);
      pipe.position.copy(C.pipeStart).addScaledVector(C.pipeDir, easeInOut(pipeT) * 7);
      pipe.visible = pipeT < 1;
      S.finish = easeInOut(clamp((C.t - 150) / 1100, 0, 1));
      S.pose = easeOutBack(clamp((C.t - 300) / 1500, 0, 1));
      const ct = clamp(C.t / CUT_MS, 0, 1);
      S.heat = S.heatTarget = C.heat0 * Math.pow(1 - ct, 1.6);
      S.tintMix = clamp((ct - 0.15) / 0.6, 0, 1);
      if (!rm && C.t > STEAM_MS[0] && C.t < STEAM_MS[1]) {
        S.steamAcc += dt * STEAM_RATE;
        while (S.steamAcc >= 1) { S.steamAcc -= 1; spawnSteam(); }
      }
      if (t >= 1) finishCut();
    } else {
      S.heat = rm ? S.heatTarget : damp(S.heat, S.heatTarget, 2.2, dt);
    }

    // profile
    const target = targetProfile();
    const k = rm || snapFit ? 1 : 1 - Math.exp(-dt * 10);
    for (let i = 0; i < target.length; i++) {
      S.display[i][0] += (target[i][0] - S.display[i][0]) * k;
      S.display[i][1] += (target[i][1] - S.display[i][1]) * k;
    }
    wall = wallProfile(S.display);
    updateLathe(geometry, wall, 0.006);
    const H = profileHeight(S.display);
    const R = Math.max(0.2, profileMaxR(S.display));

    // fit + pose (fit eases separately so growth feels like the camera easing out)
    const p = S.pose, pc = clamp(p, 0, 1);
    const goalS = lerp(fitBlow(H, R), fitUpright(H, R), pc);
    const fk = rm || snapFit ? 1 : 1 - Math.exp(-dt * 3);
    S.fit.s = S.mode === 'cutting' ? goalS : lerp(S.fit.s, goalS, fk);
    const s = S.fit.s;
    const blowX = -0.02 * viewW - (H * s) / 2, blowY = 0.05 - (Math.sin(TILT) * H * s) / 2;
    const upY = -(H * s) / 2 - 0.12;
    pivot.scale.setScalar(s);
    pivot.position.set(lerp(blowX, 0, pc), lerp(blowY, upY, p), 0);
    pivot.rotation.z = lerp(-Math.PI / 2 + TILT, 0, p);
    snapFit = false;

    // spin on the pipe
    const spinRate = rm ? 0 : S.mode === 'hot' ? (S.frozen ? 0.12 : 0.55) : S.mode === 'cutting' ? 0.35 : 0.18;
    S.spin = damp(S.spin, spinRate, 2, dt);
    spinner.rotation.y += S.spin * dt;
    const sw = 1 + 0.035 * S.breathSwell;
    spinner.scale.set(sw, 1, sw);

    // pipe follows the mouth while attached
    if (pipe.parent === pivot) pipe.position.set(0, H - 0.12, 0);

    // heartbeat ripple (~300 ms)
    S.beatT += dt;
    const bt = clamp(S.beatT / 0.32, 0, 1);
    glass.uniforms.uBeat.value = bt < 1 ? S.beatStrength * Math.sin(Math.PI * bt) * (rm ? 0.35 : 1) : 0;
    glass.uniforms.uBeatPos.value = rm ? 0.5 : lerp(-0.15, 1.15, bt);

    // uniforms
    applyTint(S.tintMix * S.tintMix * (3 - 2 * S.tintMix));
    glass.uniforms.uCool.value = S.tintMix;
    S.dim = damp(S.dim, S.frozen ? 0.66 : 1, 3, dt);
    const heat = S.heat;
    glass.uniforms.uHeat.value = heat * (S.mode === 'hot' ? 1 + 0.06 * S.breathSwell : 1);
    glass.uniforms.uTime.value = S.time;
    glass.uniforms.uDim.value = S.dim;
    glass.uniforms.uHeight.value = H;
    // silhouette glow: radius per height from the current outline
    const hu = halo.uniforms;
    const rr = hu.uR.value;
    for (let k = 0, j = 0; k < GLOW_SAMPLES; k++) {
      const yk = (H * k) / (GLOW_SAMPLES - 1);
      while (j < S.display.length - 2 && S.display[j + 1][1] < yk) j++;
      const a = S.display[j], b = S.display[j + 1];
      const f = b[1] > a[1] ? clamp((yk - a[1]) / (b[1] - a[1]), 0, 1) : 0;
      rr[k] = lerp(a[0], b[0], f) * (1 + 0.035 * S.breathSwell);
    }
    hu.uH.value = H;
    hu.uHeat.value = heat;
    hu.uDim.value = S.dim;
    hu.uSwell.value = S.breathSwell;
    hu.uTime.value = S.time;
    const pad = 1.3;
    hu.uBox.value.set(-R - pad, -pad, 2 * (R + pad), H + 2 * pad);
    haloMesh.visible = heat > 0.01;
    fire.position.set(0, H * 0.62, 0);
    fire.intensity = heat * heat * 5 * S.dim;
    fire.visible = fire.intensity > 0.01;

    // contact shadow under the upright vessel
    shadow.uniforms.uOpacity.value = clamp((S.pose - 0.6) / 0.4, 0, 1) * (1 - heat * 0.5);
    shadowMesh.visible = shadow.uniforms.uOpacity.value > 0.001;
    shadowMesh.position.set(pivot.position.x, pivot.position.y + 0.005, 0);
    shadowMesh.scale.set(R * S.fit.s * 3.0, R * S.fit.s * 3.0, 1);

    // rare finish fades in with the palette while the glass cools
    const tm = S.tintMix;
    glass.uniforms.uFinishAmt.value = S.rare ? tm * tm * (3 - 2 * tm) : 0;

    if (S.embers && !rm && S.mode === 'hot') {
      S.emberAcc += dt * EMBER_RATE;
      while (S.emberAcc >= 1) { S.emberAcc -= 1; spawnEmber(); }
    }
    particles.update(dt);
  }

  function renderFrame(dt) {
    update(dt);
    renderer.render(scene, camera);
  }

  let raf = 0, last = performance.now(), disposed = false, fpsAcc = 0, fpsN = 0;
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { S.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    renderFrame(dt);
  }
  raf = requestAnimationFrame(loop);

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    if (S.cut) { const res = S.cut.resolve; S.cut = null; res?.(); }
    geometry.dispose(); cardGeo.dispose(); pipeGeo.dispose();
    glass.material.dispose(); halo.material.dispose(); disposeSnap();
    shadow.material.dispose(); pipeMat.dispose(); particles.dispose();
    envRT.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
  }

  function setReducedMotion(v) {
    rm = !!v;
    if (rm) particles.clear(); // reduced motion: no particles at all
  }

  function getStats() {
    return {
      fps: Math.round(S.fps),
      triangles: renderer.info.render.triangles,
      calls: renderer.info.render.calls,
      mode: S.mode,
      breaths: S.breaths.length,
      heat: Math.round(S.heat * 100) / 100,
      frozen: S.frozen,
      particles: particles.count(),
      finish: S.rare,
    };
  }

  return {
    setHeat, breath, commitBreath, heartbeat, setPalette, freeze, cut, snapshot, loadRecipe,
    reset, dispose, setReducedMotion, getStats, sparks, embers, setFinish,
    _debug: { glass, renderer, scene, camera, halo, render: () => renderer.render(scene, camera), step: (dt = 0) => renderFrame(dt) },
  };
}
