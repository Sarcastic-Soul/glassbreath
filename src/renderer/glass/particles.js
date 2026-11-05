// One shared particle pool for sparks, embers, the cut glint and steam.
// A single THREE.Points draw with additive blending. Every buffer is allocated once,
// so emitting and updating never allocates.
import * as THREE from 'three';

export const POOL = 240;
export const KIND = Object.freeze({ spark: 0, ember: 1, glint: 2, steam: 3 });

const SPARK_HOT = [1.5, 1.15, 0.62];
const SPARK_COLD = [0.85, 0.2, 0.02];
const GRAVITY = [4.2, 0.0, 2.6, -0.05]; // per kind, world units / s^2 (steam rises a little)
const DRAG = [0.6, 0.15, 3.5, 0.5]; // per kind, 1 / s

export function createParticles() {
  const pos = new Float32Array(POOL * 3);
  const col = new Float32Array(POOL * 3); // colour already multiplied by alpha
  const meta = new Float32Array(POOL * 2); // size (world units), softness
  const vel = new Float32Array(POOL * 3);
  const age = new Float32Array(POOL);
  const span = new Float32Array(POOL); // 0 = free slot
  const size0 = new Float32Array(POOL);
  const size1 = new Float32Array(POOL);
  const bright = new Float32Array(POOL);
  const phase = new Float32Array(POOL);
  const kind = new Uint8Array(POOL);
  let live = 0, cursor = 0, top = 0;

  const geometry = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const aMeta = new THREE.BufferAttribute(meta, 2).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', aPos);
  geometry.setAttribute('aCol', aCol);
  geometry.setAttribute('aMeta', aMeta);
  geometry.setDrawRange(0, 0);

  const uniforms = { uScale: { value: 400 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    vertexShader: /* glsl */ `
      attribute vec3 aCol; attribute vec2 aMeta;
      uniform float uScale;
      varying vec3 vCol; varying float vSoft;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aMeta.x > 0.0 ? max(aMeta.x * uScale / max(-mv.z, 0.1), 1.0) : 0.0;
        vCol = aCol; vSoft = aMeta.y;
      }`,
    // The soft dot is drawn in code: a gaussian core that reaches zero at the edge.
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vSoft;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d2 = dot(q, q);
        if (d2 > 1.0) discard;
        float a = exp(-d2 * vSoft) * (1.0 - d2);
        gl_FragColor = vec4(vCol * a, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // add light, leave destination alpha alone (same as the heat halo)
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 11;
  points.visible = false;

  function slot() {
    for (let n = 0; n < POOL; n++) {
      const i = (cursor + n) % POOL;
      if (span[i] <= 0) { cursor = (i + 1) % POOL; return i; }
    }
    return -1; // pool full: drop the particle
  }

  /** Spawn one particle. Returns false when the pool is full. */
  function emit(k, px, py, pz, vx, vy, vz, life, s0, s1 = s0, b = 1) {
    const i = slot();
    if (i < 0) return false;
    const j = i * 3;
    pos[j] = px; pos[j + 1] = py; pos[j + 2] = pz;
    vel[j] = vx; vel[j + 1] = vy; vel[j + 2] = vz;
    age[i] = 0; span[i] = Math.max(0.05, life);
    size0[i] = s0; size1[i] = s1; bright[i] = b;
    phase[i] = Math.random() * 6.283;
    kind[i] = k;
    live++;
    if (i >= top) top = i + 1;
    return true;
  }

  function kill(i) {
    span[i] = 0;
    meta[i * 2] = 0;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
    live--;
  }

  function update(dt) {
    if (!live) {
      if (points.visible) { points.visible = false; geometry.setDrawRange(0, 0); top = 0; }
      return;
    }
    let hi = 0;
    for (let i = 0; i < top; i++) {
      if (span[i] <= 0) continue;
      age[i] += dt;
      const t = age[i] / span[i];
      if (t >= 1) { kill(i); continue; }
      const k = kind[i], j = i * 3;
      const drag = Math.exp(-DRAG[k] * dt);
      vel[j] *= drag; vel[j + 1] = vel[j + 1] * drag - GRAVITY[k] * dt; vel[j + 2] *= drag;
      if (k === KIND.ember) vel[j] += Math.sin(age[i] * 1.7 + phase[i]) * 0.12 * dt; // lazy side drift
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;

      let a, r, g, b, soft;
      if (k === KIND.spark) {
        const c = Math.pow(t, 0.6);
        a = Math.pow(1 - t, 1.4);
        r = SPARK_HOT[0] + (SPARK_COLD[0] - SPARK_HOT[0]) * c;
        g = SPARK_HOT[1] + (SPARK_COLD[1] - SPARK_HOT[1]) * c;
        b = SPARK_HOT[2] + (SPARK_COLD[2] - SPARK_HOT[2]) * c;
        soft = 5;
      } else if (k === KIND.ember) {
        a = Math.sin(Math.PI * t) * (0.75 + 0.25 * Math.sin(age[i] * 9 + phase[i]));
        r = 0.95; g = 0.32; b = 0.05; soft = 4;
      } else if (k === KIND.glint) {
        a = (1 - t) * (1 - t);
        r = 1.6; g = 1.4; b = 1.05; soft = 3.5;
      } else {
        a = Math.min(1, t / 0.18) * Math.pow(1 - t, 1.3);
        r = 0.86; g = 0.85; b = 0.84; soft = 2.8;
      }
      a *= bright[i];
      col[j] = r * a; col[j + 1] = g * a; col[j + 2] = b * a;
      const sz = size0[i] + (size1[i] - size0[i]) * (k === KIND.steam ? Math.sqrt(t) : t);
      meta[i * 2] = sz; meta[i * 2 + 1] = soft;
      hi = i + 1;
    }
    top = hi;
    geometry.setDrawRange(0, hi);
    points.visible = hi > 0;
    if (hi > 0) {
      aPos.clearUpdateRanges(); aPos.addUpdateRange(0, hi * 3); aPos.needsUpdate = true;
      aCol.clearUpdateRanges(); aCol.addUpdateRange(0, hi * 3); aCol.needsUpdate = true;
      aMeta.clearUpdateRanges(); aMeta.addUpdateRange(0, hi * 2); aMeta.needsUpdate = true;
    }
  }

  function clear() {
    span.fill(0); meta.fill(0); col.fill(0);
    live = 0; top = 0; cursor = 0;
    geometry.setDrawRange(0, 0);
    points.visible = false;
  }

  /** Pixels per world unit at distance 1, for the point size. */
  function setScale(bufferHeight, fovDeg) {
    uniforms.uScale.value = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)));
  }

  function dispose() { geometry.dispose(); material.dispose(); }

  return { points, emit, update, clear, setScale, dispose, count: () => live };
}
