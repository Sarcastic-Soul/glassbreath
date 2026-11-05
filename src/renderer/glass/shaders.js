// GLSL snippets shared by the glass materials.

// 3D simplex noise, Ashima Arts / Stefan Gustavson (MIT).
export const SNOISE = /* glsl */ `
vec3 gb_mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 gb_mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 gb_permute(vec4 x){return gb_mod289(((x*34.0)+10.0)*x);}
vec4 gb_taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float gb_snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=gb_mod289(i);
  vec4 p=gb_permute(gb_permute(gb_permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=gb_taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

// Temperature ramp for glowing glass: dull red -> orange -> yellow -> pale white-gold.
export const MOLTEN_RAMP = /* glsl */ `
vec3 gb_molten(float t){
  vec3 c=mix(vec3(0.16,0.006,0.0),vec3(0.95,0.13,0.004),smoothstep(0.0,0.38,t));
  c=mix(c,vec3(1.0,0.42,0.04),smoothstep(0.3,0.66,t));
  c=mix(c,vec3(1.0,0.74,0.26),smoothstep(0.62,0.9,t));
  c=mix(c,vec3(1.0,0.92,0.7),smoothstep(0.9,1.05,t));
  return c;
}
`;

// Rare finishes (gold leaf, crackle, opal). Needs SNOISE. Called from the glass
// transmission step with the object-space point p, world normal n, view dir v and
// NoV. It edits the transmitted colour and alpha in place. amt fades the finish in
// as the glass cools; type is 1 gold, 2 crackle, 3 opal.
export const FINISH = /* glsl */ `
vec3 gb_hash3(vec3 p){
  p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));
  return fract(sin(p)*43758.5453);
}
// Voronoi: distance between the two nearest cell points (0 on a cell edge).
float gb_cellEdge(vec3 p){
  vec3 i=floor(p),f=fract(p);
  float d1=8.0,d2=8.0;
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 g=vec3(float(x),float(y),float(z));
    vec3 r=g+gb_hash3(i+g)-f;
    float d=dot(r,r);
    if(d<d1){d2=d1;d1=d;}else if(d<d2){d2=d;}
  }
  return sqrt(d2)-sqrt(d1);
}
void gb_finish(float type,float amt,vec3 p,vec3 n,vec3 v,float NoV,inout vec3 col,inout float alpha,vec3 envRefl){
  if(type<1.5){
    // gold leaf: small torn flecks in loose clusters, each catching light at its own angle
    float cluster=gb_snoise(p*0.9+vec3(3.1,7.7,1.3));
    float fl=0.7*gb_snoise(p*8.0)+0.3*gb_snoise(p*21.0);
    float m=smoothstep(0.6,0.66,fl+0.35*cluster)*amt;
    float h=gb_hash3(floor(p*8.0)).x;
    float tw=pow(0.5+0.5*sin(h*60.0+dot(v,vec3(11.0,7.0,5.0))),10.0);
    float lum=dot(envRefl,vec3(0.3,0.5,0.2));
    vec3 gold=vec3(1.0,0.7,0.28)*(0.22+1.3*lum)+vec3(1.0,0.85,0.5)*tw*1.4;
    col=mix(col,gold,m);
    alpha=mix(alpha,0.95,m);
  }else if(type<2.5){
    // crackle glaze: a fine network of lighter lines, warped so it reads hand-made
    vec3 q=p*8.0+0.3*vec3(gb_snoise(p*1.7),gb_snoise(p*1.7+5.2),0.0);
    float e=gb_cellEdge(q);
    float w=fwidth(e);
    float vary=0.3+0.7*smoothstep(-0.5,0.5,gb_snoise(p*0.8+2.0)); // some cracks fainter than others
    float line=(1.0-smoothstep(0.0,w*0.9+0.006,e))*amt*vary;
    col+=vec3(0.78,0.84,0.86)*line*0.34;
    alpha=mix(alpha,max(alpha,0.4),line);
  }else{
    // opal: milky body with a soft hue shift that follows the view angle
    float f=1.0-NoV;
    float hue=f*1.1+0.12*gb_snoise(p*1.4)+0.55;
    vec3 irid=0.5+0.5*cos(6.2831*(hue+vec3(0.0,0.33,0.67)));
    vec3 milk=vec3(0.82,0.84,0.88);
    float k=(0.14+0.46*pow(f,1.3))*amt;
    col=mix(col,milk*0.4+irid*(0.12+0.22*f),k);
    alpha=mix(alpha,max(alpha,0.5),k*0.7);
  }
}
`;

// Breath patterns drawn on the glass (see pattern.js). Needs SNOISE.
// gb_band maps height to a band coordinate s (0..n across the decorated region, one
// unit per breath, spaced by breath timing) and the local band height in world units.
export const PATTERN_BANDS = 16;
export const PATTERN = /* glsl */ `
#define GB_BANDS ${16}
uniform float uPatType, uPatAmt, uBandN, uLipY;
uniform float uEdges[GB_BANDS + 1];
uniform vec2 uRegion;
uniform vec4 uPat; // x thread width, y wave depth, z combs / lattice count, w lattice twist
uniform vec3 uBandAtt[GB_BANDS];
uniform vec3 uBandTint[GB_BANDS];
uniform vec3 uThreadCol, uLipCol;
vec2 gb_band(float y){
  float span = max(uRegion.y - uRegion.x, 1e-3);
  float yn = (y - uRegion.x) / span;
  float s = yn, bh = 1.0;
  for (int k = 0; k < GB_BANDS; k++) {
    if (float(k) >= uBandN) break;
    float a = uEdges[k], b = uEdges[k + 1];
    if (yn >= a || k == 0) { s = float(k) + (yn - a) / max(b - a, 1e-4); bh = max(b - a, 1e-4); }
  }
  return vec2(s, bh * span);
}
// anti-aliased line of half-width w for a distance d (any units)
float gb_line(float d, float w){
  float aa = fwidth(d) * 0.9 + 1e-5;
  return 1.0 - smoothstep(w - aa, w + aa, d);
}
// Returns thread coverage; edits the local glass colours for incalmo.
float gb_pattern(vec3 p, inout vec3 tint, inout vec3 att){
  if (uPatAmt < 0.001 || uPatType < 0.5) return 0.0;
  vec2 sb = gb_band(p.y);
  float s = sb.x, bh = sb.y;
  float th = atan(p.z, p.x) * 0.15915494 + 0.5; // 0..1 around the axis
  float inR = step(0.0, s) * step(s, uBandN);
  float edge = smoothstep(0.0, 0.25, s) * smoothstep(uBandN, uBandN - 0.25, s);
  float m = 0.0;
  if (uPatType < 1.5) {
    // trailing: one spiral turn per breath
    float f = s - th;
    float d = abs(fract(f + 0.5) - 0.5) * bh;
    float hand = 0.8 + 0.3 * gb_snoise(vec3(th * 7.0, s * 1.3, 0.5)); // hand-pulled thickness
    m = gb_line(d, uPat.x * hand) * inR;
  } else if (uPatType < 2.5) {
    // combed feathers: two threads per breath, dragged up and down by uPat.z combs
    float phi = th * uPat.z;
    float q = fract(phi) - 0.5;
    float dir = mod(floor(phi), 2.0) * 2.0 - 1.0;
    float pull = uPat.y * dir * pow(1.0 - 2.0 * abs(q), 2.4);
    float v = (s - pull) * 2.0;
    float d = abs(fract(v + 0.5) - 0.5);
    float vw = 2.0 / max(bh, 1e-3); // world -> v units
    m = gb_line(d, uPat.x * 0.8 * vw) * edge;
  } else if (uPatType < 3.5) {
    // filigrana / reticello: two families of fine twisted white threads
    float a1 = th * uPat.z + s * uPat.w;
    float a2 = th * uPat.z - s * uPat.w;
    float d1 = abs(fract(a1 + 0.5) - 0.5), d2 = abs(fract(a2 + 0.5) - 0.5);
    float circ = 6.2831 * length(p.xz) / uPat.z; // world width of one lattice cell
    float w = uPat.x * 0.32 / max(circ, 1e-3);
    float tw1 = 0.55 + 0.45 * abs(sin(a2 * 18.85)); // the twist of each cane
    float tw2 = 0.55 + 0.45 * abs(sin(a1 * 18.85));
    m = max(gb_line(d1, w * tw1), gb_line(d2, w * tw2)) * edge;
  } else {
    // incalmo: each breath's band a slightly different glass colour, softly fused
    float k = clamp(floor(s), 0.0, uBandN - 1.0);
    float fs = s - k;
    float blend = smoothstep(1.0 - 0.03 / max(bh, 1e-3), 1.0, fs) * step(k + 1.0, uBandN - 0.5);
    vec3 a = uBandAtt[0], t = uBandTint[0], a2 = uBandAtt[0], t2 = uBandTint[0];
    for (int i = 0; i < GB_BANDS; i++) {
      if (float(i) == k) { a = uBandAtt[i]; t = uBandTint[i]; }
      if (float(i) == k + 1.0) { a2 = uBandAtt[i]; t2 = uBandTint[i]; }
    }
    if (s < 0.0) { a = a2 = uBandAtt[0]; t = t2 = uBandTint[0]; }
    att = mix(att, mix(a, a2, blend), uPatAmt);
    tint = mix(tint, mix(t, t2, blend), uPatAmt);
    // a fine pale seam where two colours meet
    float d = abs(fract(s + 0.5) - 0.5) * bh;
    m = gb_line(d, uPat.x * 0.3) * 0.5 * inR * step(0.5, s) * step(s, uBandN - 0.5);
  }
  return m * uPatAmt;
}
`;
