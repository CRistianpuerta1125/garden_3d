import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
  private dirLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;

  private modelsGroup = new THREE.Group();
  private loadedModels: {
    tree?: THREE.Group;
    plant?: THREE.Group;
    roses?: THREE.Group;
    rocks?: THREE.Group;
  } = {};

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
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
      200
    );
    this.camera.position.set(12, 10, 16);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 1, 0);
    this.controls.autoRotate = this.params.autoRotate;
    this.controls.autoRotateSpeed = 0.8;

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
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.modelsGroup);

    // Resize observer
    window.addEventListener('resize', this.onResize);

    // Load GLB Models
    this.loadModels();

    // Start loop
    this.animate();
  }

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

          // Shadows & Materials
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

          // Scale & pivot to base
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
    // Clear previous
    while (this.modelsGroup.children.length > 0) {
      this.modelsGroup.remove(this.modelsGroup.children[0]);
    }

    const flowerCount = Math.floor(60 * this.params.flowerDensity);
    const plantCount = Math.floor(40 * this.params.flowerDensity);

    // 1. Trees
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
        this.modelsGroup.add(tree);
      });
    }

    // 2. Roses / Flowers
    if (this.loadedModels.roses) {
      for (let i = 0; i < flowerCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 2 + Math.random() * 12;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        const rose = this.loadedModels.roses.clone(true);
        const s = 0.6 + Math.random() * 0.7;
        rose.position.set(x, 0, z);
        rose.rotation.y = Math.random() * Math.PI * 2;
        rose.scale.setScalar(s);
        this.modelsGroup.add(rose);
      }
    }

    // 3. Plants
    if (this.loadedModels.plant) {
      for (let i = 0; i < plantCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 3 + Math.random() * 11;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        const plant = this.loadedModels.plant.clone(true);
        const s = 0.7 + Math.random() * 0.7;
        plant.position.set(x, 0, z);
        plant.rotation.y = Math.random() * Math.PI * 2;
        plant.scale.setScalar(s);
        this.modelsGroup.add(plant);
      }
    }

    // 4. Rocks
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

  public setParams(next: GardenParams) {
    const prevDensity = this.params.flowerDensity;
    this.params = { ...next };
    this.controls.autoRotate = this.params.autoRotate;

    if (Math.abs(prevDensity - this.params.flowerDensity) > 0.05) {
      this.buildGardenScene();
    }
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
  };

  private animate = () => {
    this.animFrameId = requestAnimationFrame(this.animate);
    this.controls.update();

    // Stats
    this.fpsCount++;
    const delta = this.clock.getDelta();
    this.fpsTimer += delta;
    if (this.fpsTimer >= 1) {
      this.currentFps = this.fpsCount;
      this.fpsCount = 0;
      this.fpsTimer = 0;
      this.onStats({
        fps: this.currentFps,
        grass: 500,
        flowers: this.modelsGroup.children.length,
        petals: 0,
        fireflies: 0,
        sunDeg: 60,
        timeLabel: '12:00',
        phase: 'Día',
      });
    }

    this.renderer.render(this.scene, this.camera);
  };

  public dispose() {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement && this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
