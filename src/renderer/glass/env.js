// Procedural studio environment: dark room with soft boxes, baked to a PMREM.
// Gives glass long, clean highlight strips instead of a generic grey room.
import * as THREE from 'three';

export function createStudioEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050403);
  const geo = new THREE.PlaneGeometry(1, 1);
  const panels = [];
  const add = (w, h, pos, color, intensity) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, m);
    mesh.scale.set(w, h, 1);
    mesh.position.set(...pos);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    panels.push(m);
  };
  add(1.6, 6, [-7, 3, 3], 0xfff4e8, 6); // key soft box, upper left front (narrow: a crisp strip, not a wash)
  add(0.7, 9, [7, 0.5, -1], 0xe8f0ff, 7); // tall rim strip, right
  add(0.5, 7, [-7, 0, -3], 0xffffff, 3); // thin back-left strip
  add(16, 9, [0, 0.5, -10], 0x9a958e, 0.05); // dim backdrop
  add(16, 0.7, [0, -2.4, -9], 0xfff1e0, 0.8); // low horizon glow behind: lensed by the glass
  add(8, 8, [0, 9, 0], 0xfff8f0, 0.9); // overhead
  add(10, 4, [0, -7, 3], 0xff8a3a, 0.5); // faint warm bounce from the furnace floor

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  geo.dispose();
  for (const m of panels) m.dispose();
  return rt; // caller disposes
}
