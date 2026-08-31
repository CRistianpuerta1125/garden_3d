import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface GardenParams {
  timeOfDay: number;
  wind: number;
  flowerDensity: number;
  grassDensity: number;
  fireflies: boolean;
  petals: boolean;
  butterflies: boolean;
  bloom: number;
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
   Audio Ambiental
============================================================ */
class GardenAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  enabled = false;

  async enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);

      // Viento sintetizado
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 320;
      bp.Q.value = 0.5;

      this.windGain = this.ctx.createGain();
      this.windGain.gain.value = 0.05;

      src.connect(bp).connect(this.windGain).connect(this.master);
      src.start();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.ctx && this.windGain) {
      this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    }
  }

  setWind(speed: number) {
    if (this.ctx && this.windGain && this.enabled) {
      this.windGain.gain.setTargetAtTime(Math.min(speed, 3) * 0.08, this.ctx.currentTime, 0.3);
    }
  }

  dispose() {
    if (this.ctx) this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}

export class GardenEngine {
  private container: HTMLElement;
  private params: GardenParams;
  private onStats: (s: GardenStats) => void;
  private onReady?: () => void;
  private onError?: (msg: string) => void;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;

  private dirLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private groundMesh: THREE.Mesh;

  private modelsGroup = new THREE.Group();
  private loadedModels: {
    tree?: THREE.Group;
    plant?: THREE.Group;
    roses?: THREE.Group;
    rocks?: THREE.Group;
  } = {};

  // Partículas y Efectos
  private firefliesMesh: THREE.Points | null = null;
  private fireflyPositions: Float32Array | null = null;

  private petalsMesh: THREE.InstancedMesh | null = null;
  private petalDummy = new THREE.Object3D();
  private petalData: { x: number; y: number; z: number; rx: number; ry: number; speed: number }[] = [];

  private butterfliesGroup = new THREE.Group();
  private butterflies: { group: THREE.Group; wingLeft: THREE.Mesh; wingRight: THREE.Mesh; speed: number; radius: number; angle: number }[] = [];

  private audio = new GardenAudio();
  private animFrameId: number = 0;
  private clock = new THREE.Clock();
  private fpsCount = 0;
  private fpsTimer = 0;
  private currentFps = 60;

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

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    // Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1a291e');
    this.scene.fog = new THREE.FogExp2('#1a291e', 0.015);

    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      250
    );
    this.camera.position.set(12, 10, 16);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 1, 0);
    this.controls.autoRotate = this.params.autoRotate;
    this.controls.autoRotateSpeed = 0.8;

    // Post-processing Bloom
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      this.params.bloom * 0.7,
      0.6,
      0.8
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // Lights
    this.hemiLight = new THREE.HemisphereLight('#eef7e4', '#1b301e', 1.2);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight('#fff5db', 1.8);
    this.dirLight.position.set(15, 25, 15);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.bias = -0.0005;
    this.scene.add(this.dirLight);

    // Ground
    const groundGeo = new THREE.CylinderGeometry(18, 18, 0.4, 64);
    const groundMat = new THREE.MeshStandardMaterial({
      color: '#2a442d',
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.position.y = -0.2;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    this.scene.add(this.modelsGroup);
    this.scene.add(this.butterfliesGroup);

    // Build Effects
    this.buildFireflies();
    this.buildPetals();
    this.buildButterflies();

    // Event listeners
    window.addEventListener('resize', this.onResize);

    // Load Models
    this.loadModels();

    // Start loop
    this.animate();
  }

  /* ============================================================
     Modelos GLB
  ============================================================ */
  private loadModels() {
    const loader = new GLTFLoader();
    const assets = [
      { key: 'tree', path: '/models/tree.glb', targetH: 6.0 },
      { key: 'plant', path: '/models/plant.glb', targetH: 1.6 },
      { key: 'roses', path: '/models/roses_flower.glb', targetH: 1.2 },
      { key: 'rocks', path: '/models/rocks.glb', targetH: 1.0 },
    ];

    let loaded = 0;
    assets.forEach((asset) => {
      loader.load(
        asset.path,
        (gltf) => {
          const model = gltf.scene;

          model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const m = child as THREE.Mesh;
              m.castShadow = true;
              m.receiveShadow = true;
              if (m.material) {
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                mats.forEach((mat) => {
                  mat.side = THREE.DoubleSide;
                });
              }
            }
          });

          model.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const h = size.y > 0.001 ? size.y : Math.max(size.x, size.z, 0.1);
          const scaleFactor = asset.targetH / h;
          model.scale.setScalar(scaleFactor);

          model.updateMatrixWorld(true);
          const scaledBox = new THREE.Box3().setFromObject(model);
          model.position.y = -scaledBox.min.y;

          const wrapper = new THREE.Group();
          wrapper.add(model);

          this.loadedModels[asset.key as keyof typeof this.loadedModels] = wrapper;
          loaded++;

          if (loaded === assets.length) {
            this.buildGardenScene();
            if (this.onReady) this.onReady();
          }
        },
        undefined,
        (err) => {
          console.error(`Error loading model ${asset.path}:`, err);
          loaded++;
          if (loaded === assets.length) {
            this.buildGardenScene();
            if (this.onReady) this.onReady();
          }
        }
      );
    });
  }

  public buildGardenScene() {
    while (this.modelsGroup.children.length > 0) {
      this.modelsGroup.remove(this.modelsGroup.children[0]);
    }

    const flowerCount = Math.floor(60 * this.params.flowerDensity);
    const plantCount = Math.floor(40 * this.params.flowerDensity);

    // 1. Árboles
    if (this.loadedModels.tree) {
      const treePositions = [
        { x: -8, z: -6, s: 1.2 },
        { x: 9, z: -8, s: 1.1 },
        { x: -10, z: 7, s: 1.3 },
        { x: 8, z: 8, s: 1.0 },
        { x: 0, z: -11, s: 1.4 },
        { x: -11, z: 0, s: 1.1 },
      ];
      treePositions.forEach((pos, idx) => {
        const tree = this.loadedModels.tree!.clone(true);
        tree.position.set(pos.x, 0, pos.z);
        tree.rotation.y = idx * 1.2;
        tree.scale.setScalar(pos.s);
        tree.userData = { initialRotY: idx * 1.2, isTree: true };
        this.modelsGroup.add(tree);
      });
    }

    // 2. Rosas
    if (this.loadedModels.roses) {
      for (let i = 0; i < flowerCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 2 + Math.random() * 12;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        const rose = this.loadedModels.roses.clone(true);
        const s = 0.6 + Math.random() * 0.7;
        const rotY = Math.random() * Math.PI * 2;
        rose.position.set(x, 0, z);
        rose.rotation.y = rotY;
        rose.scale.setScalar(s);
        rose.userData = { initialRotY: rotY, isPlant: true, phase: Math.random() * 10 };
        this.modelsGroup.add(rose);
      }
    }

    // 3. Plantas
    if (this.loadedModels.plant) {
      for (let i = 0; i < plantCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 3 + Math.random() * 11;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        const plant = this.loadedModels.plant.clone(true);
        const s = 0.7 + Math.random() * 0.7;
        const rotY = Math.random() * Math.PI * 2;
        plant.position.set(x, 0, z);
        plant.rotation.y = rotY;
        plant.scale.setScalar(s);
        plant.userData = { initialRotY: rotY, isPlant: true, phase: Math.random() * 10 };
        this.modelsGroup.add(plant);
      }
    }

    // 4. Rocas
    if (this.loadedModels.rocks) {
      const rockPositions = [
        { x: -4, z: -3 }, { x: 5, z: 2 }, { x: -2, z: 6 },
        { x: 6, z: -5 }, { x: -6, z: 4 }, { x: 3, z: 7 }
      ];
      rockPositions.forEach((pos, idx) => {
        const rock = this.loadedModels.rocks!.clone(true);
        const s = 0.7 + Math.random() * 0.6;
        rock.position.set(pos.x, 0, pos.z);
        rock.rotation.y = idx * 1.5;
        rock.scale.setScalar(s);
        this.modelsGroup.add(rock);
      });
    }
  }

  /* ============================================================
     Sistemas de Partículas & Fauna
  ============================================================ */

  private buildFireflies() {
    const count = 60;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 1] = 0.5 + Math.random() * 3.5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 26;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const mat = new THREE.PointsMaterial({
      color: '#e6ff70',
      size: 0.25,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });

    this.fireflyPositions = pos;
    this.firefliesMesh = new THREE.Points(geo, mat);
    this.scene.add(this.firefliesMesh);
  }

  private buildPetals() {
    const count = 70;
    const geo = new THREE.PlaneGeometry(0.12, 0.08);
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffb3c6',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });

    this.petalsMesh = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) {
      this.petalData.push({
        x: (Math.random() - 0.5) * 24,
        y: 1 + Math.random() * 6,
        z: (Math.random() - 0.5) * 24,
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI,
        speed: 0.4 + Math.random() * 0.6,
      });
    }
    this.scene.add(this.petalsMesh);
  }

  private buildButterflies() {
    const colors = ['#f59e0b', '#3b82f6', '#ec4899'];
    for (let i = 0; i < 4; i++) {
      const bGroup = new THREE.Group();
      const wingMat = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length],
        side: THREE.DoubleSide,
        roughness: 0.4,
      });

      const wingGeo = new THREE.CircleGeometry(0.15, 8);
      wingGeo.scale(1, 0.7, 1);

      const wingL = new THREE.Mesh(wingGeo, wingMat);
      wingL.position.x = -0.12;

      const wingR = new THREE.Mesh(wingGeo, wingMat);
      wingR.position.x = 0.12;

      bGroup.add(wingL, wingR);
      this.butterfliesGroup.add(bGroup);

      this.butterflies.push({
        group: bGroup,
        wingLeft: wingL,
        wingRight: wingR,
        speed: 0.8 + Math.random() * 0.6,
        radius: 4 + Math.random() * 6,
        angle: Math.random() * Math.PI * 2,
      });
    }
  }

  /* ============================================================
     Actualización por hora y ambiente
  ============================================================ */

  private updateEnvironment() {
    const hour = this.params.timeOfDay;

    // Calcular posición e intensidad solar
    const theta = ((hour - 6) / 24) * Math.PI * 2;
    const sunY = Math.sin(theta);
    const sunX = Math.cos(theta);

    this.dirLight.position.set(sunX * 30, Math.max(sunY * 30, -5), 15);

    // Transición de colores por hora
    const isNight = hour < 6 || hour > 19;
    const isSunset = (hour >= 17 && hour <= 19) || (hour >= 5 && hour <= 6);

    let bgColor = new THREE.Color('#1a291e');
    let sunColor = new THREE.Color('#fff5db');
    let lightIntensity = 1.8;

    if (isNight) {
      bgColor = new THREE.Color('#070d14');
      sunColor = new THREE.Color('#5c768d');
      lightIntensity = 0.3;
    } else if (isSunset) {
      bgColor = new THREE.Color('#381b1d');
      sunColor = new THREE.Color('#ff8c42');
      lightIntensity = 1.1;
    }

    this.scene.background = bgColor;
    if (this.scene.fog) (this.scene.fog as THREE.FogExp2).color = bgColor;
    this.dirLight.color = sunColor;
    this.dirLight.intensity = lightIntensity;

    // Visibilidad de Luciérnagas, Pétalos y Mariposas
    if (this.firefliesMesh) {
      this.firefliesMesh.visible = this.params.fireflies && isNight;
    }
    if (this.petalsMesh) {
      this.petalsMesh.visible = this.params.petals;
    }
    this.butterfliesGroup.visible = this.params.butterflies && !isNight;

    // Bloom Strength
    this.bloomPass.strength = this.params.bloom * 0.7;
  }

  /* ============================================================
     Controles Públicos
  ============================================================ */

  public setParams(next: GardenParams) {
    const prevDensity = this.params.flowerDensity;
    const prevSound = this.params.sound;

    this.params = { ...next };
    this.controls.autoRotate = this.params.autoRotate;

    if (Math.abs(prevDensity - this.params.flowerDensity) > 0.05) {
      this.buildGardenScene();
    }

    if (this.params.sound && !prevSound) {
      void this.audio.enable();
    } else if (!this.params.sound && prevSound) {
      this.audio.disable();
    }
    this.audio.setWind(this.params.wind);
  }

  public replant() {
    this.buildGardenScene();
  }

  private onResize = () => {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  };

  /* ============================================================
     Loop Principal
  ============================================================ */

  private animate = () => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const elapsedTime = this.clock.getElapsedTime();

    this.controls.update();
    this.updateEnvironment();

    // Bamboleo por Viento en plantas y árboles
    const windSpeed = this.params.wind;
    if (windSpeed > 0) {
      this.modelsGroup.children.forEach((child) => {
        if (child.userData.isPlant || child.userData.isTree) {
          const phase = child.userData.phase || 0;
          const sway = Math.sin(elapsedTime * 2.2 * (0.8 + windSpeed * 0.4) + phase) * 0.04 * windSpeed;
          child.rotation.z = sway;
        }
      });
    }

    // Animación de Luciérnagas
    if (this.firefliesMesh && this.fireflyPositions && this.firefliesMesh.visible) {
      const posAttr = this.firefliesMesh.geometry.getAttribute('position');
      for (let i = 0; i < posAttr.count; i++) {
        let y = posAttr.getY(i);
        y += Math.sin(elapsedTime * 1.5 + i) * 0.008;
        posAttr.setY(i, y);
      }
      posAttr.needsUpdate = true;
    }

    // Animación de Pétalos al Viento
    if (this.petalsMesh && this.params.petals) {
      for (let i = 0; i < this.petalData.length; i++) {
        const p = this.petalData[i];
        p.y -= delta * p.speed * 0.8;
        p.x += Math.sin(elapsedTime + i) * 0.01 * (1 + windSpeed);
        if (p.y < 0.1) p.y = 7 + Math.random() * 3;

        this.petalDummy.position.set(p.x, p.y, p.z);
        this.petalDummy.rotation.set(p.rx + elapsedTime, p.ry + elapsedTime * 0.5, 0);
        this.petalDummy.updateMatrix();
        this.petalsMesh.setMatrixAt(i, this.petalDummy.matrix);
      }
      this.petalsMesh.instanceMatrix.needsUpdate = true;
    }

    // Animación de Mariposas
    if (this.params.butterflies && this.butterfliesGroup.visible) {
      this.butterflies.forEach((b) => {
        b.angle += delta * b.speed;
        b.group.position.x = Math.cos(b.angle) * b.radius;
        b.group.position.z = Math.sin(b.angle) * b.radius;
        b.group.position.y = 1.2 + Math.sin(elapsedTime * 4 + b.angle) * 0.4;
        b.group.rotation.y = -b.angle + Math.PI / 2;

        const flap = Math.sin(elapsedTime * 18) * 0.6;
        b.wingLeft.rotation.y = flap;
        b.wingRight.rotation.y = -flap;
      });
    }

    // FPS Stats
    this.fpsCount++;
    this.fpsTimer += delta;
    if (this.fpsTimer >= 0.25) {
      this.currentFps = Math.round(this.fpsCount / Math.max(0.001, this.fpsTimer));
      this.fpsCount = 0;
      this.fpsTimer = 0;

      const hourLabel = `${Math.floor(this.params.timeOfDay).toString().padStart(2, '0')}:${Math.floor((this.params.timeOfDay % 1) * 60).toString().padStart(2, '0')}`;
      const isNight = this.params.timeOfDay < 6 || this.params.timeOfDay > 19;

      this.onStats({
        fps: this.currentFps,
        grass: 500,
        flowers: this.modelsGroup.children.length,
        petals: this.params.petals ? 70 : 0,
        fireflies: this.params.fireflies && isNight ? 60 : 0,
        sunDeg: Math.round((this.params.timeOfDay / 24) * 360),
        timeLabel: hourLabel,
        phase: isNight ? 'Noche' : 'Día',
      });
    }

    this.composer.render();
  };

  public dispose() {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    this.audio.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement && this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
