import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ============================================================
   Tipos públicos
============================================================ */

export interface GardenParams {
  timeOfDay: number; // 0..24
  wind: number; // 0..3
  flowerDensity: number; // 0..1
  grassDensity: number; // 0..1
  fireflies: boolean;
  petals: boolean;
  butterflies: boolean;
  bloom: number; // 0..1.5
  autoRotate: boolean;
  sound: boolean;
}

export interface GardenStats {
  fps: number;
  grass: number;
  flowers: number;
  petals: number;
  fireflies: number;
  sunDeg: number;
  timeLabel: string;
  phase: string;
}

/* ============================================================
   Utilidades
============================================================ */

const clamp = (v: number, a: number, b: number) =>
  Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number) {
  const rand = mulberry32(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 256; i++) perm[i] = rand();
  for (let i = 256; i < 512; i++) perm[i] = perm[i - 256];
  const at = (ix: number, iz: number) =>
    perm[(ix & 255) + perm[(iz & 255) & 255] * 7 % 256];
  const val = (x: number, z: number) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = at(ix, iz);
    const b = at(ix + 1, iz);
    const c = at(ix, iz + 1);
    const d = at(ix + 1, iz + 1);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
  };
  const fbm = (x: number, z: number) =>
    val(x, z) * 0.55 +
    val(x * 2.13 + 11.7, z * 2.13 - 4.2) * 0.27 +
    val(x * 4.41 - 7.9, z * 4.41 + 3.1) * 0.13 +
    val(x * 8.7 + 2.3, z * 8.7 + 9.4) * 0.05;
  return { val, fbm };
}

/* ============================================================
   Audio: viento + campanillas al plantar
============================================================ */

class GardenAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  enabled = false;

  async enable() {
    if (!this.ctx) {
      const AC = window.AudioContext;
      if (!AC) return;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
      // ruido de viento en bucle
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 340;
      bp.Q.value = 0.45;
      const wg = ctx.createGain();
      wg.gain.value = 0;
      src.connect(bp).connect(wg).connect(master);
      src.start();
      this.ctx = ctx;
      this.master = master;
      this.windGain = wg;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.ctx && this.windGain)
      this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  setWind(v: number) {
    if (this.ctx && this.windGain && this.enabled)
      this.windGain.gain.setTargetAtTime(
        clamp(v, 0, 3) * 0.055,
        this.ctx.currentTime,
        0.4
      );
  }

  pluck() {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const notes = [392, 440, 523.25, 587.33, 659.25, 783.99];
    const f = notes[Math.floor(Math.random() * notes.length)];
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(g).connect(this.master);
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = f * 2;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.045, t + 0.015);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc2.connect(g2).connect(this.master);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 1);
    osc2.stop(t + 0.6);
  }

  dispose() {
    if (this.ctx) this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}

/* ============================================================
   Shaders
============================================================ */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = normalize(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunAmt;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = pow(max(d.y, 0.0), 0.62);
  vec3 col = mix(uHorizon, uTop, h);
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(s, 420.0) * 1.6 + pow(s, 24.0) * 0.30 + pow(s, 5.0) * 0.12) * uSunAmt;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRASS_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
attribute float aPhase;
attribute float aTint;
uniform float uTime;
uniform float uWind;
varying float vH;
varying float vTint;
varying float vSwayMix;
void main() {
  float h = clamp(position.y, 0.0, 1.0);
  vec3 p = position * aScale;
  float w = uWind * h * h;
  float s1 = sin(uTime * 1.7 + aPhase + aOffset.x * 0.22 + aOffset.z * 0.17);
  float s2 = sin(uTime * 3.3 + aPhase * 1.71);
  p.x += (s1 * 0.30 + s2 * 0.07) * w;
  p.z += cos(uTime * 1.2 + aPhase * 0.83 + aOffset.x * 0.1) * 0.22 * w;
  vec3 world = p + aOffset;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vH = h;
  vTint = aTint;
  vSwayMix = s1 * w;
}
`;

const GRASS_FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uLight;
uniform vec3 uAmbient;
varying float vH;
varying float vTint;
varying float vSwayMix;
void main() {
  vec3 base = mix(uColA, uColB, vH);
  base *= 0.82 + 0.36 * vTint;
  vec3 lit = base * (uAmbient + uLight * (0.35 + 0.65 * vH));
  lit += vec3(0.03, 0.05, 0.02) * abs(vSwayMix);
  gl_FragColor = vec4(lit, 1.0);
}
`;

const FLOWER_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
attribute float aPhase;
attribute vec3 color;
uniform float uTime;
uniform float uWind;
varying vec3 vColor;
varying float vH;
void main() {
  float h = clamp(position.y / 0.8, 0.0, 1.0);
  vec3 p = position * aScale;
  float w = uWind * h;
  float s1 = sin(uTime * 1.9 + aPhase + aOffset.x * 0.3);
  p.x += s1 * 0.085 * w;
  p.z += cos(uTime * 1.4 + aPhase * 1.3) * 0.06 * w;
  vec3 world = p + aOffset;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vColor = color;
  vH = h;
}
`;

const FLOWER_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uAmbient;
varying vec3 vColor;
varying float vH;
void main() {
  vec3 lit = vColor * (uAmbient + uLight * (0.4 + 0.6 * vH));
  gl_FragColor = vec4(lit, 1.0);
}
`;

const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  p.y += sin(p.x * 1.8 + uTime * 1.1) * 0.02 + cos(p.z * 2.2 - uTime * 0.9) * 0.02;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSkyTop;
uniform vec3 uSkyHor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uDay;
uniform vec3 uDeep;
varying vec3 vWorld;

float waveH(vec2 p) {
  return sin(p.x * 1.9 + uTime * 1.2) * 0.5
       + sin(p.y * 2.3 - uTime * 0.9) * 0.5
       + sin((p.x + p.y) * 1.1 + uTime * 0.6) * 0.5;
}
void main() {
  vec2 p = vWorld.xz;
  float e = 0.18;
  float hx = waveH(p + vec2(e, 0.0)) - waveH(p - vec2(e, 0.0));
  float hz = waveH(p + vec2(0.0, e)) - waveH(p - vec2(0.0, e));
  vec3 n = normalize(vec3(-hx * 0.16, 1.0, -hz * 0.16));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 skyRef = mix(uSkyHor, uSkyTop, 0.55);
  vec3 col = mix(uDeep, skyRef, 0.35 + fres * 0.6);
  vec3 h = normalize(v + normalize(uSunDir));
  float spec = pow(max(dot(n, h), 0.0), 160.0);
  col += uSunColor * spec * (0.5 + uDay * 1.4);
  float sparkle = waveH(p * 3.1) * 0.035;
  col += vec3(sparkle) * (0.3 + uDay);
  gl_FragColor = vec4(col, 0.94);
}
`;

const FIREFLY_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSpeed;
uniform float uTime;
varying float vPulse;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.55 * aSpeed + aPhase) * 1.3;
  p.y += sin(uTime * 0.85 + aPhase * 2.1) * 0.55;
  p.z += cos(uTime * 0.45 * aSpeed + aPhase * 1.3) * 1.3;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float pulse = 0.55 + 0.45 * sin(uTime * 2.6 + aPhase * 7.0);
  vPulse = pulse;
  gl_PointSize = (3.2 + 2.6 * pulse) * (160.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FIREFLY_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vPulse;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.05, 0.5, d)) * uOpacity * vPulse;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (1.1 + vPulse * 0.9), a);
}
`;

/* ============================================================
   Claves de entorno (cielo / luz según la hora)
============================================================ */

interface EnvKey {
  h: number;
  top: THREE.Color;
  hor: THREE.Color;
  sun: THREE.Color;
  sunI: number;
  amb: THREE.Color;
  ambI: number;
}

const K = (
  h: number,
  top: string,
  hor: string,
  sun: string,
  sunI: number,
  amb: string,
  ambI: number
): EnvKey => ({
  h,
  top: new THREE.Color(top),
  hor: new THREE.Color(hor),
  sun: new THREE.Color(sun),
  sunI,
  amb: new THREE.Color(amb),
  ambI,
});

const ENV_KEYS: EnvKey[] = [
  K(0.0, '#04101e', '#0a2733', '#8fb4cf', 0.22, '#1c2f39', 0.8),
  K(5.0, '#0a2036', '#1d4152', '#b8cfe0', 0.28, '#243a44', 0.8),
  K(6.3, '#2e608f', '#f2a468', '#ffd095', 0.85, '#5c7284', 0.85),
  K(9.0, '#3f86c4', '#bfe0d2', '#ffedc4', 1.15, '#93b8a4', 0.95),
  K(13.0, '#4a93d3', '#c6e4d8', '#fff4d9', 1.35, '#a9cbb2', 1.0),
  K(17.0, '#4a7fae', '#ecc07f', '#ffcf82', 1.05, '#93ae93', 0.9),
  K(18.8, '#27456e', '#e8875a', '#ff9f5c', 0.6, '#4f5f6b', 0.85),
  K(20.2, '#0d2038', '#274854', '#a9c2d8', 0.3, '#263b45', 0.8),
  K(24.0, '#04101e', '#0a2733', '#8fb4cf', 0.22, '#1c2f39', 0.8),
];

const MOON_COLOR = new THREE.Color('#9cc4de');

/* ============================================================
   Motor principal
============================================================ */

const POND = new THREE.Vector2(11, -7);
const POND_R = 6.2;
const WATER_Y = -0.52;

interface Petal {
  tree: number;
  bx: number;
  bz: number;
  phase: number;
  speed: number;
  size: number;
  rx: number;
  ry: number;
  driftX: number;
  driftZ: number;
  prevLife: number;
}

interface Planted {
  mesh: THREE.Mesh;
  t0: number;
  s: number;
}

export class GardenEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private clock = new THREE.Clock();
  private raf = 0;
  private ro: ResizeObserver;
  private disposed = false;

  private params: GardenParams;
  private onStats: (s: GardenStats) => void;
  private noise: ReturnType<typeof makeNoise>;
  private seed: number;

  // luces y entorno
  private sunLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private skyMat: THREE.ShaderMaterial;
  private waterMat: THREE.ShaderMaterial;
  private starsMat: THREE.PointsMaterial;
  private fireflyMat: THREE.ShaderMaterial;
  private lanternLights: THREE.PointLight[] = [];
  private lanternHeads: THREE.MeshLambertMaterial[] = [];
  private lanternGlows: THREE.SpriteMaterial[] = [];
  private cloudMats: THREE.MeshLambertMaterial[] = [];
  private clouds: THREE.Group[] = [];

  // vegetación
  private groundMesh!: THREE.Mesh;
  private grassGroup = new THREE.Group();
  private flowerGroup = new THREE.Group();
  private grassMeshes: THREE.Mesh[] = [];
  private flowerMeshes: THREE.Mesh[] = [];
  private grassCount = 0;
  private flowerCount = 0;
  private bladeGeo: THREE.BufferGeometry;
  private flowerGeos: THREE.BufferGeometry[] = [];
  private flowerMats: THREE.MeshLambertMaterial[] = [];
  private vegUniforms: {
    uTime: { value: number };
    uWind: { value: number };
    uLight: { value: THREE.Color };
    uAmbient: { value: THREE.Color };
  };
  private grassCols: { a: THREE.Color; b: THREE.Color };

  // vida
  private petalMesh!: THREE.InstancedMesh;
  private petals: Petal[] = [];
  private petalDummy = new THREE.Object3D();
  private blossomSpots: THREE.Vector3[] = [];
  private butterflies: {
    g: THREE.Group;
    wl: THREE.Mesh;
    wr: THREE.Mesh;
    cx: number;
    cz: number;
    r: number;
    w: number;
    ph: number;
    y0: number;
  }[] = [];
  private planted: Planted[] = [];
  private bursts: { mesh: THREE.Mesh; t0: number }[] = [];
  private burstMats: THREE.MeshBasicMaterial[] = [];
  private lilies: THREE.Mesh[] = [];

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private downPos = { x: 0, y: 0 };

  private fps = 60;
  private statTimer = 0;
  private rebuildCooldown = 0;
  private audio = new GardenAudio();
  private onReady?: () => void;
  private onError?: (msg: string) => void;
  private readySent = false;
  private useComposer = true;
  private frameFailures = 0;

  constructor(
    container: HTMLElement,
    params: GardenParams,
    onStats: (s: GardenStats) => void,
    onReady?: () => void,
    onError?: (msg: string) => void
  ) {
    this.container = container;
    this.params = { ...params };
    this.onStats = onStats;
    this.onReady = onReady;
    this.onError = onError;

    // three (r182+) requiere WebGL: si no hay contexto, avisamos en pantalla
    const probe = document.createElement('canvas');
    const hasGL = !!(
      probe.getContext('webgl2') || probe.getContext('webgl')
    );
    if (!hasGL) {
      throw new Error(
        'Tu navegador no expone un contexto WebGL. Activa la aceleración gráfica (hardware acceleration) o abre la página en Chrome, Edge o Firefox actualizados.'
      );
    }

    this.seed = Math.floor(Math.random() * 1e9);
    this.noise = makeNoise(this.seed);

    /* --- renderer --- */
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(new THREE.Color('#070d09'), 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    /* --- escena / cámara --- */
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#bcd9c9', 55, 165);
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      700
    );
    this.camera.position.set(13, 8.5, 17);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.1, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 55;
    this.controls.maxPolarAngle = 1.46;
    this.controls.autoRotate = this.params.autoRotate;
    this.controls.autoRotateSpeed = 0.45;

    /* --- post-procesado --- */
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.55,
      0.75,
      0.72
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    try {
      (this.composer as unknown as { renderTarget1: THREE.WebGLRenderTarget }).renderTarget1.samples = 4;
    } catch {
      /* opcional */
    }

    /* --- luces base --- */
    this.sunLight = new THREE.DirectionalLight('#fff2d0', 1.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const sc = this.sunLight.shadow.camera;
    sc.left = -32;
    sc.right = 32;
    sc.top = 32;
    sc.bottom = -32;
    sc.near = 5;
    sc.far = 130;
    this.sunLight.shadow.bias = -0.0006;
    this.scene.add(this.sunLight, this.sunLight.target);
    this.hemi = new THREE.HemisphereLight('#bfe0d2', '#2c4a33', 0.9);
    this.scene.add(this.hemi);

    /* --- uniforms compartidos de vegetación --- */
    this.vegUniforms = {
      uTime: { value: 0 },
      uWind: { value: this.params.wind },
      uLight: { value: new THREE.Color('#fff4d9') },
      uAmbient: { value: new THREE.Color('#5a7a63') },
    };
    this.grassCols = {
      a: new THREE.Color('#2c6139'),
      b: new THREE.Color('#83c25c'),
    };

    /* --- construcción del mundo --- */
    this.skyMat = this.buildSky();
    this.starsMat = this.buildStars();
    this.buildGround();
    this.waterMat = this.buildPond();
    this.buildStonesAndBench();
    this.buildTrees();
    this.buildLanterns();
    this.buildClouds();
    this.bladeGeo = this.makeBladeGeometry();
    this.flowerGeos = this.makeFlowerGeometries();
    this.rebuildGrass();
    this.rebuildFlowers();
    this.buildPetals();
    this.buildButterflies();
    this.fireflyMat = this.buildFireflies();
    this.scene.add(this.grassGroup, this.flowerGroup);

    /* --- eventos --- */
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(container);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);

    this.tick();
  }

  /* ================= terreno ================= */

  private terrainHeight(x: number, z: number) {
    const d = Math.hypot(x - POND.x, z - POND.y);
    const calm = smoothstep(POND_R * 0.6, POND_R * 1.9, d);
    let h = (this.noise.fbm(x * 0.055 + 3.7, z * 0.055 - 1.2) - 0.42) * 4.2 * calm;
    h -= 2.5 * Math.exp(-Math.pow(d / (POND_R * 0.78), 2));
    const r = Math.hypot(x, z);
    h += smoothstep(30, 62, r) * 2.6; // colinas lejanas
    return h;
  }

  private buildGround() {
    const g = new THREE.PlaneGeometry(170, 170, 110, 110);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const cA = new THREE.Color('#39693f');
    const cB = new THREE.Color('#71ab50');
    const cPatch = new THREE.Color('#93c160');
    const cSand = new THREE.Color('#a58d5f');
    const cDark = new THREE.Color('#275032');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.terrainHeight(x, z);
      pos.setY(i, h);
      const d = Math.hypot(x - POND.x, z - POND.y);
      tmp.copy(cA).lerp(cB, smoothstep(-1.4, 2.0, h));
      const patch = this.noise.fbm(x * 0.3 + 40, z * 0.3 + 17);
      tmp.lerp(cPatch, smoothstep(0.55, 0.85, patch) * 0.5);
      tmp.lerp(cSand, smoothstep(POND_R + 2.4, POND_R + 0.3, d) * 0.85);
      tmp.lerp(cDark, smoothstep(0.1, -0.9, h) * 0.55);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.groundMesh = new THREE.Mesh(g, m);
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);
  }

  /* ================= cielo y estrellas ================= */

  private buildSky() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color('#4a93d3') },
        uHorizon: { value: new THREE.Color('#c6e4d8') },
        uSunDir: { value: new THREE.Vector3(0, 1, 0.3) },
        uSunColor: { value: new THREE.Color('#fff4d9') },
        uSunAmt: { value: 1 },
      },
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 20), mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mat;
  }

  private buildStars() {
    const n = 900;
    const arr = new Float32Array(n * 3);
    const rand = mulberry32(777);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const y = 0.06 + rand() * 0.94;
      const rr = Math.sqrt(1 - y * y);
      arr[i * 3] = Math.cos(a) * rr * 300;
      arr[i * 3 + 1] = y * 300;
      arr[i * 3 + 2] = Math.sin(a) * rr * 300;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({
      color: '#d5e6f2',
      size: 1.7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return mat;
  }

  /* ================= estanque ================= */

  private buildPond() {
    const g = new THREE.CircleGeometry(POND_R + 0.7, 52);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSkyTop: { value: new THREE.Color('#4a93d3') },
        uSkyHor: { value: new THREE.Color('#c6e4d8') },
        uSunDir: { value: new THREE.Vector3(0, 1, 0.3) },
        uSunColor: { value: new THREE.Color('#fff4d9') },
        uDay: { value: 1 },
        uDeep: { value: new THREE.Color('#0d3a3d') },
      },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(POND.x, WATER_Y, POND.y);
    mesh.renderOrder = 2;
    this.scene.add(mesh);

    // nenúfares + flor de loto
    const padGeo = new THREE.CircleGeometry(0.42, 18, 0.35, Math.PI * 2 - 0.7);
    padGeo.rotateX(-Math.PI / 2);
    const padMat = new THREE.MeshLambertMaterial({
      color: '#3e7a44',
      side: THREE.DoubleSide,
    });
    const rand = mulberry32(this.seed ^ 99);
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2;
      const rr = 1.2 + rand() * (POND_R - 2);
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(
        POND.x + Math.cos(a) * rr,
        WATER_Y + 0.035,
        POND.y + Math.sin(a) * rr
      );
      pad.rotation.y = rand() * Math.PI * 2;
      const s = 0.7 + rand() * 0.7;
      pad.scale.setScalar(clamp(s, 0.4, 1.6));
      pad.userData.phase = rand() * 10;
      this.scene.add(pad);
      this.lilies.push(pad);
      if (i < 2) {
        const lotus = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.13, 0),
          new THREE.MeshLambertMaterial({
            color: '#f2b8cd',
            emissive: '#5e2440',
            emissiveIntensity: 0.35,
            flatShading: true,
          })
        );
        lotus.position.copy(pad.position);
        lotus.position.y += 0.09;
        lotus.userData.phase = pad.userData.phase + 1.3;
        this.scene.add(lotus);
        this.lilies.push(lotus);
      }
    }
    return mat;
  }

  /* ================= piedras, sendero y banco ================= */

  private buildStonesAndBench() {
    const rand = mulberry32(this.seed ^ 5);
    const stoneMat = new THREE.MeshLambertMaterial({
      color: '#94a08e',
      flatShading: true,
    });
    const start = new THREE.Vector2(-3, 24);
    const end = new THREE.Vector2(
      POND.x * (1 - (POND_R + 1.2) / Math.hypot(POND.x, POND.y)),
      POND.y * (1 - (POND_R + 1.2) / Math.hypot(POND.x, POND.y))
    );
    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      const x = lerp(start.x, end.x, t) + Math.sin(t * Math.PI * 1.4) * 1.6;
      const z = lerp(start.y, end.y, t) + Math.cos(t * Math.PI) * 0.8;
      const stone = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.5 + rand() * 0.3, 0),
        stoneMat
      );
      stone.scale.set(1, 0.22, 0.85);
      stone.position.set(x, this.terrainHeight(x, z) + 0.06, z);
      stone.rotation.y = rand() * Math.PI;
      stone.castShadow = true;
      stone.receiveShadow = true;
      this.scene.add(stone);
    }

    // banco mirando al estanque
    const wood = new THREE.MeshLambertMaterial({ color: '#7c5636' });
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 0.62), wood);
    seat.position.y = 0.52;
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 0.08), wood);
    back.position.set(0, 0.92, -0.28);
    back.rotation.x = -0.12;
    bench.add(seat, back);
    for (const sx of [-0.85, 0.85]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, 0.5), wood);
      leg.position.set(sx, 0.26, 0);
      bench.add(leg);
    }
    const dirN = new THREE.Vector2(-POND.x, -POND.y).normalize();
    const bx = POND.x + dirN.x * (POND_R + 2.4);
    const bz = POND.y + dirN.y * (POND_R + 2.4);
    bench.position.set(bx, this.terrainHeight(bx, bz) + 0.02, bz);
    bench.rotation.y = Math.atan2(POND.x - bx, POND.y - bz);
    bench.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    this.scene.add(bench);
  }

  /* ================= árboles ================= */

  private buildTrees() {
    const specs: {
      a: number;
      r: number;
      s: number;
      type: 'sakura' | 'green' | 'gold';
    }[] = [
      { a: 0.35, r: 14, s: 1.15, type: 'sakura' },
      { a: 1.35, r: 17, s: 1.3, type: 'green' },
      { a: 2.2, r: 15, s: 1.0, type: 'sakura' },
      { a: 3.05, r: 19, s: 1.45, type: 'green' },
      { a: 4.1, r: 16, s: 1.1, type: 'sakura' },
      { a: 4.9, r: 13.5, s: 1.0, type: 'gold' },
      { a: 5.6, r: 19, s: 1.25, type: 'green' },
      { a: -0.55, r: 20, s: 1.2, type: 'sakura' },
    ];
    const palettes = {
      sakura: ['#f0a6c0', '#e68fac'],
      green: ['#57904f', '#6fa95d'],
      gold: ['#d9a441', '#c68f38'],
    };
    const bark = new THREE.MeshLambertMaterial({ color: '#6d4a32' });
    for (const sp of specs) {
      const x = Math.cos(sp.a) * sp.r;
      const z = Math.sin(sp.a) * sp.r;
      const y = this.terrainHeight(x, z);
      const tree = new THREE.Group();
      const s = sp.s;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14 * s, 0.26 * s, 2.5 * s, 7),
        bark
      );
      trunk.position.y = 1.25 * s;
      trunk.castShadow = true;
      tree.add(trunk);
      for (const side of [-1, 1]) {
        const br = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045 * s, 0.075 * s, 1.15 * s, 5),
          bark
        );
        br.position.set(side * 0.45 * s, 1.9 * s, side * 0.1 * s);
        br.rotation.z = side * -0.85;
        br.castShadow = true;
        tree.add(br);
      }
      const pal = palettes[sp.type];
      const blobSpots: [number, number, number, number][] = [
        [0, 2.75, 0, 1.25],
        [0.95, 2.35, 0.35, 0.95],
        [-0.9, 2.4, -0.25, 0.9],
        [0.25, 3.15, -0.75, 0.85],
        [-0.35, 2.3, 0.85, 0.8],
      ];
      blobSpots.forEach((b, i) => {
        const mat = new THREE.MeshLambertMaterial({
          color: pal[i % 2],
          flatShading: true,
        });
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(b[3] * s, 1), mat);
        blob.position.set(b[0] * s, b[1] * s, b[2] * s);
        blob.scale.y = 0.82;
        blob.castShadow = true;
        tree.add(blob);
      });
      tree.position.set(x, y, z);
      tree.rotation.y = sp.a * 3.3;
      this.scene.add(tree);
      if (sp.type === 'sakura')
        this.blossomSpots.push(new THREE.Vector3(x, y + 2.8 * s, z));
    }
  }

  /* ================= faroles ================= */

  private makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,220,160,1)');
    g.addColorStop(0.35, 'rgba(255,190,110,0.55)');
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  private buildLanterns() {
    const glowTex = this.makeGlowTexture();
    const spots: [number, number][] = [
      [-2.4, 19],
      [1.2, 11],
      [5.4, 2.2],
      [POND.x - POND_R - 2.6, POND.y + 3.2],
      [POND.x - 1.5, POND.y + POND_R + 2.6],
    ];
    const postMat = new THREE.MeshLambertMaterial({ color: '#3a3f38' });
    for (const [x, z] of spots) {
      const g = new THREE.Group();
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.075, 1.25, 6),
        postMat
      );
      post.position.y = 0.62;
      post.castShadow = true;
      const headMat = new THREE.MeshLambertMaterial({
        color: '#5a4a36',
        emissive: '#ffbe6a',
        emissiveIntensity: 0.12,
      });
      const head = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.2, 0.34, 8),
        headMat
      );
      head.position.y = 1.36;
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(0.26, 0.16, 8),
        postMat
      );
      cap.position.y = 1.6;
      g.add(post, head, cap);
      const spriteMat = new THREE.SpriteMaterial({
        map: glowTex,
        color: '#ffb066',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.y = 1.36;
      sprite.scale.setScalar(1.9);
      g.add(sprite);
      const light = new THREE.PointLight('#ffb066', 0, 9, 1.9);
      light.position.y = 1.4;
      g.add(light);
      const y = this.terrainHeight(x, z);
      g.position.set(x, y, z);
      this.scene.add(g);
      this.lanternLights.push(light);
      this.lanternHeads.push(headMat);
      this.lanternGlows.push(spriteMat);
    }
  }

  /* ================= nubes ================= */

  private buildClouds() {
    const rand = mulberry32(this.seed ^ 31);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshLambertMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.85,
        flatShading: true,
      });
      const parts: THREE.BufferGeometry[] = [];
      for (let j = 0; j < 3; j++) {
        const part = new THREE.IcosahedronGeometry(1.6 + rand() * 1.4, 1);
        part.scale(1, 0.45, 0.8);
        part.translate((j - 1) * 2.1, rand() * 0.5, (rand() - 0.5) * 1.4);
        parts.push(part);
      }
      const merged = mergeGeometries(parts);
      const mesh = new THREE.Mesh(merged!, mat);
      const a = rand() * Math.PI * 2;
      const rr = 22 + rand() * 34;
      mesh.position.set(Math.cos(a) * rr, 26 + rand() * 9, Math.sin(a) * rr);
      mesh.rotation.y = rand() * Math.PI;
      const grp = new THREE.Group();
      grp.add(mesh);
      grp.userData.speed = 0.12 + rand() * 0.3;
      this.scene.add(grp);
      this.clouds.push(grp);
      this.cloudMats.push(mat);
    }
  }

  /* ================= hierba instanciada ================= */

  private makeBladeGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          -0.045, 0, 0, 0.045, 0, 0, -0.02, 0.5, 0, 0.02, 0.5, 0, 0, 1, 0,
        ]),
        3
      )
    );
    g.setAttribute(
      'normal',
      new THREE.BufferAttribute(
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        3
      )
    );
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    return g;
  }

  private rebuildGrass() {
    for (const m of this.grassMeshes) {
      this.grassGroup.remove(m);
      m.geometry.dispose();
    }
    this.grassMeshes = [];
    const density = clamp(this.params.grassDensity, 0, 1);
    const count = Math.floor(9000 * density);
    this.grassCount = count;
    if (count < 10) return;

    const rand = mulberry32(this.seed ^ 1234);
    const offsets = new Float32Array(count * 3);
    const scales = new Float32Array(count);
    const phases = new Float32Array(count);
    const tints = new Float32Array(count);
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 6) {
      guard++;
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * 31;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const d = Math.hypot(x - POND.x, z - POND.y);
      if (d < POND_R + 1.1) continue;
      const y = this.terrainHeight(x, z);
      if (y < WATER_Y + 0.05) continue;
      offsets[placed * 3] = x;
      offsets[placed * 3 + 1] = y - 0.02;
      offsets[placed * 3 + 2] = z;
      scales[placed] = 0.5 + rand() * 0.85;
      phases[placed] = rand() * Math.PI * 2;
      tints[placed] = rand();
      placed++;
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', this.bladeGeo.getAttribute('position'));
    g.setAttribute('normal', this.bladeGeo.getAttribute('normal'));
    g.setIndex(this.bladeGeo.getIndex());
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    g.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 1));
    g.instanceCount = placed;
    const mat = new THREE.ShaderMaterial({
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.vegUniforms.uTime,
        uWind: this.vegUniforms.uWind,
        uLight: this.vegUniforms.uLight,
        uAmbient: this.vegUniforms.uAmbient,
        uColA: { value: this.grassCols.a },
        uColB: { value: this.grassCols.b },
      },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    this.grassGroup.add(mesh);
    this.grassMeshes.push(mesh);
  }

  /* ================= flores (4 especies) ================= */

  private paint(g: THREE.BufferGeometry, hex: string) {
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }

  private stem(h: number, hex = '#3f7d44') {
    const g = new THREE.CylinderGeometry(0.016, 0.025, h, 5);
    g.translate(0, h / 2, 0);
    return this.paint(g, hex);
  }

  private makeFlowerGeometries() {
    const geos: THREE.BufferGeometry[] = [];

    // — margarita —
    {
      const parts: THREE.BufferGeometry[] = [this.stem(0.55)];
      const leaf = this.paint(new THREE.PlaneGeometry(0.15, 0.05), '#4c8f4f');
      leaf.rotateZ(0.55);
      leaf.rotateY(0.9);
      leaf.translate(0.07, 0.19, 0);
      parts.push(leaf);
      const center = this.paint(new THREE.SphereGeometry(0.055, 8, 6), '#e8b13c');
      center.translate(0, 0.585, 0);
      parts.push(center);
      for (let i = 0; i < 8; i++) {
        const petal = this.paint(new THREE.PlaneGeometry(0.16, 0.055), '#f4f0e0');
        petal.rotateX(-Math.PI / 2 + 0.22);
        const m = new THREE.Matrix4()
          .makeRotationY((i / 8) * Math.PI * 2)
          .multiply(new THREE.Matrix4().makeTranslation(0.12, 0, 0));
        petal.applyMatrix4(m);
        petal.translate(0, 0.58, 0);
        parts.push(petal);
      }
      geos.push(mergeGeometries(parts)!);
    }

    // — amapola —
    {
      const parts: THREE.BufferGeometry[] = [this.stem(0.5)];
      const bud = this.paint(new THREE.IcosahedronGeometry(0.115, 1), '#d94f3d');
      bud.scale(1, 0.74, 1);
      bud.translate(0, 0.565, 0);
      parts.push(bud);
      const core = this.paint(new THREE.SphereGeometry(0.038, 6, 5), '#3a2430');
      core.translate(0, 0.635, 0);
      parts.push(core);
      const calyx = this.paint(new THREE.ConeGeometry(0.05, 0.09, 6), '#4c8f4f');
      calyx.rotateX(Math.PI);
      calyx.translate(0, 0.48, 0);
      parts.push(calyx);
      geos.push(mergeGeometries(parts)!);
    }

    // — lavanda —
    {
      const parts: THREE.BufferGeometry[] = [this.stem(0.74, '#47814b')];
      const rand = mulberry32(42);
      for (let i = 0; i < 6; i++) {
        const b = this.paint(
          new THREE.SphereGeometry(0.042, 6, 5),
          i > 3 ? '#b79ae8' : '#9b7ede'
        );
        b.translate(
          (rand() - 0.5) * 0.045,
          0.52 + i * 0.052,
          (rand() - 0.5) * 0.045
        );
        parts.push(b);
      }
      const leaf = this.paint(new THREE.PlaneGeometry(0.18, 0.04), '#559257');
      leaf.rotateZ(-0.7);
      leaf.rotateY(-0.6);
      leaf.translate(-0.08, 0.3, 0);
      parts.push(leaf);
      geos.push(mergeGeometries(parts)!);
    }

    // — tulipán dorado —
    {
      const parts: THREE.BufferGeometry[] = [this.stem(0.5, '#3f7d44')];
      const cup = this.paint(
        new THREE.ConeGeometry(0.115, 0.2, 7, 1, true),
        '#f0a83f'
      );
      cup.translate(0, 0.56, 0);
      parts.push(cup);
      const inner = this.paint(new THREE.SphereGeometry(0.04, 6, 5), '#7a4a22');
      inner.translate(0, 0.55, 0);
      parts.push(inner);
      const leaf = this.paint(new THREE.PlaneGeometry(0.22, 0.07), '#4c8f4f');
      leaf.rotateZ(0.9);
      leaf.rotateY(0.4);
      leaf.translate(0.1, 0.2, 0);
      parts.push(leaf);
      geos.push(mergeGeometries(parts)!);
    }

    for (const geo of geos) {
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      });
      this.flowerMats.push(mat);
    }
    return geos;
  }

  private rebuildFlowers() {
    for (const m of this.flowerMeshes) {
      this.flowerGroup.remove(m);
      m.geometry.dispose();
    }
    this.flowerMeshes = [];
    const density = clamp(this.params.flowerDensity, 0, 1);
    const total = Math.floor(1250 * density);
    this.flowerCount = total;
    if (total < 4) return;

    const weights = [0.3, 0.24, 0.24, 0.22];
    const rand = mulberry32(this.seed ^ 999);
    const buckets: { x: number; y: number; z: number; ph: number; sc: number }[][] =
      [[], [], [], []];
    let placed = 0;
    let guard = 0;
    while (placed < total && guard < total * 6) {
      guard++;
      const a = rand() * Math.PI * 2;
      const rr = 2 + Math.sqrt(rand()) * 28;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const d = Math.hypot(x - POND.x, z - POND.y);
      if (d < POND_R + 1.3) continue;
      const y = this.terrainHeight(x, z);
      if (y < WATER_Y + 0.08) continue;
      let pick = rand();
      let sp = 0;
      for (let i = 0; i < 4; i++) {
        pick -= weights[i];
        if (pick <= 0) {
          sp = i;
          break;
        }
      }
      buckets[sp].push({
        x,
        y: y - 0.02,
        z,
        ph: rand() * Math.PI * 2,
        sc: 0.75 + rand() * 0.6,
      });
      placed++;
    }

    buckets.forEach((bucket, sp) => {
      if (bucket.length === 0) return;
      const base = this.flowerGeos[sp];
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('normal', base.getAttribute('normal'));
      g.setAttribute('color', base.getAttribute('color'));
      g.setIndex(base.getIndex());
      const n = bucket.length;
      const offs = new Float32Array(n * 3);
      const scs = new Float32Array(n);
      const phs = new Float32Array(n);
      bucket.forEach((b, i) => {
        offs[i * 3] = b.x;
        offs[i * 3 + 1] = b.y;
        offs[i * 3 + 2] = b.z;
        scs[i] = clamp(b.sc, 0.3, 2);
        phs[i] = b.ph;
      });
      g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offs, 3));
      g.setAttribute('aScale', new THREE.InstancedBufferAttribute(scs, 1));
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phs, 1));
      g.instanceCount = n;
      const mat = new THREE.ShaderMaterial({
        vertexShader: FLOWER_VERT,
        fragmentShader: FLOWER_FRAG,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: this.vegUniforms.uTime,
          uWind: this.vegUniforms.uWind,
          uLight: this.vegUniforms.uLight,
          uAmbient: this.vegUniforms.uAmbient,
        },
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      this.flowerGroup.add(mesh);
      this.flowerMeshes.push(mesh);
    });
  }

  /* ================= pétalos ================= */

  private buildPetals() {
    const N = 320;
    const geo = new THREE.PlaneGeometry(0.12, 0.09);
    const mat = new THREE.MeshLambertMaterial({
      color: '#f6c3d4',
      emissive: '#3d1524',
      emissiveIntensity: 0.25,
      side: THREE.DoubleSide,
    });
    this.petalMesh = new THREE.InstancedMesh(geo, mat, N);
    this.petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const cols = new Float32Array(N * 3);
    const c1 = new THREE.Color('#f7c8d8');
    const c2 = new THREE.Color('#f0a6c0');
    const rand = mulberry32(this.seed ^ 777);
    for (let i = 0; i < N; i++) {
      const c = rand() > 0.5 ? c1 : c2;
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
      this.petals.push({
        tree: Math.floor(rand() * Math.max(1, this.blossomSpots.length)),
        bx: (rand() - 0.5) * 3.2,
        bz: (rand() - 0.5) * 3.2,
        phase: rand(),
        speed: 0.045 + rand() * 0.05,
        size: 0.7 + rand() * 0.6,
        rx: 1 + rand() * 2,
        ry: 1 + rand() * 2,
        driftX: 0,
        driftZ: 0,
        prevLife: 0,
      });
    }
    this.petalMesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
    this.petalMesh.frustumCulled = false;
    this.scene.add(this.petalMesh);
  }

  private updatePetals(dt: number, t: number) {
    const wind = this.params.wind;
    const spots = this.blossomSpots;
    if (spots.length === 0) return;
    for (let i = 0; i < this.petals.length; i++) {
      const p = this.petals[i];
      const tree = spots[p.tree % spots.length];
      const life = (t * p.speed + p.phase) % 1;
      if (life < p.prevLife) {
        p.driftX = 0;
        p.driftZ = 0;
        p.bx = (Math.random() - 0.5) * 3.2;
        p.bz = (Math.random() - 0.5) * 3.2;
      }
      p.prevLife = life;
      p.driftX += (1.1 + wind * 1.5) * dt;
      p.driftZ += (0.35 + wind * 0.5) * dt;
      const groundY = this.terrainHeight(tree.x + p.bx + p.driftX, tree.z + p.bz + p.driftZ);
      const topY = tree.y + 1.1;
      const y = Math.max(groundY + 0.04, topY - life * (topY - groundY + 0.4));
      const sway = Math.sin(t * 2.2 + p.phase * 20) * (0.35 + wind * 0.25);
      this.petalDummy.position.set(
        tree.x + p.bx + p.driftX + sway,
        y,
        tree.z + p.bz + p.driftZ + Math.cos(t * 1.7 + p.phase * 13) * 0.25
      );
      this.petalDummy.rotation.set(t * p.rx + p.phase * 9, t * p.ry, p.phase * 6);
      this.petalDummy.scale.setScalar(clamp(p.size, 0.2, 2));
      this.petalDummy.updateMatrix();
      this.petalMesh.setMatrixAt(i, this.petalDummy.matrix);
    }
    this.petalMesh.instanceMatrix.needsUpdate = true;
    this.petalMesh.visible = this.params.petals;
  }

  /* ================= mariposas ================= */

  private buildButterflies() {
    const colors = ['#f2a03d', '#5fb7d9', '#e8e2d0', '#d96a8b'];
    const rand = mulberry32(this.seed ^ 4242);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const wingMat = new THREE.MeshLambertMaterial({
        color: colors[i],
        emissive: colors[i],
        emissiveIntensity: 0.18,
        side: THREE.DoubleSide,
      });
      const wingGeoR = new THREE.CircleGeometry(0.13, 10);
      wingGeoR.scale(1.3, 1, 1);
      wingGeoR.rotateX(-Math.PI / 2);
      wingGeoR.translate(0.12, 0, 0);
      const wingGeoL = wingGeoR.clone();
      wingGeoL.translate(-0.24, 0, 0);
      const wr = new THREE.Mesh(wingGeoR, wingMat);
      const wl = new THREE.Mesh(wingGeoL, wingMat);
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 6, 5),
        new THREE.MeshLambertMaterial({ color: '#2f2a26' })
      );
      body.scale.set(1, 1, 2.6);
      g.add(wr, wl, body);
      const a = rand() * Math.PI * 2;
      const rr = 4 + rand() * 16;
      g.scale.setScalar(1.15);
      this.scene.add(g);
      this.butterflies.push({
        g,
        wl,
        wr,
        cx: Math.cos(a) * rr * 0.6,
        cz: Math.sin(a) * rr * 0.6,
        r: 2.5 + rand() * 4.5,
        w: 0.25 + rand() * 0.3,
        ph: rand() * 10,
        y0: 1.1 + rand() * 0.9,
      });
    }
  }

  private updateButterflies(t: number, dt: number) {
    for (const b of this.butterflies) {
      const a = t * b.w + b.ph;
      const x = b.cx + Math.cos(a) * b.r;
      const z = b.cz + Math.sin(a) * b.r * 0.75;
      const gy = this.terrainHeight(x, z);
      const y = gy + b.y0 + Math.sin(t * 1.9 + b.ph) * 0.35;
      b.g.position.set(x, y, z);
      const vx = -Math.sin(a) * b.r * b.w;
      const vz = Math.cos(a) * b.r * 0.75 * b.w;
      b.g.rotation.y = Math.atan2(vx, vz);
      const flap = Math.sin(t * 16 + b.ph * 3) * 0.85;
      b.wr.rotation.z = flap;
      b.wl.rotation.z = -flap;
      b.g.visible = this.params.butterflies;
    }
    void dt;
  }

  /* ================= luciérnagas ================= */

  private buildFireflies() {
    const N = 140;
    const rand = mulberry32(this.seed ^ 616);
    const pos = new Float32Array(N * 3);
    const ph = new Float32Array(N);
    const sp = new Float32Array(N);
    const anchors = [
      [POND.x, POND.y],
      ...this.blossomSpots.map((s) => [s.x, s.z] as [number, number]),
      [0, 6],
    ];
    for (let i = 0; i < N; i++) {
      const a = anchors[Math.floor(rand() * anchors.length)];
      pos[i * 3] = a[0] + (rand() - 0.5) * 9;
      pos[i * 3 + 2] = a[1] + (rand() - 0.5) * 9;
      pos[i * 3 + 1] =
        this.terrainHeight(pos[i * 3], pos[i * 3 + 2]) + 0.4 + rand() * 1.9;
      ph[i] = rand() * Math.PI * 2;
      sp[i] = 0.6 + rand() * 1.1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(sp, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: FIREFLY_VERT,
      fragmentShader: FIREFLY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#ffd98a') },
        uOpacity: { value: 0 },
      },
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return mat;
  }

  /* ================= plantar con clic ================= */

  private onDown = (e: PointerEvent) => {
    this.downPos = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const dx = e.clientX - this.downPos.x;
    const dy = e.clientY - this.downPos.y;
    if (Math.hypot(dx, dy) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.groundMesh, false);
    if (hits.length === 0) return;
    const pt = hits[0].point;
    const d = Math.hypot(pt.x - POND.x, pt.z - POND.y);
    if (d < POND_R + 0.9) return;
    if (Math.hypot(pt.x, pt.z) > 40) return;
    this.plant(pt);
  };

  private plant(pt: THREE.Vector3) {
    const sp = Math.floor(Math.random() * this.flowerGeos.length);
    const mesh = new THREE.Mesh(this.flowerGeos[sp], this.flowerMats[sp]);
    mesh.position.set(pt.x, pt.y - 0.01, pt.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.castShadow = true;
    const s = clamp(0.85 + Math.random() * 0.5, 0.4, 1.6);
    mesh.scale.setScalar(0.001);
    this.scene.add(mesh);
    this.planted.push({ mesh, t0: this.clock.elapsedTime, s });
    if (this.planted.length > 110) {
      const old = this.planted.shift()!;
      this.scene.remove(old.mesh);
    }
    // onda expansiva
    const bi = this.bursts.length % 14;
    let burst = this.bursts[bi];
    if (!burst) {
      const bm = new THREE.MeshBasicMaterial({
        color: '#d8f0a0',
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const bmesh = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.42, 26), bm);
      bmesh.rotation.x = -Math.PI / 2;
      this.scene.add(bmesh);
      burst = { mesh: bmesh, t0: 0 };
      this.bursts.push(burst);
      this.burstMats.push(bm);
    }
    burst.mesh.position.set(pt.x, pt.y + 0.06, pt.z);
    burst.t0 = this.clock.elapsedTime;
    burst.mesh.visible = true;
    this.audio.pluck();
  }

  /* ================= parámetros ================= */

  setParams(next: GardenParams) {
    const prev = this.params;
    this.params = {
      ...next,
      timeOfDay: clamp(next.timeOfDay, 0, 24),
      wind: clamp(next.wind, 0, 3),
      flowerDensity: clamp(next.flowerDensity, 0, 1),
      grassDensity: clamp(next.grassDensity, 0, 1),
      bloom: clamp(next.bloom, 0, 1.5),
    };
    this.controls.autoRotate = this.params.autoRotate;
    this.audio.setWind(this.params.wind);
    if (this.params.sound && !this.audio.enabled) void this.audio.enable();
    if (!this.params.sound && this.audio.enabled) this.audio.disable();

    const grassDelta = Math.abs(prev.grassDensity - this.params.grassDensity);
    const flowerDelta = Math.abs(prev.flowerDensity - this.params.flowerDensity);
    const now = performance.now();
    if ((grassDelta > 0.04 || flowerDelta > 0.04) && now > this.rebuildCooldown) {
      this.rebuildCooldown = now + 180;
      if (grassDelta > 0.04) this.rebuildGrass();
      if (flowerDelta > 0.04) this.rebuildFlowers();
    }
  }

  replant() {
    // nueva semilla solo para la vegetación: el terreno no cambia,
    // así la hierba y las flores siguen pegadas a la superficie
    this.seed = Math.floor(Math.random() * 1e9);
    for (const p of this.planted) this.scene.remove(p.mesh);
    this.planted = [];
    this.rebuildGrass();
    this.rebuildFlowers();
  }

  /* ================= entorno por hora ================= */

  private tmpTop = new THREE.Color();
  private tmpHor = new THREE.Color();
  private tmpSun = new THREE.Color();
  private tmpAmb = new THREE.Color();
  private sunDir = new THREE.Vector3();

  private sampleEnv(h: number) {
    const hh = ((h % 24) + 24) % 24;
    let i = 0;
    while (i < ENV_KEYS.length - 2 && ENV_KEYS[i + 1].h < hh) i++;
    const A = ENV_KEYS[i];
    const B = ENV_KEYS[i + 1];
    const u = smoothstep(A.h, B.h, hh);
    this.tmpTop.lerpColors(A.top, B.top, u);
    this.tmpHor.lerpColors(A.hor, B.hor, u);
    this.tmpSun.lerpColors(A.sun, B.sun, u);
    this.tmpAmb.lerpColors(A.amb, B.amb, u);
    return {
      sunI: lerp(A.sunI, B.sunI, u),
      ambI: lerp(A.ambI, B.ambI, u),
    };
  }

  private updateEnvironment() {
    const t = this.params.timeOfDay;
    const { sunI, ambI } = this.sampleEnv(t);
    const theta = ((t - 6) / 24) * Math.PI * 2;
    this.sunDir.set(Math.cos(theta), Math.sin(theta), 0.32).normalize();
    const elev = this.sunDir.y;
    const daylight = smoothstep(-0.08, 0.28, elev);
    const dusk = 1 - smoothstep(-0.06, 0.22, elev);

    // sol / luna
    const isMoon = elev < -0.02;
    const lightDir = isMoon
      ? this.sunDir.clone().multiplyScalar(-1).normalize()
      : this.sunDir;
    this.sunLight.position.copy(lightDir).multiplyScalar(48);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.color.copy(this.tmpSun);
    if (isMoon) this.sunLight.color.lerp(MOON_COLOR, 0.75);
    this.sunLight.intensity = sunI * (isMoon ? 0.85 : 1);
    this.sunLight.castShadow = daylight > 0.03;

    this.hemi.color.copy(this.tmpHor).lerp(this.tmpTop, 0.4);
    this.hemi.groundColor.set('#24402c').lerp(new THREE.Color('#0e1a20'), dusk);
    this.hemi.intensity = ambI * 0.95;

    // cielo
    const su = this.skyMat.uniforms;
    (su.uTop.value as THREE.Color).copy(this.tmpTop);
    (su.uHorizon.value as THREE.Color).copy(this.tmpHor);
    (su.uSunDir.value as THREE.Vector3).copy(lightDir);
    (su.uSunColor.value as THREE.Color).copy(
      isMoon ? MOON_COLOR : this.tmpSun
    );
    su.uSunAmt.value = isMoon ? 0.5 : 0.4 + daylight * 0.9;

    // niebla
    (this.scene.fog as THREE.Fog).color.copy(this.tmpHor);

    // estrellas y luciérnagas
    this.starsMat.opacity = dusk * 0.9;
    this.fireflyMat.uniforms.uOpacity.value =
      this.params.fireflies ? dusk * 0.95 : 0;

    // agua
    const wu = this.waterMat.uniforms;
    (wu.uSkyTop.value as THREE.Color).copy(this.tmpTop);
    (wu.uSkyHor.value as THREE.Color).copy(this.tmpHor);
    (wu.uSunDir.value as THREE.Vector3).copy(lightDir);
    (wu.uSunColor.value as THREE.Color).copy(isMoon ? MOON_COLOR : this.tmpSun);
    wu.uDay.value = daylight;

    // vegetación (luces propias del shader)
    this.vegUniforms.uLight.value
      .copy(this.tmpSun)
      .multiplyScalar(clamp(sunI, 0, 1.6));
    this.vegUniforms.uAmbient.value
      .copy(this.tmpAmb)
      .multiplyScalar(clamp(ambI * 0.62, 0.16, 1));
    this.vegUniforms.uWind.value = this.params.wind;

    // faroles
    const lanternAmt = dusk;
    for (const l of this.lanternLights) l.intensity = lanternAmt * 7;
    for (const h of this.lanternHeads)
      h.emissiveIntensity = 0.1 + lanternAmt * 2.1;
    for (const g of this.lanternGlows) g.opacity = lanternAmt * 0.8;

    // nubes
    const cloudDay = new THREE.Color('#ffffff');
    const cloudNight = new THREE.Color('#31424e');
    for (const m of this.cloudMats) {
      m.color.copy(cloudDay).lerp(cloudNight, dusk);
      m.opacity = 0.85 - dusk * 0.5;
    }

    // bloom
    this.bloomPass.strength = this.params.bloom * (0.55 + dusk * 0.75);

    return { daylight, dusk };
  }

  /* ================= bucle ================= */

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    try {
      const dt = Math.min(0.05, this.clock.getDelta());
      const t = this.clock.elapsedTime;

      const env = this.updateEnvironment();
      this.vegUniforms.uTime.value = t;
      this.waterMat.uniforms.uTime.value = t;
      this.fireflyMat.uniforms.uTime.value = t;

      this.updatePetals(dt, t);
      this.updateButterflies(t, dt);

      // nenúfares flotando
      for (const l of this.lilies) {
        l.position.y +=
          (WATER_Y + 0.035 + Math.sin(t * 1.3 + l.userData.phase) * 0.012 -
            l.position.y) *
          Math.min(1, dt * 4);
      }

      // nubes a la deriva
      for (const c of this.clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > 70) c.position.x = -70;
      }

      // flores plantadas (pop elástico)
      for (const p of this.planted) {
        const k = clamp((t - p.t0) / 0.6, 0, 1);
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const ease =
          1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
        p.mesh.scale.setScalar(Math.max(0.001, p.s * ease));
      }

      // ondas de plantado
      for (const b of this.bursts) {
        const k = (t - b.t0) / 0.7;
        if (k <= 0 || k >= 1) {
          b.mesh.visible = false;
          continue;
        }
        b.mesh.visible = true;
        const s = 0.2 + k * 1.5;
        b.mesh.scale.setScalar(s);
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k);
      }

      this.controls.update();
      // render con bloom; si algo del post-procesado falla en esta GPU,
      // caemos a render directo para que el jardín nunca desaparezca
      if (this.useComposer) {
        try {
          this.composer.render();
        } catch {
          this.useComposer = false;
          this.renderer.render(this.scene, this.camera);
        }
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      void env;

      this.frameFailures = 0;
      if (!this.readySent) {
        this.readySent = true;
        this.onReady?.();
      }

      // estadísticas
      this.fps = this.fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
      this.statTimer += dt;
      if (this.statTimer > 0.25) {
        this.statTimer = 0;
        const h = this.params.timeOfDay;
        const hh = Math.floor(h) % 24;
        const mm = Math.floor((h % 1) * 60);
        const phase =
          h < 5.5 ? 'Noche' : h < 8 ? 'Amanecer' : h < 17.5 ? 'Día' : h < 20 ? 'Atardecer' : 'Noche';
        this.onStats({
          fps: Math.round(this.fps),
          grass: this.grassCount,
          flowers: this.flowerCount + this.planted.length,
          petals: this.params.petals ? this.petals.length : 0,
          fireflies: this.params.fireflies ? 140 : 0,
          sunDeg: Math.round(Math.asin(clamp(this.sunDir.y, -1, 1)) * (180 / Math.PI)),
          timeLabel: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
          phase,
        });
      }
    } catch (err) {
      // si un frame revienta, lo contamos; tras varios avisamos a la interfaz
      this.frameFailures++;
      if (this.frameFailures > 20) {
        cancelAnimationFrame(this.raf);
        this.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
  };

  /* ================= tamaño y limpieza ================= */

  private onResize() {
    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointerup', this.onUp);
    this.audio.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (el.parentElement === this.container) this.container.removeChild(el);
  }
}
