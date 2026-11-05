// Fixed-topology lathe geometry that can be re-shaped every frame without reallocating.
import * as THREE from 'three';

export function createLathe(profileCount, segments = 72) {
  const cols = segments + 1;
  const vCount = profileCount * cols;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(vCount * 2);
  for (let i = 0; i < profileCount; i++) {
    for (let j = 0; j < cols; j++) {
      uv[(i * cols + j) * 2] = j / segments;
      uv[(i * cols + j) * 2 + 1] = i / (profileCount - 1);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const index = [];
  for (let i = 0; i < profileCount - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  g.setIndex(index);
  g.userData = { profileCount, segments };
  // precomputed trig
  g.userData.cos = Float32Array.from({ length: cols }, (_, j) => Math.cos((j / segments) * Math.PI * 2));
  g.userData.sin = Float32Array.from({ length: cols }, (_, j) => Math.sin((j / segments) * Math.PI * 2));
  return g;
}

/**
 * Write a closed [r, y] profile into the lathe. A tiny deterministic wobble makes it
 * read as hand-made and lets the eye see the vessel turning on the pipe.
 */
export function updateLathe(g, profile, wobble = 0.012) {
  const { profileCount, segments, cos, sin } = g.userData;
  const cols = segments + 1;
  const pos = g.attributes.position.array;
  const nor = g.attributes.normal.array;
  const n = Math.min(profileCount, profile.length);
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i];
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
    let dr = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dr, dy) || 1;
    dr /= len; dy /= len;
    const nr = dy, ny = -dr; // 2D normal in the (r, y) plane
    for (let j = 0; j < cols; j++) {
      const th = (j / segments) * Math.PI * 2;
      const w = 1 + wobble * (0.6 * Math.sin(3 * th + y * 2.1 + 1.3) + 0.4 * Math.sin(2 * th - y * 3.7));
      const rr = r * w;
      const k = (i * cols + j) * 3;
      pos[k] = rr * cos[j];
      pos[k + 1] = y;
      pos[k + 2] = rr * sin[j];
      nor[k] = nr * cos[j];
      nor[k + 1] = ny;
      nor[k + 2] = nr * sin[j];
    }
  }
  g.attributes.position.needsUpdate = true;
  g.attributes.normal.needsUpdate = true;
  g.computeBoundingSphere();
}
