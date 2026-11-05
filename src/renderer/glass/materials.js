// Materials: the glass itself (patched MeshPhysicalMaterial), a silhouette heat glow,
// a contact shadow and the steel blowpipe.
import * as THREE from 'three';
import { SNOISE, MOLTEN_RAMP, FINISH } from './shaders.js';

/**
 * Glass that runs from molten (emissive, opaque-ish) to cooled clear coloured glass.
 * The canvas is transparent, so three's transmission buffer has nothing behind the
 * vessel. We patch the transmission step: where nothing opaque is behind, refract the
 * studio environment instead and tint it with Beer-Lambert absorption.
 */
export function createGlassMaterial() {
  const uniforms = {
    uHeat: { value: 1 },
    uTime: { value: 0 },
    uDim: { value: 1 },
    uHeight: { value: 1 },
    uBeat: { value: 0 },
    uBeatPos: { value: -1 },
    uGlassAlpha: { value: 0.26 },
    uCool: { value: 0 }, // 0 = on the pipe (no own colour yet), 1 = cut and cooled
    uTint: { value: new THREE.Color(0x58b8a8) },
    uRim: { value: new THREE.Color(0xc8f0e6) },
    uFinishType: { value: 0 }, // 0 none, 1 gold, 2 crackle, 3 opal
    uFinishAmt: { value: 0 }, // fades in as the glass cools
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.05,
    ior: 1.5,
    transmission: 1,
    thickness: 0.35,
    attenuationColor: new THREE.Color(0x7fd6c4),
    attenuationDistance: 0.75,
    specularIntensity: 1,
    envMapIntensity: 1.15,
    iridescence: 0.18,
    iridescenceIOR: 1.3,
    iridescenceThicknessMinimum: 180,
    iridescenceThicknessMaximum: 420,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGbObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGbObj = position;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vGbObj;
uniform float uHeat, uTime, uDim, uHeight, uBeat, uBeatPos, uGlassAlpha, uCool, uFinishType, uFinishAmt;
uniform vec3 uTint, uRim;
${SNOISE}
${MOLTEN_RAMP}
${FINISH}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float yN = clamp(vGbObj.y / max(uHeight, 0.001), 0.0, 1.0);
  float facing = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
  float n1 = gb_snoise(vGbObj * vec3(1.4, 0.7, 1.4) + vec3(0.0, -uTime * 0.18, uTime * 0.05));
  float n2 = gb_snoise(vGbObj * 4.3 + vec3(uTime * 0.35, 0.0, 0.0));
  float core = pow(facing, 1.6);
  float hl = clamp(uHeat, 0.0, 1.1) * (0.36 + 0.64 * core) * (0.88 + 0.12 * n1 + 0.05 * n2);
  hl *= mix(1.0, 0.7, smoothstep(0.72, 1.0, yN)); // cooler where it meets the pipe
  hl = min(hl, 1.0);
  // Capped so ACES never clips to white: gold-orange core, deep orange-red at the rim,
  // which keeps the form and the bands readable even at full heat.
  vec3 molten = gb_molten(0.26 + 0.46 * hl) * (0.14 + 0.58 * hl) * clamp(uHeat * 3.0, 0.0, 1.0);
  if (!gl_FrontFacing) molten *= 0.35;
  totalEmissiveRadiance += molten * uDim;
  float beat = uBeat * exp(-pow((yN - uBeatPos) * 6.0, 2.0));
  totalEmissiveRadiance += beat * mix(uRim * 0.35, vec3(1.0, 0.6, 0.25) * 1.6, clamp(uHeat * 1.5, 0.0, 1.0));
}`,
      )
      .replace(
        '#include <transmission_fragment>',
        `#ifdef USE_TRANSMISSION
  material.transmission = transmission;
  material.transmissionAlpha = 1.0;
  material.thickness = thickness;
  material.attenuationDistance = attenuationDistance;
  material.attenuationColor = attenuationColor;
  {
    vec3 pos = vWorldPosition;
    vec3 v = normalize(cameraPosition - pos);
    vec3 n = transformNormalByInverseViewMatrix(normal, viewMatrix);
    float NoV = clamp(dot(n, v), 0.0, 1.0);
    float pathLen = material.thickness / max(NoV, 0.18);
    vec3 attn = volumeAttenuation(pathLen, material.attenuationColor, material.attenuationDistance);
    vec3 rdir = refract(-v, n, 1.0 / material.ior);
    vec3 envR = vec3(0.08);
    #ifdef ENVMAP_TYPE_PMREM
      envR = textureLod(envMap, envMapRotation * rdir, roughnessToMip(0.03)).rgb * envMapIntensity;
    #endif
    vec3 behind;
    float outA;
    if (gl_FrontFacing) {
      // Same ray as three's getIBLVolumeRefraction, but we need the raw buffer alpha to
      // tell "opaque object / far wall behind" (a = 1) from "empty canvas" (a = 0.5).
      vec3 tRay = getVolumeTransmissionRay(n, v, material.thickness, material.ior, modelMatrix);
      vec4 ndc = projectionMatrix * viewMatrix * vec4(pos + tRay, 1.0);
      vec2 tUv = (ndc.xy / ndc.w + 1.0) * 0.5;
      vec4 tSample = getTransmissionSample(tUv, material.roughness, material.ior);
      vec3 tAttn = volumeAttenuation(length(tRay), material.attenuationColor, material.attenuationDistance);
      vec3 F = EnvironmentBRDF(n, v, material.specularColorBlended, material.specularF90, material.roughness);
      float objMask = clamp((tSample.a - 0.5) * 2.0, 0.0, 1.0);
      vec3 seen = (1.0 - F) * tAttn * tSample.rgb / max(tSample.a, 0.5);
      behind = mix(envR * attn * 0.55 + uTint * 0.14, seen, objMask);
      outA = clamp(uGlassAlpha + pow(1.0 - NoV, 2.0) * 0.5, 0.0, 1.0);
    } else {
      behind = envR * attn * 0.35 + uTint * 0.12;
      totalSpecular *= 0.3; // the inside of the far wall: faint reflections only
      outA = 1.0;
    }
    // dark-field look: light travelling through thick glass at grazing angles makes the
    // silhouette glow in the glass colour while the thin centre stays clear
    float edge = pow(1.0 - NoV, 2.2);
    behind += (uTint * (edge * 0.55 + 0.03) + uRim * pow(1.0 - NoV, 6.0) * 0.35) * (1.0 - uHeat);
    behind *= (1.0 - 0.75 * clamp(uHeat, 0.0, 1.0)) * mix(0.2, 1.0, uCool);
    if (!gl_FrontFacing) totalSpecular *= mix(0.2, 1.0, uCool);
    outA = mix(outA, 1.0, max(clamp(uHeat * 1.3, 0.0, 1.0), 1.0 - uCool));
    if (uFinishAmt > 0.001) {
      vec3 envRefl = vec3(0.3);
      #ifdef ENVMAP_TYPE_PMREM
        if (uFinishType < 1.5) envRefl = textureLod(envMap, envMapRotation * reflect(-v, n), roughnessToMip(0.2)).rgb * envMapIntensity;
      #endif
      float fa = uFinishAmt * (gl_FrontFacing ? 1.0 : 0.55);
      gb_finish(uFinishType, fa, vGbObj, n, v, NoV, behind, outA, envRefl);
    }
    material.transmissionAlpha = mix(1.0, outA, material.transmission);
    totalDiffuse = mix(totalDiffuse, behind, material.transmission);
  }
#endif`,
      );
  };
  material.customProgramCacheKey = () => 'glassbreath-glass-v2';
  return { material, uniforms };
}

// Additive blending that leaves destination alpha alone: on a premultiplied, transparent
// canvas this adds light on top of whatever page colour is underneath.
function additive(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  return mat;
}

export const GLOW_SAMPLES = 32;

/**
 * Soft heat glow that follows the vessel's silhouette (a cheap stand-in for bloom).
 * A camera-facing card in the vessel's own space; the fragment shader measures the
 * distance to the lathe outline (radius per height, passed as a small array) and adds
 * two falloffs: a tight hot rim and a wide warm haze.
 */
export function createHaloMaterial() {
  const uniforms = {
    uHeat: { value: 1 },
    uDim: { value: 1 },
    uSwell: { value: 0 },
    uTime: { value: 0 },
    uH: { value: 1 },
    uR: { value: new Float32Array(GLOW_SAMPLES) },
    uBox: { value: new THREE.Vector4(-1, -1, 2, 2) }, // x0, y0, width, height in vessel units
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    vertexShader: /* glsl */ `
      uniform vec4 uBox; varying vec2 vP;
      void main(){
        vP = uBox.xy + (position.xy + 0.5) * uBox.zw;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vP.x, vP.y, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      #define N ${GLOW_SAMPLES}
      uniform float uHeat, uDim, uSwell, uTime, uH;
      uniform float uR[N];
      uniform vec4 uBox;
      varying vec2 vP;
      ${MOLTEN_RAMP}
      float segDist(vec2 p, vec2 a, vec2 b){
        vec2 ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        return length(p - a - ab * t);
      }
      float smin(float a, float b, float k){
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }
      void main(){
        vec2 p = vec2(abs(vP.x), vP.y);
        float dyS = uH / float(N - 1);
        float d = 1e3;
        float rAt = 0.0;
        vec2 prev = vec2(0.0, 0.0);
        for (int k = 0; k < N; k++) {
          vec2 cur = vec2(uR[k], dyS * float(k));
          d = smin(d, segDist(p, prev, cur), 0.12);
          if (p.y >= prev.y && p.y <= cur.y) rAt = mix(prev.x, cur.x, (p.y - prev.y) / max(cur.y - prev.y, 1e-5));
          prev = cur;
        }
        d = max(smin(d, segDist(p, prev, vec2(0.0, uH)), 0.12), 0.0);
        float inside = (p.y >= 0.0 && p.y <= uH && p.x < rAt) ? 1.0 : 0.0;
        float grow = 1.0 + 0.18 * uSwell;
        float tight = exp(-d / (0.06 * grow));
        float wide = exp(-pow(d / (0.26 * grow), 1.4));
        // fade to zero well before the card edge so the card never shows
        vec2 e = min(vP - uBox.xy, uBox.xy + uBox.zw - vP);
        float win = smoothstep(0.0, 0.5, min(e.x, e.y));
        // over the body itself keep it light: the glass already glows
        float g = mix(tight * 0.3 + wide * 0.5, 0.04, inside);
        float flick = 0.94 + 0.06 * sin(uTime * 7.3 + vP.y * 3.0) * sin(uTime * 4.1);
        float h = uHeat * uHeat;
        vec3 col = mix(gb_molten(0.5 + 0.2 * uHeat), gb_molten(0.3), clamp(d * 1.6, 0.0, 1.0));
        float k = h * g * win * flick * uDim * (0.85 + 0.3 * uSwell);
        gl_FragColor = vec4(col * k * 0.5, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  return { material: additive(mat), uniforms };
}

/** Contact shadow for the upright, cooled vessel. */
export function createShadowMaterial() {
  const uniforms = { uOpacity: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; varying vec2 vUv;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2) * 0.5 + pow(1.0 - smoothstep(0.0, 0.45, d), 2.0) * 0.35;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
      }`,
  });
  mat.premultipliedAlpha = true;
  return { material: mat, uniforms };
}

/** Brushed steel with temper colours near the hot tip (via vertex colours). */
export function createPipeMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 1,
    roughness: 0.28,
    envMapIntensity: 1.8,
  });
}

/** Blowpipe geometry: starts at y=0 (tip, inside the gather) and runs to +length. */
export function createPipeGeometry(radius = 0.045, length = 9) {
  const g = new THREE.CylinderGeometry(radius, radius, length, 24, 48, true);
  g.translate(0, length / 2, 0);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const steel = new THREE.Color(0xb4b9bf);
  const straw = new THREE.Color(0xb08a52);
  const blue = new THREE.Color(0x3c4a66);
  const soot = new THREE.Color(0x1c1a19);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0.35) c.copy(soot).lerp(straw, y / 0.35);
    else if (y < 0.8) c.copy(straw).lerp(blue, (y - 0.35) / 0.45);
    else c.copy(blue).lerp(steel, Math.min(1, (y - 0.8) / 0.9));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}
