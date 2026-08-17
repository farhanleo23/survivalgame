import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedModel } from "three/addons/utils/SkeletonUtils.js";
import type { EnemyDefinition, EnemyId, WeaponId } from "./types";

type CharacterMotion = "idle" | "walk" | "run";

export interface CharacterRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  muzzle: THREE.Object3D;
  weaponGroup?: THREE.Group;
  weaponModels?: Map<WeaponId, { group: THREE.Group; muzzle: THREE.Object3D }>;
  currentWeaponId?: WeaponId;
  recoilZ: number;
  recoilPitch: number;
  hitMaterials: THREE.MeshStandardMaterial[];
  model?: THREE.Object3D;
  mixer?: THREE.AnimationMixer;
  actions?: Partial<Record<CharacterMotion, THREE.AnimationAction>>;
  activeMotion?: CharacterMotion;
  hitShell?: THREE.Mesh;
  frostShell?: THREE.Mesh;
  burnShell?: THREE.Mesh;
  glowSac?: THREE.Mesh;
  bossCore?: THREE.Mesh;
  phase: number;
  scale: number;
  disposed: boolean;
}

interface CharacterAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const castAndReceive = (root: THREE.Object3D) => {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      if (object.name === "contact-shadow" || object.name === "surface-wear") {
        object.castShadow = false;
        object.receiveShadow = false;
        return;
      }
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
};

const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => new THREE.Mesh(geometry, material);

const createToonGradientMap = (): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#333333";
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = "#777777";
    ctx.fillRect(1, 0, 1, 1);
    ctx.fillStyle = "#bbbbbb";
    ctx.fillRect(2, 0, 1, 1);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(3, 0, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
};

const createInkOutlinedMesh = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  outlineThickness = 0.04,
  outlineColor = 0x090c0e,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = "custom-outlined-mesh";
  const main = new THREE.Mesh(geometry, material);
  main.castShadow = true;
  main.receiveShadow = true;

  const outlineMat = new THREE.MeshBasicMaterial({
    color: outlineColor,
    side: THREE.BackSide,
  });
  const outline = new THREE.Mesh(geometry, outlineMat);
  outline.scale.setScalar(1 + outlineThickness);
  outline.raycast = () => {};

  group.add(outline, main);
  return group;
};

const addGraphicInkEdges = (root: THREE.Object3D, opacity = 0.82) => {
  const candidates: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.parent?.name === "custom-outlined-mesh") return;
    if (object.name === "contact-shadow") return;
    if (object.geometry instanceof THREE.PlaneGeometry) return;
    candidates.push(object);
  });

  const ink = new THREE.LineBasicMaterial({
    color: 0x070a0a,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  for (const object of candidates) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(object.geometry, 24), ink);
    edges.name = "graphic-ink-edges";
    edges.renderOrder = 4;
    object.add(edges);
  }
};

const addContactShadow = (
  root: THREE.Object3D,
  radiusX: number,
  radiusZ: number,
  opacity = 0.28,
) => {
  const shadow = mesh(
    new THREE.CircleGeometry(1, 28),
    new THREE.MeshBasicMaterial({
      color: 0x020505,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  shadow.name = "contact-shadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(radiusX, radiusZ, 1);
  shadow.position.y = 0.018;
  root.add(shadow);
};

const addIllustratedWear = (
  root: THREE.Object3D,
  width: number,
  height: number,
  frontZ: number,
  opacity = 0.18,
) => {
  const wear = new THREE.MeshBasicMaterial({
    color: 0xc9b78e,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const marks: Array<[number, number, number, number]> = [
    [-0.22, 0.25, 0.28, -0.16],
    [0.18, 0.58, 0.2, 0.12],
    [-0.08, 0.75, 0.16, -0.08],
  ];
  for (const [x, y, markWidth, rotation] of marks) {
    const mark = mesh(new THREE.PlaneGeometry(width * markWidth, Math.max(0.018, height * 0.018)), wear);
    mark.name = "surface-wear";
    mark.position.set(x * width, y * height, frontZ);
    mark.rotation.z = rotation;
    root.add(mark);
  }
};

const findBone = (root: THREE.Object3D, ...candidates: string[]): THREE.Object3D | undefined => {
  for (const name of candidates) {
    const obj = root.getObjectByName(name);
    if (obj) return obj;
  }
  let found: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!found) {
      for (const candidate of candidates) {
        const cleanName = candidate.toLowerCase().replace("mixamorig:", "").replace("mixamorig", "");
        if (child.name.toLowerCase().includes(cleanName)) {
          found = child;
          break;
        }
      }
    }
  });
  return found;
};

export class VisualFactory {
  readonly groundMaterial: THREE.MeshStandardMaterial;
  readonly toonRamp: THREE.CanvasTexture;
  private bloodTexture: THREE.CanvasTexture;
  private acidTexture: THREE.CanvasTexture;
  private hazardTexture: THREE.CanvasTexture;
  private chainTexture: THREE.CanvasTexture;
  private groundTileTexture: THREE.CanvasTexture;

  private bloodMaterial: THREE.MeshBasicMaterial;
  private acidMaterial: THREE.MeshBasicMaterial;
  private decalGeometry = new THREE.PlaneGeometry(1, 1);
  private bloodDecals: THREE.Mesh[] = [];

  private characterAsset: Promise<CharacterAsset>;
  private characterAssetData?: CharacterAsset;
  private disposed = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.toonRamp = createToonGradientMap();
    this.bloodTexture = this.createBloodTexture();
    this.acidTexture = this.createAcidTexture();
    this.hazardTexture = this.createHazardTexture();
    this.chainTexture = this.createChainTexture();
    this.groundTileTexture = this.createStylizedGroundTexture();

    this.bloodMaterial = new THREE.MeshBasicMaterial({
      map: this.bloodTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.82,
    });

    this.acidMaterial = new THREE.MeshBasicMaterial({
      map: this.acidTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    });

    this.groundMaterial = new THREE.MeshStandardMaterial({
      map: this.groundTileTexture,
      bumpMap: this.groundTileTexture,
      bumpScale: 0.045,
      roughness: 0.88,
      metalness: 0.12,
      color: 0xb7c0bc,
    });

    new THREE.TextureLoader().load(
      "/textures/depot-floor-comic-v2.png",
      (texture) => {
        if (this.disposed) return;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1.8, 1.8);
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.groundMaterial.map = texture;
        this.groundMaterial.bumpMap = texture;
        this.groundMaterial.needsUpdate = true;
      },
    );

    this.characterAsset = new GLTFLoader().loadAsync("/models/soldier.glb").then((asset) => {
      const data = { scene: asset.scene, animations: asset.animations };
      this.characterAssetData = data;
      return data;
    });
  }

  async ready() {
    try {
      await this.characterAsset;
    } catch (error) {
      console.warn("Animated character model could not be loaded; using lightweight placeholders.", error);
    }
  }

  createGround() {
    const group = new THREE.Group();
    const ground = mesh(new THREE.PlaneGeometry(44, 44, 1, 1), this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    // Glowing central landing / defense zone ring
    const centerPadOuter = mesh(
      new THREE.RingGeometry(6.92, 7.08, 64),
      new THREE.MeshBasicMaterial({ color: 0x4ecdc4, transparent: true, opacity: 0.13, side: THREE.DoubleSide }),
    );
    centerPadOuter.rotation.x = -Math.PI / 2;
    centerPadOuter.position.y = 0.024;
    const centerPadInner = mesh(
      new THREE.RingGeometry(3.68, 3.8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
    );
    centerPadInner.rotation.x = -Math.PI / 2;
    centerPadInner.position.y = 0.025;
    group.add(centerPadOuter, centerPadInner);

    // Stylized crosshair markings on center zone
    const markMaterial = new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true, opacity: 0.11, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * Math.PI) / 2;
      const tick = mesh(new THREE.PlaneGeometry(0.35, 1.6), markMaterial);
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = angle;
      tick.position.set(Math.cos(angle) * 5.4, 0.026, Math.sin(angle) * 5.4);
      group.add(tick);
    }

    // Hazard zone edge markings
    const hazardMat = new THREE.MeshStandardMaterial({
      map: this.hazardTexture,
      roughness: 0.8,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    });
    for (const [x, z, rot] of [
      [0, -17.5, 0],
      [0, 17.5, 0],
      [-17.5, 0, Math.PI / 2],
      [17.5, 0, Math.PI / 2],
    ] as const) {
      const stripe = mesh(new THREE.PlaneGeometry(35, 0.75), hazardMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = rot;
      stripe.position.set(x, 0.027, z);
      group.add(stripe);
    }

    // Industrial Drains
    this.addDrain(group, -5.5, 7.5, 0.15);
    this.addDrain(group, 8.5, -6.0, -0.2);
    this.addDrain(group, -11.0, -10.5, 0.78);
    this.addDrain(group, 11.5, 9.0, -0.45);

    // Toxic puddles
    const puddleMat = new THREE.MeshBasicMaterial({
      color: 0x2aa747,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });
    for (const [x, z, sx, sz] of [
      [-5.5, 7.5, 2.6, 1.4],
      [8.5, -6.0, 1.9, 1.1],
      [-12.2, -4.5, 2.8, 1.6],
      [7.2, 10.5, 2.1, 1.2],
    ] as const) {
      const puddle = mesh(new THREE.CircleGeometry(1, 32), puddleMat);
      puddle.rotation.x = -Math.PI / 2;
      puddle.scale.set(sx, sz, 1);
      puddle.position.set(x, 0.034, z);
      group.add(puddle);
    }

    // Sparse illustrated stains break up the floor without adding collision or combat clutter.
    const stainMat = new THREE.MeshBasicMaterial({
      color: 0x281914,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });
    for (const [x, z, sx, sz, rotation] of [
      [-13.4, 5.8, 1.8, 0.7, 0.2],
      [12.2, -4.1, 1.4, 0.55, -0.6],
      [-7.8, -12.6, 1.25, 0.42, 0.45],
      [9.4, 12.5, 1.6, 0.5, -0.22],
      [3.2, 9.5, 0.9, 0.36, 0.75],
    ] as const) {
      const stain = mesh(new THREE.CircleGeometry(1, 14), stainMat);
      stain.rotation.x = -Math.PI / 2;
      stain.rotation.z = rotation;
      stain.scale.set(sx, sz, 1);
      stain.position.set(x, 0.035, z);
      group.add(stain);
    }

    return group;
  }

  addPerimeter(scene: THREE.Scene) {
    const carbon = new THREE.MeshStandardMaterial({ color: 0x141a18, metalness: 0.85, roughness: 0.28 });
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0x22302b,
      map: this.chainTexture,
      alphaMap: this.chainTexture,
      transparent: true,
      opacity: 0.78,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      metalness: 0.7,
      roughness: 0.35,
    });

    const laserLineMat = new THREE.MeshBasicMaterial({
      color: 0x4ecdc4,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
    });

    const sides: Array<[number, number, number]> = [
      [0, -20.25, 0],
      [0, 20.25, 0],
      [-20.25, 0, Math.PI / 2],
      [20.25, 0, Math.PI / 2],
    ];

    for (const [x, z, rotation] of sides) {
      const panel = mesh(new THREE.PlaneGeometry(40, 3.4), barrierMat);
      panel.position.set(x, 1.75, z);
      panel.rotation.y = rotation;
      scene.add(panel);

      const laser = mesh(new THREE.PlaneGeometry(40, 0.12), laserLineMat);
      laser.position.set(x, 3.45, z);
      laser.rotation.y = rotation;
      scene.add(laser);

      for (let p = -20; p <= 20; p += 4) {
        const post = mesh(new THREE.CylinderGeometry(0.09, 0.13, 3.9, 12), carbon);
        post.position.set(rotation ? x : p, 1.95, rotation ? p : z);
        post.castShadow = true;
        scene.add(post);
      }
    }

    const beaconGlass = new THREE.MeshStandardMaterial({
      color: 0xff3838,
      emissive: 0xff0055,
      emissiveIntensity: 3.5,
      roughness: 0.15,
    });

    for (const [x, z] of [
      [-19.7, -19.7],
      [19.7, -19.7],
      [-19.7, 19.7],
      [19.7, 19.7],
    ] as const) {
      const tower = new THREE.Group();
      const base = mesh(new RoundedBoxGeometry(0.85, 0.6, 0.85, 3, 0.05), carbon);
      base.position.y = 0.3;
      const column = mesh(new THREE.CylinderGeometry(0.18, 0.24, 2.4, 16), carbon);
      column.position.y = 1.6;
      const beacon = mesh(new THREE.SphereGeometry(0.28, 16, 12), beaconGlass);
      beacon.position.y = 2.9;
      const light = new THREE.PointLight(0xff0055, 6, 8, 2);
      light.position.y = 2.9;
      tower.add(base, column, beacon, light);
      tower.position.set(x, 0, z);
      castAndReceive(tower);
      scene.add(tower);
    }
  }

  createToxicVat() {
    const root = new THREE.Group();
    const carbon = new THREE.MeshStandardMaterial({ color: 0x18201d, metalness: 0.88, roughness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a4b45, metalness: 0.75, roughness: 0.35 });
    const vatFluid = new THREE.MeshStandardMaterial({
      color: 0x29933d,
      emissive: 0x0f6a2c,
      emissiveIntensity: 0.58,
      roughness: 0.15,
      metalness: 0.1,
    });

    const base = mesh(new THREE.CylinderGeometry(1.25, 1.35, 0.45, 20), carbon);
    base.position.y = 0.225;
    root.add(base);

    const fluid = mesh(new THREE.CylinderGeometry(0.95, 0.95, 2.0, 20), vatFluid);
    fluid.position.y = 1.35;
    root.add(fluid);

    for (const y of [0.55, 1.35, 2.15]) {
      const ring = mesh(new THREE.TorusGeometry(1.08, 0.06, 8, 24), steel);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      root.add(ring);
    }

    const cap = mesh(new THREE.CylinderGeometry(1.2, 1.25, 0.35, 20), carbon);
    cap.position.y = 2.45;
    const vent = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.4, 16), steel);
    vent.position.y = 2.75;
    root.add(cap, vent);

    const toxicLight = new THREE.PointLight(0x39c95b, 2.25, 5.2, 2);
    toxicLight.position.y = 1.5;
    root.add(toxicLight);

    addIllustratedWear(root, 1.4, 2.2, 1.015, 0.16);
    addContactShadow(root, 1.28, 0.92, 0.32);
    addGraphicInkEdges(root, 0.32);
    castAndReceive(root);
    return root;
  }

  createGenerator() {
    const root = new THREE.Group();
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x1b2320, metalness: 0.88, roughness: 0.3 });
    const industrialYellow = new THREE.MeshStandardMaterial({ color: 0xffb703, metalness: 0.3, roughness: 0.45 });
    const cellGlow = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00f5d4,
      emissiveIntensity: 3.0,
      roughness: 0.15,
    });
    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xff9e00,
      emissive: 0xff9e00,
      emissiveIntensity: 3.5,
      roughness: 0.2,
    });

    const body = mesh(new RoundedBoxGeometry(2.4, 1.8, 1.5, 3, 0.08), darkMetal);
    body.position.y = 0.9;
    root.add(body);

    const panelL = mesh(new RoundedBoxGeometry(0.12, 1.4, 1.2, 2, 0.04), industrialYellow);
    panelL.position.set(-1.18, 0.9, 0);
    const panelR = mesh(new RoundedBoxGeometry(0.12, 1.4, 1.2, 2, 0.04), industrialYellow);
    panelR.position.set(1.18, 0.9, 0);
    root.add(panelL, panelR);

    for (let i = -2; i <= 2; i += 1) {
      const cell = mesh(new RoundedBoxGeometry(0.24, 0.75, 0.14, 2, 0.03), cellGlow);
      cell.position.set(i * 0.38, 0.9, 0.72);
      root.add(cell);
    }

    const exhaust = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.35, 16), darkMetal);
    exhaust.position.set(-0.6, 1.9, 0);
    const beaconBase = mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.25, 12), darkMetal);
    beaconBase.position.set(0.65, 1.88, 0);
    const beacon = mesh(new THREE.SphereGeometry(0.16, 14, 10), beaconMat);
    beacon.position.set(0.65, 2.05, 0);
    const beaconLight = new THREE.PointLight(0xff9e00, 8, 5, 2);
    beaconLight.position.set(0.65, 2.05, 0);
    root.add(exhaust, beaconBase, beacon, beaconLight);

    addIllustratedWear(root, 2.05, 1.55, 0.765, 0.16);
    addContactShadow(root, 1.35, 0.82, 0.32);
    addGraphicInkEdges(root, 0.34);
    castAndReceive(root);
    return root;
  }

  createDepotStructure(width: number, depth: number, colorVariant = 0x222a27) {
    const root = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: colorVariant, roughness: 0.75, metalness: 0.2 });
    const carbonFrame = new THREE.MeshStandardMaterial({ color: 0x121715, roughness: 0.35, metalness: 0.85 });
    const neonCyan = new THREE.MeshStandardMaterial({
      color: 0x4ecdc4,
      emissive: 0x4ecdc4,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00bbf9,
      emissiveIntensity: 1.8,
      metalness: 0.4,
      roughness: 0.15,
    });

    const body = mesh(new RoundedBoxGeometry(width, 2.3, depth, 4, 0.12), concrete);
    body.position.y = 1.15;
    root.add(body);

    const cap = mesh(new RoundedBoxGeometry(width + 0.18, 0.2, depth + 0.18, 2, 0.04), carbonFrame);
    cap.position.y = 2.35;
    root.add(cap);

    const neonTrim = mesh(new RoundedBoxGeometry(width + 0.12, 0.06, depth + 0.12, 2, 0.02), neonCyan);
    neonTrim.position.y = 2.22;
    root.add(neonTrim);

    const longFace = width >= depth;
    const panelCount = Math.max(2, Math.floor((longFace ? width : depth) / 1.2));
    for (let index = 0; index < panelCount; index += 1) {
      const ratio = (index + 0.5) / panelCount - 0.5;
      const rib = mesh(new THREE.BoxGeometry(longFace ? 0.06 : width + 0.04, 1.95, longFace ? depth + 0.04 : 0.06), carbonFrame);
      rib.position.set(longFace ? ratio * width : 0, 1.15, longFace ? 0 : ratio * depth);
      root.add(rib);
    }

    const doorWidth = Math.min(1.4, width * 0.32);
    const door = mesh(new RoundedBoxGeometry(doorWidth, 1.6, 0.08, 2, 0.025), carbonFrame);
    door.position.set(longFace ? width * 0.2 : depth / 2 + 0.045, 0.85, longFace ? depth / 2 + 0.045 : 0);
    if (!longFace) door.rotation.y = Math.PI / 2;
    root.add(door);

    const windowPanel = mesh(new RoundedBoxGeometry(Math.min(1.5, width * 0.36), 0.46, 0.06, 2, 0.03), glass);
    windowPanel.position.set(longFace ? -width * 0.2 : depth / 2 + 0.055, 1.55, longFace ? depth / 2 + 0.055 : 0);
    if (!longFace) windowPanel.rotation.y = Math.PI / 2;
    root.add(windowPanel);

    if (longFace) addIllustratedWear(root, width * 0.72, 1.8, depth / 2 + 0.052, 0.12);
    addContactShadow(root, width * 0.46, depth * 0.42, 0.22);
    addGraphicInkEdges(root, 0.2);
    castAndReceive(root);
    return root;
  }

  createBarricade(width: number, depth: number) {
    const root = new THREE.Group();
    const carbonSteel = new THREE.MeshStandardMaterial({ color: 0x1c2421, metalness: 0.85, roughness: 0.28 });
    const barrierOrange = new THREE.MeshStandardMaterial({ color: 0xff9e00, metalness: 0.25, roughness: 0.4 });
    const statusLight = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00f5d4,
      emissiveIntensity: 3.0,
      roughness: 0.1,
    });

    for (const x of [-width * 0.35, width * 0.35]) {
      const leg = mesh(new RoundedBoxGeometry(0.18, 0.85, depth * 1.8, 2, 0.04), carbonSteel);
      leg.position.set(x, 0.42, 0);
      root.add(leg);
    }

    for (const [y, mat] of [
      [0.32, carbonSteel],
      [0.66, barrierOrange],
      [0.96, carbonSteel],
    ] as const) {
      const plank = mesh(new RoundedBoxGeometry(width, 0.22, depth, 2, 0.035), mat);
      plank.position.y = y;
      root.add(plank);
    }

    for (const x of [-width * 0.25, 0, width * 0.25]) {
      const node = mesh(new THREE.SphereGeometry(0.04, 10, 8), statusLight);
      node.position.set(x, 0.66, depth / 2 + 0.02);
      root.add(node);
    }

    addIllustratedWear(root, width * 0.84, 0.9, depth / 2 + 0.022, 0.12);
    addContactShadow(root, width * 0.48, depth * 0.78, 0.28);
    addGraphicInkEdges(root, 0.32);
    castAndReceive(root);
    return root;
  }

  createFloodlight(color: number) {
    const root = new THREE.Group();
    const carbon = new THREE.MeshStandardMaterial({ color: 0x181e1c, metalness: 0.9, roughness: 0.25 });
    const lens = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 4.0,
      roughness: 0.1,
    });

    const base = mesh(new THREE.CylinderGeometry(0.3, 0.48, 0.35, 16), carbon);
    base.position.y = 0.175;
    const pole = mesh(new THREE.CylinderGeometry(0.09, 0.13, 5.0, 14), carbon);
    pole.position.y = 2.65;
    root.add(base, pole);

    for (const x of [-0.34, 0.34]) {
      const lamp = mesh(new RoundedBoxGeometry(0.52, 0.34, 0.28, 2, 0.04), carbon);
      lamp.position.set(x, 5.05, 0);
      lamp.rotation.x = -0.32;
      const face = mesh(new RoundedBoxGeometry(0.4, 0.24, 0.03, 2, 0.02), lens);
      face.position.set(x, 5.01, 0.15);
      face.rotation.x = -0.32;
      root.add(lamp, face);
    }

    addContactShadow(root, 0.5, 0.34, 0.24);
    addGraphicInkEdges(root, 0.24);
    castAndReceive(root);
    return root;
  }

  createBarrel() {
    const root = new THREE.Group();
    const crimson = new THREE.MeshStandardMaterial({ color: 0xd90429, roughness: 0.42, metalness: 0.45 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x161b19, roughness: 0.3, metalness: 0.85 });
    const hazardGlow = new THREE.MeshStandardMaterial({
      color: 0xffb703,
      emissive: 0xff9e00,
      emissiveIntensity: 2.0,
      roughness: 0.3,
    });

    const body = mesh(new THREE.CylinderGeometry(0.5, 0.48, 1.2, 24, 1), crimson);
    body.position.y = 0.6;
    root.add(body);

    for (const y of [0.1, 0.34, 0.88, 1.1]) {
      const band = mesh(new THREE.TorusGeometry(0.495, 0.038, 6, 24), carbon);
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      root.add(band);
    }

    const cap = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 24), carbon);
    cap.position.y = 1.225;
    const hazard = mesh(new THREE.BoxGeometry(0.76, 0.28, 0.015), hazardGlow);
    hazard.position.set(0, 0.62, 0.485);
    root.add(cap, hazard);

    addIllustratedWear(root, 0.8, 1.05, 0.506, 0.2);
    addContactShadow(root, 0.58, 0.38, 0.34);
    addGraphicInkEdges(root, 0.38);
    castAndReceive(root);
    return root;
  }

  addSetDressing(scene: THREE.Scene) {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x3d3527, roughness: 0.8, metalness: 0.15 });
    const carbonTrim = new THREE.MeshStandardMaterial({ color: 0x151b18, roughness: 0.35, metalness: 0.8 });
    const lockGlow = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00f5d4,
      emissiveIntensity: 2.2,
    });

    const positions: Array<[number, number, number]> = [
      [-16, 9, 0.2],
      [15, -9.5, -0.35],
      [-13.5, -12.4, 0.12],
      [13.8, 11.2, 0.7],
    ];

    for (const [x, z, rotation] of positions) {
      const root = new THREE.Group();
      for (let level = 0; level < 2; level += 1) {
        const box = mesh(new RoundedBoxGeometry(1.2, 0.82, 0.95, 2, 0.05), crateMat);
        box.position.set(level * 0.32, 0.41 + level * 0.82, 0);
        const edge = mesh(new RoundedBoxGeometry(1.26, 0.09, 1.01, 2, 0.02), carbonTrim);
        edge.position.set(level * 0.32, 0.8 + level * 0.82, 0);
        const lock = mesh(new RoundedBoxGeometry(0.12, 0.12, 0.04, 2, 0.02), lockGlow);
        lock.position.set(level * 0.32, 0.41 + level * 0.82, 0.49);
        root.add(box, edge, lock);
      }
      root.position.set(x, 0, z);
      root.rotation.y = rotation;
      addIllustratedWear(root, 1.05, 1.35, 0.515, 0.12);
      addContactShadow(root, 0.95, 0.64, 0.22);
      addGraphicInkEdges(root, 0.18);
      castAndReceive(root);
      scene.add(root);
    }

    this.addDust(scene);
  }

  createExtractionZone() {
    const group = new THREE.Group();

    // Outer glowing pulsating ring
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const outerRing = mesh(new THREE.RingGeometry(3.0, 3.3, 48), outerRingMat);
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.04;
    group.add(outerRing);

    // Inner glowing fill disc
    const innerDiscMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const innerDisc = mesh(new THREE.CircleGeometry(3.0, 48), innerDiscMat);
    innerDisc.rotation.x = -Math.PI / 2;
    innerDisc.position.y = 0.038;
    group.add(innerDisc);

    // Narrow holographic column with segmented rings and rising light fragments.
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const beam = mesh(new THREE.CylinderGeometry(0.24, 0.46, 4.2, 18, 1, true), beamMat);
    beam.position.y = 2.1;
    group.add(beam);

    for (let index = 0; index < 4; index += 1) {
      const radius = 0.55 + index * 0.12;
      const ring = mesh(
        new THREE.RingGeometry(radius, radius + 0.065, 28),
        new THREE.MeshBasicMaterial({
          color: 0x6fffee,
          transparent: true,
          opacity: 0.5 - index * 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.62 + index * 0.82;
      ring.rotation.z = index * 0.48;
      group.add(ring);
    }

    const fragmentMat = new THREE.MeshBasicMaterial({ color: 0x8efff4, transparent: true, opacity: 0.68 });
    for (let index = 0; index < 12; index += 1) {
      const angle = index * 2.15;
      const radius = 0.28 + (index % 3) * 0.16;
      const fragment = mesh(new THREE.BoxGeometry(0.045, 0.2 + (index % 4) * 0.06, 0.045), fragmentMat);
      fragment.position.set(Math.cos(angle) * radius, 0.45 + (index % 6) * 0.62, Math.sin(angle) * radius);
      group.add(fragment);
    }

    // Rotating chevron markers pointing inwards
    const chevronMat = new THREE.MeshBasicMaterial({
      color: 0xffb703,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * Math.PI) / 2;
      const chevron = mesh(new THREE.PlaneGeometry(0.5, 0.9), chevronMat);
      chevron.rotation.x = -Math.PI / 2;
      chevron.rotation.z = angle;
      chevron.position.set(Math.cos(angle) * 2.3, 0.042, Math.sin(angle) * 2.3);
      group.add(chevron);
    }

    return group;
  }

  createPlayer(): CharacterRig {
    const rig = this.createEmptyRig(1);
    const ring = mesh(
      new THREE.RingGeometry(0.74, 0.9, 36),
      new THREE.MeshBasicMaterial({ color: 0x00f5d4, transparent: true, opacity: 0.65, side: THREE.DoubleSide }),
    );
    ring.name = "selection-ring";
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    rig.root.add(ring);

    void this.attachAnimatedCharacter(rig, "player").catch((error) => {
      console.warn("Player animation model failed to attach.", error);
    });

    return rig;
  }

  createEnemy(type: EnemyId, definition: EnemyDefinition): CharacterRig {
    const scale =
      type === "juggernaut"
        ? 1.85
        : type === "brute"
          ? 1.42
          : type === "boomer"
            ? 1.28
            : type === "runner"
              ? 0.92
              : 1.08;
    const rig = this.createEmptyRig(scale);

    if (type === "juggernaut") {
      const bossRing = mesh(
        new THREE.RingGeometry(1.45, 1.7, 48),
        new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
      );
      bossRing.name = "selection-ring";
      bossRing.rotation.x = -Math.PI / 2;
      bossRing.position.y = 0.045;
      rig.root.add(bossRing);
    }

    void this.attachAnimatedCharacter(rig, type, definition).catch((error) => {
      console.warn(`${type} animation model failed to attach.`, error);
    });

    return rig;
  }

  animateCharacter(
    rig: CharacterRig,
    dt: number,
    speed: number,
    attacking: boolean,
    hit: number,
    isChilled = false,
    isBurning = false,
  ) {
    const requested: CharacterMotion = speed > 5.4 ? "run" : speed > 0.08 ? "walk" : "idle";
    const nextAction = rig.actions?.[requested] ?? rig.actions?.idle;
    if (nextAction && rig.activeMotion !== requested) {
      const previous = rig.activeMotion ? rig.actions?.[rig.activeMotion] : undefined;
      const targetTimeScale = requested === "run" ? 1.2 : 1.0;
      nextAction.reset().setEffectiveWeight(1).setEffectiveTimeScale(targetTimeScale).fadeIn(0.12).play();
      previous?.fadeOut(0.12);
      rig.activeMotion = requested;
    }

    if (nextAction && requested !== "idle" && speed > 0.1) {
      const baseSpeed = requested === "run" ? 6.2 : 3.2;
      const chillFactor = isChilled ? 0.45 : 1.0;
      const dynamicScale = Math.min(2.0, Math.max(0.25, (speed / baseSpeed) * (requested === "run" ? 1.2 : 1.0) * chillFactor));
      nextAction.setEffectiveTimeScale(dynamicScale);
    }

    rig.mixer?.update(dt);

    if (rig.model) {
      const attackLean = attacking ? -0.16 : hit > 0 ? 0.22 : 0;
      rig.model.rotation.x = THREE.MathUtils.lerp(rig.model.rotation.x, attackLean, 1 - Math.exp(-dt * 20));
      rig.model.position.z = THREE.MathUtils.lerp(rig.model.position.z, attacking ? 0.12 : hit > 0 ? -0.1 : 0, 1 - Math.exp(-dt * 20));
    }

    if (rig.weaponGroup) {
      rig.recoilZ = THREE.MathUtils.lerp(rig.recoilZ, 0, 1 - Math.exp(-dt * 26));
      rig.recoilPitch = THREE.MathUtils.lerp(rig.recoilPitch, 0, 1 - Math.exp(-dt * 28));
      rig.weaponGroup.position.z = 0.33 - rig.recoilZ;
      rig.weaponGroup.rotation.x = -rig.recoilPitch;
    }

    if (rig.hitShell) rig.hitShell.visible = hit > 0;

    if (rig.frostShell) {
      rig.frostShell.visible = isChilled;
      if (isChilled) rig.frostShell.rotation.y += dt * 2.2;
    }

    if (rig.burnShell) {
      rig.burnShell.visible = isBurning;
      if (isBurning) rig.burnShell.rotation.y -= dt * 3.5;
    }

    rig.phase += dt * 3.5;
    if (rig.glowSac && rig.glowSac.material instanceof THREE.MeshStandardMaterial) {
      const pulse = 1.8 + Math.sin(rig.phase * 2) * 1.0;
      rig.glowSac.material.emissiveIntensity = pulse;
    }
    if (rig.bossCore && rig.bossCore.material instanceof THREE.MeshStandardMaterial) {
      const pulse = 2.5 + Math.sin(rig.phase * 3) * 1.5;
      rig.bossCore.material.emissiveIntensity = pulse;
    }
  }

  applyWeaponRecoil(rig: CharacterRig, intensity = 1) {
    rig.recoilZ = Math.min(0.28, rig.recoilZ + 0.14 * intensity);
    rig.recoilPitch = Math.min(0.38, rig.recoilPitch + 0.22 * intensity);
  }

  disposeCharacter(rig: CharacterRig) {
    if (rig.disposed) return;
    rig.disposed = true;
    rig.mixer?.stopAllAction();
    rig.root.removeFromParent();
  }

  disposeObject(root: THREE.Object3D) {
    root.removeFromParent();
  }

  dispose(scene: THREE.Scene) {
    if (this.disposed) return;
    this.disposed = true;
    this.bloodDecals = [];
    scene.clear();
  }

  addBloodDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    const decal = new THREE.Mesh(this.decalGeometry, this.bloodMaterial);
    const size = 2.6 * scale;
    decal.scale.set(size, size, 1);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    decal.position.set(position.x, 0.044, position.z);
    scene.add(decal);
    this.bloodDecals.push(decal);
    if (this.bloodDecals.length > 24) {
      const old = this.bloodDecals.shift();
      if (old) scene.remove(old);
    }
  }

  addAcidDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    const decal = new THREE.Mesh(this.decalGeometry, this.acidMaterial);
    const size = 2.4 * scale;
    decal.scale.set(size, size, 1);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    decal.position.set(position.x, 0.045, position.z);
    scene.add(decal);
    this.bloodDecals.push(decal);
    if (this.bloodDecals.length > 24) {
      const old = this.bloodDecals.shift();
      if (old) scene.remove(old);
    }
  }

  createMuzzleFlashMesh(color = 0xffea00) {
    const group = new THREE.Group();
    const outerFlameMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    });
    const innerFlameMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
    });

    const outerCone = mesh(new THREE.ConeGeometry(0.26, 0.78, 6), outerFlameMat);
    outerCone.rotation.x = Math.PI / 2;
    outerCone.position.z = 0.39;

    const innerCone = mesh(new THREE.ConeGeometry(0.16, 0.54, 6), innerFlameMat);
    innerCone.rotation.x = Math.PI / 2;
    innerCone.rotation.z = Math.PI / 6;
    innerCone.position.z = 0.27;

    const core = mesh(new THREE.SphereGeometry(0.12, 8, 6), coreMat);
    core.position.z = 0.08;

    group.add(outerCone, innerCone, core);
    return group;
  }

  createDashGhost(playerGroup: THREE.Group) {
    const ghost = new THREE.Group();
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.4,
    });

    playerGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry && child.name !== "selection-ring") {
        const ghostMesh = new THREE.Mesh(child.geometry, ghostMat);
        ghostMesh.position.copy(child.position);
        ghostMesh.quaternion.copy(child.quaternion);
        ghostMesh.scale.copy(child.scale);
        ghost.add(ghostMesh);
      }
    });

    ghost.position.copy(playerGroup.position);
    ghost.quaternion.copy(playerGroup.quaternion);
    return ghost;
  }

  private createEmptyRig(scale: number): CharacterRig {
    const root = new THREE.Group();
    const torso = new THREE.Group();
    const head = new THREE.Group();
    const leftArm = new THREE.Group();
    const rightArm = new THREE.Group();
    const leftLeg = new THREE.Group();
    const rightLeg = new THREE.Group();
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.16, 1.26 * scale, 0.72 * scale);
    root.add(torso, head, leftArm, rightArm, leftLeg, rightLeg, muzzle);

    const shadow = mesh(
      new THREE.CircleGeometry(0.6 * scale, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.56, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.z = 0.55;
    shadow.position.y = 0.025;
    root.add(shadow);

    const placeholder = mesh(
      new THREE.CapsuleGeometry(0.26 * scale, 0.85 * scale, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x242e2b, roughness: 0.8, transparent: true, opacity: 0.5 }),
    );
    placeholder.name = "character-placeholder";
    placeholder.position.y = 0.72 * scale;
    root.add(placeholder);

    return {
      root,
      torso,
      head,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      muzzle,
      recoilZ: 0,
      recoilPitch: 0,
      hitMaterials: [],
      phase: Math.random() * Math.PI * 2,
      scale,
      disposed: false,
    };
  }

  private attachAnimatedCharacter(rig: CharacterRig, kind: "player" | EnemyId, definition?: EnemyDefinition) {
    return this.characterAsset.then((asset) => {
      if (this.disposed || rig.disposed) return;
      const model = cloneSkinnedModel(asset.scene);
      model.scale.setScalar(rig.scale * (kind === "player" ? 1.92 : 1.54));
      model.rotation.y = Math.PI;

      if (kind === "runner") {
        model.scale.x *= 0.82;
        model.scale.z *= 0.85;
      }
      if (kind === "brute") {
        model.scale.x *= 1.25;
        model.scale.z *= 1.15;
      }
      if (kind === "boomer") {
        model.scale.x *= 1.28;
        model.scale.z *= 1.25;
      }
      if (kind === "juggernaut") {
        model.scale.x *= 1.35;
        model.scale.z *= 1.25;
      }

      // Hide all generic military soldier meshes from base asset
      model.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh || (object instanceof THREE.Mesh && !object.name.startsWith("custom-"))) {
          object.visible = false;
        }
      });

      // Build custom comic anatomy directly on live skeleton bones
      if (kind === "player") {
        this.buildStylizedOperator(model);
      } else {
        this.buildStylizedZombie(model, kind, definition?.color ?? 0x5f6d62);
      }

      model.traverse((object) => {
        if (object.name !== "custom-outlined-mesh") return;
        const outline = object.children[0];
        if (outline) {
          const inkScale =
            kind === "player" ? 1.09 : kind === "juggernaut" ? 1.065 : kind === "brute" ? 1.07 : 1.072;
          outline.scale.setScalar(inkScale);
        }
      });

      const placeholder = rig.root.getObjectByName("character-placeholder");
      if (placeholder) {
        placeholder.removeFromParent();
      }
      rig.root.add(model);
      rig.model = model;

      if (kind === "player") {
        const weaponRig = this.createPlayerWeaponRigs();
        rig.root.add(weaponRig.group);
        rig.weaponGroup = weaponRig.group;
        rig.weaponModels = weaponRig.weaponModels;
        rig.muzzle = weaponRig.initialMuzzle;
        rig.currentWeaponId = "pistol";
      }

      if (kind === "spitter") {
        const sac = model.getObjectByName("spitter-acid-sac") as THREE.Mesh | undefined;
        if (sac) rig.glowSac = sac;
      }
      if (kind === "boomer") {
        const sac = model.getObjectByName("boomer-belly-sac") as THREE.Mesh | undefined;
        if (sac) rig.glowSac = sac;
      }
      if (kind === "juggernaut") {
        const core = model.getObjectByName("juggernaut-boss-core") as THREE.Mesh | undefined;
        if (core) rig.bossCore = core;
      }

      const mixer = new THREE.AnimationMixer(model);
      const findClip = (name: string) => asset.animations.find((clip) => clip.name.toLowerCase() === name);
      const idle = findClip("idle");
      const walk = findClip("walk");
      const run = findClip("run");
      rig.mixer = mixer;
      rig.actions = {
        idle: idle ? mixer.clipAction(idle) : undefined,
        walk: walk ? mixer.clipAction(walk) : undefined,
        run: run ? mixer.clipAction(run) : undefined,
      };
      rig.activeMotion = "idle";
      rig.actions.idle?.play();

      const hitShell = mesh(
        new THREE.CapsuleGeometry(0.38 * rig.scale, 0.98 * rig.scale, 4, 8),
        new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.35, depthWrite: false }),
      );
      hitShell.position.y = 0.82 * rig.scale;
      hitShell.visible = false;
      rig.root.add(hitShell);
      rig.hitShell = hitShell;

      const frostShell = mesh(
        new THREE.CapsuleGeometry(0.42 * rig.scale, 1.02 * rig.scale, 6, 8),
        new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.42, depthWrite: false, wireframe: true }),
      );
      frostShell.position.y = 0.82 * rig.scale;
      frostShell.visible = false;
      rig.root.add(frostShell);
      rig.frostShell = frostShell;

      const burnShell = mesh(
        new THREE.CapsuleGeometry(0.42 * rig.scale, 1.02 * rig.scale, 6, 8),
        new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.42, depthWrite: false, wireframe: true }),
      );
      burnShell.position.y = 0.82 * rig.scale;
      burnShell.visible = false;
      rig.root.add(burnShell);
      rig.burnShell = burnShell;
    });
  }

  private buildStylizedOperator(template: THREE.Object3D) {
    // Toon Materials with Comic Ink Ramp
    const skinMat = new THREE.MeshToonMaterial({ color: 0xf6c8a7, gradientMap: this.toonRamp });
    const hairMat = new THREE.MeshToonMaterial({ color: 0x5a321e, gradientMap: this.toonRamp });
    const armorCyanMat = new THREE.MeshToonMaterial({
      color: 0x00f5d4,
      emissive: 0x00d2b4,
      emissiveIntensity: 0.45,
      gradientMap: this.toonRamp,
    });
    const harnessOrangeMat = new THREE.MeshToonMaterial({
      color: 0xff6a1f,
      emissive: 0x481300,
      emissiveIntensity: 0.16,
      gradientMap: this.toonRamp,
    });
    const suitDarkMat = new THREE.MeshToonMaterial({
      color: 0x2a3d42,
      emissive: 0x071b20,
      emissiveIntensity: 0.22,
      gradientMap: this.toonRamp,
    });
    const bootMat = new THREE.MeshToonMaterial({
      color: 0x18262c,
      emissive: 0x061014,
      emissiveIntensity: 0.12,
      gradientMap: this.toonRamp,
    });
    const goldMat = new THREE.MeshToonMaterial({ color: 0xffb703, gradientMap: this.toonRamp });

    // 1. Hips (Pelvis & Belt with Holster)
    const hips = findBone(template, "mixamorig:Hips", "mixamorigHips", "Hips", "Pelvis");
    if (hips) {
      const belt = createInkOutlinedMesh(new RoundedBoxGeometry(34, 16, 22, 2, 2), suitDarkMat, 0.04);
      belt.position.set(0, -2, 0);
      const buckle = createInkOutlinedMesh(new RoundedBoxGeometry(8, 8, 4, 1, 1), goldMat, 0.03);
      buckle.position.set(0, -2, 12);
      const holster = createInkOutlinedMesh(new RoundedBoxGeometry(9, 24, 14, 2, 2), bootMat, 0.03);
      holster.position.set(18, -8, 0);
      hips.add(belt, buckle, holster);
    }

    // 2. Torso (Spine & Spine1 & Spine2)
    const spine = findBone(template, "mixamorig:Spine", "mixamorigSpine", "Spine");
    if (spine) {
      const lowerTorso = createInkOutlinedMesh(new RoundedBoxGeometry(28, 18, 18, 2, 3), suitDarkMat, 0.04);
      lowerTorso.position.set(0, 8, 0);
      spine.add(lowerTorso);
    }

    const spine1 = findBone(template, "mixamorig:Spine1", "mixamorigSpine1", "Spine1");
    if (spine1) {
      const midTorso = createInkOutlinedMesh(new RoundedBoxGeometry(32, 22, 20, 2, 3), suitDarkMat, 0.04);
      midTorso.position.set(0, 6, 0);
      spine1.add(midTorso);
    }

    const spine2 = findBone(template, "mixamorig:Spine2", "mixamorigSpine2", "Spine2", "Chest");
    if (spine2) {
      // Cyan & Orange Heroic Chestplate Rig
      const chestPlate = createInkOutlinedMesh(new RoundedBoxGeometry(38, 28, 24, 2, 3), armorCyanMat, 0.04);
      chestPlate.position.set(0, 8, 5);

      const strapL = createInkOutlinedMesh(new RoundedBoxGeometry(7, 32, 26, 1, 1), harnessOrangeMat, 0.03);
      strapL.position.set(-13, 8, 4);
      const strapR = createInkOutlinedMesh(new RoundedBoxGeometry(7, 32, 26, 1, 1), harnessOrangeMat, 0.03);
      strapR.position.set(13, 8, 4);

      const commPack = createInkOutlinedMesh(new RoundedBoxGeometry(26, 28, 14, 2, 2), bootMat, 0.03);
      commPack.position.set(0, 10, -14);

      spine2.add(chestPlate, strapL, strapR, commPack);
    }

    // 3. Head & Hair (Head bone)
    const head = findBone(template, "mixamorig:Head", "mixamorigHead", "Head");
    if (head) {
      const face = createInkOutlinedMesh(new THREE.SphereGeometry(11, 14, 12), skinMat, 0.04);
      face.position.set(0, 7, 2);

      // Stylized comic eyes
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00f5d4 });
      for (const ex of [-4.2, 4.2]) {
        const eye = mesh(new THREE.SphereGeometry(2.2, 8, 6), eyeMat);
        eye.position.set(ex, 8.5, 11.5);
        head.add(eye);
      }

      // Chestnut swept-bangs hair base
      const hairBase = createInkOutlinedMesh(new THREE.SphereGeometry(13, 14, 10), hairMat, 0.04);
      hairBase.position.set(0, 10, -2);

      // Ponytail extending backward
      const ponytail = createInkOutlinedMesh(new THREE.ConeGeometry(7, 34, 8), hairMat, 0.04);
      ponytail.rotation.x = -Math.PI / 2.8;
      ponytail.position.set(0, 16, -16);

      // Tactical headset
      const headsetMat = new THREE.MeshBasicMaterial({ color: 0x111827 });
      const earL = createInkOutlinedMesh(new RoundedBoxGeometry(4, 7, 5, 1, 1), headsetMat, 0.03);
      earL.position.set(-12.5, 8, 2);
      const earR = createInkOutlinedMesh(new RoundedBoxGeometry(4, 7, 5, 1, 1), headsetMat, 0.03);
      earR.position.set(12.5, 8, 2);
      const mic = mesh(new THREE.CylinderGeometry(0.8, 0.8, 14, 6), headsetMat);
      mic.rotation.z = Math.PI / 3;
      mic.position.set(11, 4, 8);

      head.add(face, hairBase, ponytail, earL, earR, mic);
    }

    // 4. Arms & Forearms
    const addOperatorArm = (armCandidates: string[], foreArmCandidates: string[], handCandidates: string[], isLeft: boolean) => {
      const armBone = findBone(template, ...armCandidates);
      if (armBone) {
        const bicep = createInkOutlinedMesh(new THREE.CapsuleGeometry(5.2, 18, 4, 8), skinMat, 0.04);
        bicep.position.set(0, -10, 0);
        const armband = createInkOutlinedMesh(new THREE.CylinderGeometry(5.8, 5.8, 6, 8), harnessOrangeMat, 0.03);
        armband.position.set(0, -6, 0);
        armBone.add(bicep, armband);
      }
      const foreBone = findBone(template, ...foreArmCandidates);
      if (foreBone) {
        const foreArm = createInkOutlinedMesh(new THREE.CapsuleGeometry(4.8, 18, 4, 8), suitDarkMat, 0.04);
        foreArm.position.set(0, -10, 0);
        foreBone.add(foreArm);
      }
      const handBone = findBone(template, ...handCandidates);
      if (handBone) {
        const glove = createInkOutlinedMesh(new THREE.SphereGeometry(5.5, 8, 6), bootMat, 0.04);
        glove.position.set(isLeft ? -2 : 2, -4, 0);
        handBone.add(glove);
      }
    };
    addOperatorArm(["mixamorig:LeftArm", "mixamorigLeftArm", "LeftArm"], ["mixamorig:LeftForeArm", "mixamorigLeftForeArm", "LeftForeArm"], ["mixamorig:LeftHand", "mixamorigLeftHand", "LeftHand"], true);
    addOperatorArm(["mixamorig:RightArm", "mixamorigRightArm", "RightArm"], ["mixamorig:RightForeArm", "mixamorigRightForeArm", "RightForeArm"], ["mixamorig:RightHand", "mixamorigRightHand", "RightHand"], false);

    // 5. Legs & Boots
    const addOperatorLeg = (upLegCandidates: string[], legCandidates: string[], footCandidates: string[]) => {
      const upLeg = findBone(template, ...upLegCandidates);
      if (upLeg) {
        const thigh = createInkOutlinedMesh(new THREE.CapsuleGeometry(7.6, 28, 4, 8), suitDarkMat, 0.04);
        thigh.position.set(0, -18, 0);
        upLeg.add(thigh);
      }
      const leg = findBone(template, ...legCandidates);
      if (leg) {
        const shin = createInkOutlinedMesh(new THREE.CapsuleGeometry(6.6, 26, 4, 8), suitDarkMat, 0.04);
        shin.position.set(0, -16, 0);
        const kneeGuard = createInkOutlinedMesh(new RoundedBoxGeometry(10, 11, 6, 1, 2), armorCyanMat, 0.03);
        kneeGuard.position.set(0, 2, 7);
        leg.add(shin, kneeGuard);
      }
      const foot = findBone(template, ...footCandidates);
      if (foot) {
        const boot = createInkOutlinedMesh(new RoundedBoxGeometry(11, 13, 24, 2, 2), bootMat, 0.04);
        boot.position.set(0, -4, 6);
        foot.add(boot);
      }
    };
    addOperatorLeg(["mixamorig:LeftUpLeg", "mixamorigLeftUpLeg", "LeftUpLeg"], ["mixamorig:LeftLeg", "mixamorigLeftLeg", "LeftLeg"], ["mixamorig:LeftFoot", "mixamorigLeftFoot", "LeftFoot"]);
    addOperatorLeg(["mixamorig:RightUpLeg", "mixamorigRightUpLeg", "RightUpLeg"], ["mixamorig:RightLeg", "mixamorigRightLeg", "RightLeg"], ["mixamorig:RightFoot", "mixamorigRightFoot", "RightFoot"]);
  }

  private buildStylizedZombie(template: THREE.Object3D, kind: EnemyId, clothingColor: number) {
    // Distinct Zombie Toon Materials
    const skinTone =
      kind === "spitter"
        ? 0x39ff14
        : kind === "boomer"
          ? 0x42964e
          : kind === "juggernaut"
            ? 0x5a1818
            : kind === "brute"
              ? 0xd0d5c0
              : kind === "runner"
                ? 0x8a5438
                : 0x6e836b;

    const zombieSkinMat = new THREE.MeshToonMaterial({
      color: skinTone,
      emissive:
        kind === "spitter"
          ? 0x22c55e
          : kind === "boomer"
            ? 0x1f9435
            : kind === "juggernaut"
              ? 0x330808
              : 0x081008,
      emissiveIntensity: kind === "spitter" ? 1.4 : kind === "boomer" ? 0.9 : 0.2,
      gradientMap: this.toonRamp,
    });

    const shirtColor =
      kind === "runner"
        ? 0x991b1b
        : kind === "spitter"
          ? 0x1f2937
          : kind === "boomer"
            ? 0x423528
            : kind === "brute"
              ? 0x374151
              : clothingColor || 0xdcd6cd;

    const shirtMat = new THREE.MeshToonMaterial({ color: shirtColor, gradientMap: this.toonRamp });
    const jeansMat = new THREE.MeshToonMaterial({ color: 0x243342, gradientMap: this.toonRamp });
    const boneMat = new THREE.MeshToonMaterial({ color: 0xd4dac5, gradientMap: this.toonRamp });
    const shoeMat = new THREE.MeshToonMaterial({ color: 0x181e1b, gradientMap: this.toonRamp });

    // 1. Hips (Torn Waistband)
    const hips = findBone(template, "mixamorig:Hips", "mixamorigHips", "Hips", "Pelvis");
    if (hips) {
      const waist = createInkOutlinedMesh(
        new RoundedBoxGeometry(kind === "brute" ? 48 : 34, 16, 24, 2, 2),
        jeansMat,
        0.04,
      );
      waist.position.set(0, -2, 0);
      hips.add(waist);
    }

    // 2. Spine & Ribs (Exposed decaying ribcage on walkers/runners)
    const spine = findBone(template, "mixamorig:Spine", "mixamorigSpine", "Spine");
    if (spine) {
      const lowerAb = createInkOutlinedMesh(
        new RoundedBoxGeometry(kind === "brute" ? 44 : 26, 16, 18, 2, 2),
        zombieSkinMat,
        0.04,
      );
      lowerAb.position.set(0, 6, 0);
      // Protruding ribs
      if (kind === "shambler" || kind === "runner") {
        for (const ry of [3, 9]) {
          const ribL = mesh(new THREE.BoxGeometry(12, 2.2, 19), boneMat);
          ribL.position.set(-6, ry, 1);
          const ribR = mesh(new THREE.BoxGeometry(12, 2.2, 19), boneMat);
          ribR.position.set(6, ry, 1);
          lowerAb.add(ribL, ribR);
        }
      }
      spine.add(lowerAb);
    }

    const spine1 = findBone(template, "mixamorig:Spine1", "mixamorigSpine1", "Spine1");
    if (spine1) {
      const midShirt = createInkOutlinedMesh(
        new RoundedBoxGeometry(kind === "brute" ? 52 : kind === "boomer" ? 44 : 33, 22, 22, 2, 3),
        shirtMat,
        0.04,
      );
      midShirt.position.set(0, 6, 0);

      if (kind === "boomer") {
        const bellyMat = new THREE.MeshStandardMaterial({
          color: 0x39ff14,
          emissive: 0x22b82f,
          emissiveIntensity: 2.2,
          roughness: 0.25,
        });
        const belly = createInkOutlinedMesh(new THREE.SphereGeometry(22, 14, 10), bellyMat, 0.05);
        belly.name = "boomer-belly-sac";
        belly.scale.set(1.35, 1.2, 1.45);
        belly.position.set(0, 4, 14);
        for (let p = 0; p < 6; p += 1) {
          const pAngle = (p * Math.PI) / 3;
          const pustule = mesh(new THREE.SphereGeometry(4.2, 6, 6), bellyMat);
          pustule.position.set(Math.cos(pAngle) * 14, Math.sin(pAngle) * 10 + 2, 16);
          belly.add(pustule);
        }
        spine1.add(belly);
      }

      spine1.add(midShirt);
    }

    const spine2 = findBone(template, "mixamorig:Spine2", "mixamorigSpine2", "Spine2", "Chest");
    if (spine2) {
      if (kind === "brute") {
        // Heavy Slate Padded Armor Vest
        const vest = createInkOutlinedMesh(new RoundedBoxGeometry(72, 52, 38, 3, 6), shirtMat, 0.05);
        vest.position.set(0, 10, 6);
        const rivetMat = new THREE.MeshBasicMaterial({ color: 0x9ca3af });
        for (const [rx, ry] of [[-24, 20], [24, 20], [-24, -5], [24, -5]]) {
          const rivet = mesh(new THREE.SphereGeometry(2.8, 6, 6), rivetMat);
          rivet.position.set(rx, ry, 26);
          vest.add(rivet);
        }
        spine2.add(vest);
      } else if (kind === "juggernaut") {
        const chestPlate = createInkOutlinedMesh(new RoundedBoxGeometry(82, 58, 36, 3, 6), shirtMat, 0.05);
        chestPlate.position.set(0, 12, 12);
        const coreMat = new THREE.MeshStandardMaterial({
          color: 0xff0055,
          emissive: 0xff0055,
          emissiveIntensity: 3.5,
        });
        const core = mesh(new THREE.CylinderGeometry(16, 16, 8, 14), coreMat);
        core.name = "juggernaut-boss-core";
        core.rotation.x = Math.PI / 2;
        core.position.set(0, 12, 30);
        spine2.add(chestPlate, core);
      } else {
        const upperShirt = createInkOutlinedMesh(new RoundedBoxGeometry(36, 28, 22, 2, 3), shirtMat, 0.04);
        upperShirt.position.set(0, 8, 0);
        spine2.add(upperShirt);
      }
    }

    // 3. Head & Decayed Skull
    const head = findBone(template, "mixamorig:Head", "mixamorigHead", "Head");
    if (head) {
      const skullRadius = kind === "brute" ? 16 : kind === "runner" ? 11 : 12.5;
      const skull = createInkOutlinedMesh(new THREE.SphereGeometry(skullRadius, 14, 10), zombieSkinMat, 0.04);
      skull.position.set(0, 8, 2);

      // Open sagging jaw
      const jaw = createInkOutlinedMesh(
        new RoundedBoxGeometry(skullRadius * 1.2, 8, 14, 2, 2),
        zombieSkinMat,
        0.04,
      );
      jaw.position.set(0, -2, 7);
      jaw.rotation.x = kind === "runner" ? 0.38 : 0.24;

      // Sunken glowing eye sockets
      const eyeColor =
        kind === "spitter"
          ? 0x39ff14
          : kind === "boomer"
            ? 0x76ff03
            : kind === "runner"
              ? 0xffaa00
              : kind === "juggernaut"
                ? 0xff0055
                : 0xffee55;
      const eyeMat = new THREE.MeshBasicMaterial({ color: eyeColor });
      for (const ex of [-4.2, 4.2]) {
        const eye = mesh(new THREE.SphereGeometry(2.2, 6, 6), eyeMat);
        eye.position.set(ex * (skullRadius / 12.5), 9, 12 * (skullRadius / 12.5));
        head.add(eye);
      }

      // Spitter Glowing Toxic Acid Sac
      if (kind === "spitter") {
        const sacMat = new THREE.MeshStandardMaterial({
          color: 0x39ff14,
          emissive: 0x39ff14,
          emissiveIntensity: 3.5,
          roughness: 0.15,
        });
        const sac = mesh(new THREE.SphereGeometry(18, 14, 10), sacMat);
        sac.name = "spitter-acid-sac";
        sac.scale.set(1.3, 1.2, 1.0);
        sac.position.set(0, -4, 16);
        head.add(sac);
      }

      // Juggernaut Horns
      if (kind === "juggernaut") {
        const hornMat = new THREE.MeshBasicMaterial({ color: 0x111827 });
        for (const hx of [-14, 14]) {
          const horn = createInkOutlinedMesh(new THREE.ConeGeometry(7, 38, 4), hornMat, 0.04);
          horn.position.set(hx, 28, 2);
          horn.rotation.z = (hx / 100) * -0.6;
          horn.rotation.x = -0.3;
          head.add(horn);
        }
      }

      head.add(skull, jaw);
    }

    // 4. Arms (Decaying zombie arms reaching forward)
    const addZombieArm = (armCandidates: string[], foreArmCandidates: string[], handCandidates: string[], isLeft: boolean) => {
      const armBone = findBone(template, ...armCandidates);
      if (armBone) {
        const armRadius = kind === "brute" ? 8.5 : 4.8;
        const bicep = createInkOutlinedMesh(new THREE.CapsuleGeometry(armRadius, 20, 4, 8), zombieSkinMat, 0.04);
        bicep.position.set(0, -10, 0);
        armBone.add(bicep);
      }
      const foreBone = findBone(template, ...foreArmCandidates);
      if (foreBone) {
        const foreRadius = kind === "brute" ? 8.0 : 4.4;
        const foreArm = createInkOutlinedMesh(
          new THREE.CapsuleGeometry(foreRadius, 20, 4, 8),
          kind === "brute" ? shirtMat : zombieSkinMat,
          0.04,
        );
        foreArm.position.set(0, -10, 0);
        foreBone.add(foreArm);
      }
      const handBone = findBone(template, ...handCandidates);
      if (handBone) {
        const hand = createInkOutlinedMesh(
          new THREE.SphereGeometry(kind === "brute" ? 8 : 5, 8, 6),
          zombieSkinMat,
          0.04,
        );
        hand.position.set(isLeft ? -2 : 2, -4, 0);
        handBone.add(hand);
      }
    };
    addZombieArm(["mixamorig:LeftArm", "mixamorigLeftArm", "LeftArm"], ["mixamorig:LeftForeArm", "mixamorigLeftForeArm", "LeftForeArm"], ["mixamorig:LeftHand", "mixamorigLeftHand", "LeftHand"], true);
    addZombieArm(["mixamorig:RightArm", "mixamorigRightArm", "RightArm"], ["mixamorig:RightForeArm", "mixamorigRightForeArm", "RightForeArm"], ["mixamorig:RightHand", "mixamorigRightHand", "RightHand"], false);

    // 5. Legs (Ripped trousers)
    const addZombieLeg = (upLegCandidates: string[], legCandidates: string[], footCandidates: string[]) => {
      const upLeg = findBone(template, ...upLegCandidates);
      if (upLeg) {
        const thighRadius = kind === "brute" ? 11 : 7.2;
        const thigh = createInkOutlinedMesh(new THREE.CapsuleGeometry(thighRadius, 28, 4, 8), jeansMat, 0.04);
        thigh.position.set(0, -18, 0);
        upLeg.add(thigh);
      }
      const leg = findBone(template, ...legCandidates);
      if (leg) {
        const shinRadius = kind === "brute" ? 9.5 : 6.2;
        const shin = createInkOutlinedMesh(new THREE.CapsuleGeometry(shinRadius, 26, 4, 8), jeansMat, 0.04);
        shin.position.set(0, -16, 0);
        leg.add(shin);
      }
      const foot = findBone(template, ...footCandidates);
      if (foot) {
        const footRadius = kind === "brute" ? 15 : 10;
        const shoe = createInkOutlinedMesh(new RoundedBoxGeometry(footRadius, 12, 24, 2, 2), shoeMat, 0.04);
        shoe.position.set(0, -4, 6);
        foot.add(shoe);
      }
    };
    addZombieLeg(["mixamorig:LeftUpLeg", "mixamorigLeftUpLeg", "LeftUpLeg"], ["mixamorig:LeftLeg", "mixamorigLeftLeg", "LeftLeg"], ["mixamorig:LeftFoot", "mixamorigLeftFoot", "LeftFoot"]);
    addZombieLeg(["mixamorig:RightUpLeg", "mixamorigRightUpLeg", "RightUpLeg"], ["mixamorig:RightLeg", "mixamorigRightLeg", "RightLeg"], ["mixamorig:RightFoot", "mixamorigRightFoot", "RightFoot"]);
  }

  // --- WAREHOUSE PROPS MATCHING SCREENSHOT ---

  createFurnaceBeacon() {
    const root = new THREE.Group();
    const darkSteel = new THREE.MeshToonMaterial({ color: 0x1f2937, gradientMap: this.toonRamp });
    const glowCore = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // Stand base
    const base = createInkOutlinedMesh(new RoundedBoxGeometry(0.8, 0.2, 0.8, 2, 0.04), darkSteel, 0.04);
    base.position.y = 0.1;
    const pillar = createInkOutlinedMesh(new THREE.CylinderGeometry(0.08, 0.12, 0.9, 10), darkSteel, 0.04);
    pillar.position.y = 0.65;

    // Glowing Furnace Lightbox
    const box = createInkOutlinedMesh(new RoundedBoxGeometry(0.72, 0.78, 0.54, 2, 0.04), darkSteel, 0.04);
    box.position.y = 1.35;
    const core = mesh(new RoundedBoxGeometry(0.54, 0.6, 0.06, 1, 0.02), glowCore);
    core.position.set(0, 1.35, 0.26);

    const furnaceLight = new THREE.PointLight(0xff8800, 7, 8, 2);
    furnaceLight.position.set(0, 1.35, 0.35);

    root.add(base, pillar, box, core, furnaceLight);
    addContactShadow(root, 0.52, 0.38, 0.3);
    addGraphicInkEdges(root, 0.34);
    castAndReceive(root);
    return root;
  }

  createTrafficBarricade(width = 2.4) {
    const root = new THREE.Group();
    const concreteMat = new THREE.MeshToonMaterial({ color: 0x9ca3af, gradientMap: this.toonRamp });
    const orangeStripeMat = new THREE.MeshToonMaterial({ color: 0xf97316, gradientMap: this.toonRamp });
    const whiteStripeMat = new THREE.MeshToonMaterial({ color: 0xf3f4f6, gradientMap: this.toonRamp });

    const barrierBody = createInkOutlinedMesh(new RoundedBoxGeometry(width, 0.78, 0.42, 2, 0.04), concreteMat, 0.04);
    barrierBody.position.y = 0.39;
    root.add(barrierBody);

    // Diagonal Hazard Stripes
    const stripeCount = Math.floor(width / 0.4);
    for (let i = 0; i < stripeCount; i += 1) {
      const x = -width / 2 + (i + 0.5) * (width / stripeCount);
      const stripe = mesh(new THREE.PlaneGeometry(0.24, 0.6), i % 2 === 0 ? orangeStripeMat : whiteStripeMat);
      stripe.position.set(x, 0.4, 0.215);
      root.add(stripe);
    }

    // Top blinking amber hazard light
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    const lamp = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.14, 8), lightMat);
    lamp.position.set(0, 0.85, 0);
    root.add(lamp);

    addIllustratedWear(root, width * 0.86, 0.7, 0.218, 0.16);
    addContactShadow(root, width * 0.5, 0.3, 0.3);
    addGraphicInkEdges(root, 0.34);
    castAndReceive(root);
    return root;
  }

  createTrafficCone() {
    const root = new THREE.Group();
    const orangeMat = new THREE.MeshToonMaterial({ color: 0xea580c, gradientMap: this.toonRamp });
    const whiteMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: this.toonRamp });
    const blackMat = new THREE.MeshToonMaterial({ color: 0x111827, gradientMap: this.toonRamp });

    const base = createInkOutlinedMesh(new RoundedBoxGeometry(0.48, 0.04, 0.48, 1, 0.01), blackMat, 0.04);
    base.position.y = 0.02;
    const cone = createInkOutlinedMesh(new THREE.ConeGeometry(0.18, 0.72, 12), orangeMat, 0.04);
    cone.position.y = 0.38;
    const band = mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.22, 12, 1, true), whiteMat);
    band.position.y = 0.42;

    root.add(base, cone, band);
    addContactShadow(root, 0.25, 0.18, 0.24);
    addGraphicInkEdges(root, 0.28);
    castAndReceive(root);
    return root;
  }

  createPallet() {
    const root = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x926c48, roughness: 0.9, metalness: 0.05 });

    // 3 stringers
    for (const z of [-0.55, 0, 0.55]) {
      const stringer = mesh(new THREE.BoxGeometry(1.3, 0.09, 0.12), woodMat);
      stringer.position.set(0, 0.06, z);
      root.add(stringer);
    }
    // 5 deck boards
    for (let x = -0.55; x <= 0.55; x += 0.275) {
      const plank = mesh(new THREE.BoxGeometry(0.16, 0.025, 1.25), woodMat);
      plank.position.set(x, 0.115, 0);
      root.add(plank);
    }

    addContactShadow(root, 0.7, 0.56, 0.2);
    addGraphicInkEdges(root, 0.18);
    castAndReceive(root);
    return root;
  }

  createSlimePool(radius = 1.4) {
    const root = new THREE.Group();
    const fluidMat = new THREE.MeshStandardMaterial({
      color: 0x288e3b,
      emissive: 0x105e29,
      emissiveIntensity: 0.34,
      roughness: 0.15,
      transparent: true,
      opacity: 0.7,
    });

    const inkMat = new THREE.MeshBasicMaterial({ color: 0x07130a, transparent: true, opacity: 0.82, depthWrite: false });
    const blobs: Array<[number, number, number, number]> = [
      [0, 0, 1, 0.74],
      [radius * 0.52, radius * 0.08, 0.56, 0.44],
      [-radius * 0.46, -radius * 0.12, 0.48, 0.58],
      [radius * 0.08, -radius * 0.5, 0.4, 0.32],
    ];
    for (const [x, z, sx, sz] of blobs) {
      const ink = mesh(new THREE.CircleGeometry(radius * 1.07, 22), inkMat);
      ink.rotation.x = -Math.PI / 2;
      ink.scale.set(sx, sz, 1);
      ink.position.set(x, 0.036, z);
      const fluid = mesh(new THREE.CircleGeometry(radius, 22), fluidMat);
      fluid.rotation.x = -Math.PI / 2;
      fluid.scale.set(sx, sz, 1);
      fluid.position.set(x, 0.039, z);
      root.add(ink, fluid);
    }

    const glint = mesh(
      new THREE.RingGeometry(radius * 0.18, radius * 0.22, 18),
      new THREE.MeshBasicMaterial({ color: 0x8fc96a, transparent: true, opacity: 0.24, side: THREE.DoubleSide }),
    );
    glint.rotation.x = -Math.PI / 2;
    glint.position.set(-radius * 0.18, 0.043, -radius * 0.06);

    const slimeLight = new THREE.PointLight(0x39b956, 1, 3.8, 2);
    slimeLight.position.y = 0.6;

    root.add(glint, slimeLight);
    return root;
  }

  setPlayerWeapon(rig: CharacterRig, weaponId: WeaponId) {
    if (!rig.weaponModels || rig.currentWeaponId === weaponId) return;
    rig.currentWeaponId = weaponId;
    for (const [id, model] of rig.weaponModels.entries()) {
      const active = id === weaponId;
      model.group.visible = active;
      if (active) {
        rig.muzzle = model.muzzle;
      }
    }
  }

  private createPlayerWeaponRigs() {
    const masterGroup = new THREE.Group();
    masterGroup.position.set(0.08, 1.2, 0.33);

    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x151b1d, roughness: 0.28, metalness: 0.9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x485255, roughness: 0.35, metalness: 0.75 });
    const darkPolymer = new THREE.MeshStandardMaterial({ color: 0x0e1312, roughness: 0.65, metalness: 0.2 });
    const cyanGlow = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00f5d4,
      emissiveIntensity: 2.5,
      roughness: 0.2,
    });
    const redGlow = new THREE.MeshStandardMaterial({
      color: 0xff0055,
      emissive: 0xff0055,
      emissiveIntensity: 2.8,
      roughness: 0.2,
    });
    const goldBrass = new THREE.MeshStandardMaterial({
      color: 0xffb703,
      emissive: 0xffb703,
      emissiveIntensity: 1.2,
      metalness: 0.9,
      roughness: 0.2,
    });

    const weaponModels = new Map<WeaponId, { group: THREE.Group; muzzle: THREE.Object3D }>();

    // 1. PISTOL - Service Pistol (Compact tactical handgun with underbarrel laser)
    {
      const group = new THREE.Group();
      const frame = mesh(new RoundedBoxGeometry(0.14, 0.16, 0.32, 2, 0.02), gunmetal);
      frame.position.set(0, 0, 0.12);
      const slide = mesh(new RoundedBoxGeometry(0.15, 0.11, 0.38, 2, 0.02), steel);
      slide.position.set(0, 0.11, 0.15);
      const barrel = mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.22, 8), steel);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.11, 0.38);
      const laserBox = mesh(new RoundedBoxGeometry(0.09, 0.07, 0.16, 2, 0.015), darkPolymer);
      laserBox.position.set(0, -0.01, 0.24);
      const laserDot = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 6), cyanGlow);
      laserDot.rotation.x = Math.PI / 2;
      laserDot.position.set(0, -0.01, 0.33);
      const grip = mesh(new RoundedBoxGeometry(0.12, 0.26, 0.13, 2, 0.02), darkPolymer);
      grip.position.set(0, -0.16, -0.02);
      grip.rotation.x = -0.22;
      const sight = mesh(new RoundedBoxGeometry(0.04, 0.04, 0.04, 1, 0.01), cyanGlow);
      sight.position.set(0, 0.18, 0.32);

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.11, 0.52);
      group.add(frame, slide, barrel, laserBox, laserDot, grip, sight, muzzle);
      masterGroup.add(group);
      weaponModels.set("pistol", { group, muzzle });
    }

    // 2. SMG - Viper SMG (Compact fast-firing SMG with curved stick mag and reflex sight)
    {
      const group = new THREE.Group();
      group.visible = false;
      const receiver = mesh(new RoundedBoxGeometry(0.17, 0.19, 0.54, 2, 0.025), gunmetal);
      receiver.position.set(0, 0.02, 0.16);
      const shroud = mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.44, 10), steel);
      shroud.rotation.x = Math.PI / 2;
      shroud.position.set(0, 0.04, 0.52);
      const curvedMag = mesh(new RoundedBoxGeometry(0.09, 0.38, 0.14, 2, 0.02), darkPolymer);
      curvedMag.position.set(0, -0.22, 0.26);
      curvedMag.rotation.x = 0.22;
      const grip = mesh(new RoundedBoxGeometry(0.12, 0.28, 0.13, 2, 0.02), darkPolymer);
      grip.position.set(0, -0.18, -0.02);
      grip.rotation.x = -0.22;
      const wireStock = mesh(new THREE.TorusGeometry(0.14, 0.022, 4, 12, Math.PI), steel);
      wireStock.rotation.z = -Math.PI / 2;
      wireStock.position.set(0, -0.02, -0.26);
      const reflexHousing = mesh(new RoundedBoxGeometry(0.1, 0.1, 0.14, 2, 0.015), darkPolymer);
      reflexHousing.position.set(0, 0.18, 0.18);
      const reflexDot = mesh(new RoundedBoxGeometry(0.04, 0.04, 0.02, 1, 0.01), redGlow);
      reflexDot.position.set(0, 0.18, 0.18);

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.04, 0.76);
      group.add(receiver, shroud, curvedMag, grip, wireStock, reflexHousing, reflexDot, muzzle);
      masterGroup.add(group);
      weaponModels.set("smg", { group, muzzle });
    }

    // 3. SHOTGUN - Breach Shotgun (Heavy dual barrel pump-action with brass chamber)
    {
      const group = new THREE.Group();
      group.visible = false;
      const receiver = mesh(new RoundedBoxGeometry(0.24, 0.22, 0.58, 2, 0.035), gunmetal);
      receiver.position.set(0, 0.04, 0.14);
      const topBarrel = mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.68, 10), steel);
      topBarrel.rotation.x = Math.PI / 2;
      topBarrel.position.set(0, 0.09, 0.62);
      const magTube = mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.64, 10), gunmetal);
      magTube.rotation.x = Math.PI / 2;
      magTube.position.set(0, -0.01, 0.6);
      const pumpForearm = mesh(new RoundedBoxGeometry(0.18, 0.16, 0.28, 2, 0.03), darkPolymer);
      pumpForearm.position.set(0, -0.01, 0.52);
      const shellPort = mesh(new RoundedBoxGeometry(0.05, 0.08, 0.16, 1, 0.01), goldBrass);
      shellPort.position.set(0.12, 0.06, 0.18);
      const heavyStock = mesh(new RoundedBoxGeometry(0.22, 0.24, 0.44, 2, 0.035), darkPolymer);
      heavyStock.position.set(0, -0.04, -0.32);
      const grip = mesh(new RoundedBoxGeometry(0.13, 0.28, 0.14, 2, 0.025), darkPolymer);
      grip.position.set(0, -0.19, -0.02);
      grip.rotation.x = -0.22;

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.09, 0.98);
      group.add(receiver, topBarrel, magTube, pumpForearm, shellPort, heavyStock, grip, muzzle);
      masterGroup.add(group);
      weaponModels.set("shotgun", { group, muzzle });
    }

    // 4. RIFLE - Sentinel Battle Rifle (Long DMR with high-tech sniper optic & muzzle compensator)
    {
      const group = new THREE.Group();
      group.visible = false;
      const receiver = mesh(new RoundedBoxGeometry(0.22, 0.2, 0.65, 2, 0.03), gunmetal);
      receiver.position.set(0, 0.05, 0.16);
      const upper = mesh(new RoundedBoxGeometry(0.16, 0.12, 0.58, 2, 0.025), steel);
      upper.position.set(0, 0.18, 0.2);
      const longBarrel = mesh(new THREE.CylinderGeometry(0.036, 0.044, 0.88, 12), steel);
      longBarrel.rotation.x = Math.PI / 2;
      longBarrel.position.set(0, 0.06, 0.82);
      const compensator = mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.26, 8), gunmetal);
      compensator.rotation.x = Math.PI / 2;
      compensator.position.set(0, 0.06, 1.28);
      const scopeBody = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.42, 12), darkPolymer);
      scopeBody.rotation.x = Math.PI / 2;
      scopeBody.position.set(0, 0.29, 0.22);
      const scopeLens = mesh(new THREE.CircleGeometry(0.055, 12), cyanGlow);
      scopeLens.position.set(0, 0.29, 0.44);
      const mag = mesh(new RoundedBoxGeometry(0.11, 0.36, 0.18, 2, 0.025), darkPolymer);
      mag.position.set(0, -0.21, 0.28);
      const marksmanStock = mesh(new RoundedBoxGeometry(0.24, 0.26, 0.46, 2, 0.04), steel);
      marksmanStock.position.set(0, -0.02, -0.36);
      const grip = mesh(new RoundedBoxGeometry(0.13, 0.29, 0.14, 2, 0.025), darkPolymer);
      grip.position.set(0, -0.19, -0.02);
      grip.rotation.x = -0.22;

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.06, 1.42);
      group.add(receiver, upper, longBarrel, compensator, scopeBody, scopeLens, mag, marksmanStock, grip, muzzle);
      masterGroup.add(group);
      weaponModels.set("rifle", { group, muzzle });
    }

    masterGroup.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = false;
    });

    const initialMuzzle = weaponModels.get("pistol")?.muzzle ?? new THREE.Object3D();
    return { group: masterGroup, weaponModels, initialMuzzle };
  }

  private addDrain(root: THREE.Group, x: number, z: number, rotation: number) {
    const drainMat = new THREE.MeshStandardMaterial({ color: 0x161b19, roughness: 0.4, metalness: 0.85 });
    const drain = new THREE.Group();
    const frame = mesh(new RoundedBoxGeometry(2.4, 0.045, 0.85, 2, 0.03), drainMat);
    drain.add(frame);

    for (let index = -5; index <= 5; index += 1) {
      const slit = mesh(new THREE.BoxGeometry(0.09, 0.02, 0.68), new THREE.MeshBasicMaterial({ color: 0x050807 }));
      slit.position.set(index * 0.2, 0.03, 0);
      drain.add(slit);
    }
    drain.position.set(x, 0.026, z);
    drain.rotation.y = rotation;
    root.add(drain);
  }

  private addDust(scene: THREE.Scene) {
    const count = 160;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = THREE.MathUtils.randFloatSpread(40);
      positions[i * 3 + 1] = THREE.MathUtils.randFloat(0.1, 3.2);
      positions[i * 3 + 2] = THREE.MathUtils.randFloatSpread(40);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x00f5d4,
        size: 0.045,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    points.name = "ambient-dust";
    scene.add(points);
  }

  private createStylizedGroundTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Warm industrial concrete base
      ctx.fillStyle = "#4a4e52";
      ctx.fillRect(0, 0, 1024, 1024);

      // Procedural concrete aggregate and grit noise
      for (let i = 0; i < 6000; i += 1) {
        const x = Math.random() * 1024;
        const y = Math.random() * 1024;
        const radius = Math.random() * 2.2 + 0.5;
        const brightness = Math.random() > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.12)";
        ctx.fillStyle = brightness;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Concrete slabs division joints
      ctx.strokeStyle = "#25282a";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(512, 0); ctx.lineTo(512, 1024);
      ctx.moveTo(0, 512); ctx.lineTo(1024, 512);
      ctx.stroke();

      // Detailed branching fissure cracks
      const drawCrack = (startX: number, startY: number, segments: number, maxLen: number) => {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        let currX = startX;
        let currY = startY;
        for (let s = 0; s < segments; s += 1) {
          const angle = Math.random() * Math.PI * 2;
          const len = Math.random() * maxLen + 10;
          currX += Math.cos(angle) * len;
          currY += Math.sin(angle) * len;
          ctx.lineTo(currX, currY);
        }
        ctx.strokeStyle = "#1b1e20";
        ctx.lineWidth = 3.5;
        ctx.stroke();

        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      };

      // Fissure clusters across slabs
      drawCrack(220, 240, 6, 35);
      drawCrack(250, 270, 4, 25);
      drawCrack(760, 320, 7, 40);
      drawCrack(780, 350, 5, 20);
      drawCrack(340, 780, 6, 35);
      drawCrack(820, 740, 8, 45);
      drawCrack(512, 512, 9, 30);

      // Yellow industrial hazard boundary lines & caution stripes
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(40, 40, 944, 20);
      ctx.fillRect(40, 964, 944, 20);
      ctx.fillRect(40, 40, 20, 944);
      ctx.fillRect(964, 40, 20, 944);

      // Black diagonal hash marks inside hazard lines
      ctx.fillStyle = "#1e2422";
      for (let x = 40; x < 984; x += 36) {
        ctx.beginPath();
        ctx.moveTo(x, 40);
        ctx.lineTo(x + 18, 40);
        ctx.lineTo(x + 6, 60);
        ctx.lineTo(x - 12, 60);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x, 964);
        ctx.lineTo(x + 18, 964);
        ctx.lineTo(x + 6, 984);
        ctx.lineTo(x - 12, 984);
        ctx.closePath();
        ctx.fill();
      }

      // Metal Drainage Grates
      const drawDrainGrate = (gx: number, gy: number, gw: number, gh: number) => {
        ctx.fillStyle = "#1b2024";
        ctx.fillRect(gx, gy, gw, gh);
        ctx.strokeStyle = "#384148";
        ctx.lineWidth = 4;
        ctx.strokeRect(gx, gy, gw, gh);

        // Slits
        ctx.fillStyle = "#090c0e";
        for (let sy = gy + 8; sy < gy + gh - 8; sy += 12) {
          ctx.fillRect(gx + 8, sy, gw - 16, 5);
        }
      };

      drawDrainGrate(540, 160, 60, 240);
      drawDrainGrate(160, 620, 240, 60);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.5, 2.5);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  private createHazardTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffb703";
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = "#111714";
      for (let x = -64; x < 320; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 18, 0);
        ctx.lineTo(x + 36, 64);
        ctx.lineTo(x + 18, 64);
        ctx.closePath();
        ctx.fill();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 1);
    return texture;
  }

  private createBloodTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, 256, 256);
      const gradient = context.createRadialGradient(128, 128, 10, 128, 128, 95);
      gradient.addColorStop(0, "rgba(142, 16, 42, 0.92)");
      gradient.addColorStop(0.48, "rgba(92, 8, 30, 0.88)");
      gradient.addColorStop(0.82, "rgba(52, 4, 20, 0.78)");
      gradient.addColorStop(1, "rgba(38, 3, 15, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      for (let i = 0; i < 24; i += 1) {
        const angle = (i / 24) * Math.PI * 2;
        const radius = 62 + Math.sin(i * 5.2) * 22 + (i % 3) * 8;
        const x = 128 + Math.cos(angle) * radius;
        const y = 128 + Math.sin(angle) * radius;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();

      context.fillStyle = "rgba(105, 8, 30, 0.72)";
      for (let i = 0; i < 16; i += 1) {
        const angle = i * 2.41;
        const distance = 72 + (i % 7) * 12;
        const radius = 2.5 + (i % 5) * 2;
        context.beginPath();
        context.arc(128 + Math.cos(angle) * distance, 128 + Math.sin(angle) * distance, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createAcidTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 256, 256);
      const gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 92);
      gradient.addColorStop(0, "rgba(57, 255, 20, 0.95)");
      gradient.addColorStop(0.5, "rgba(34, 197, 94, 0.82)");
      gradient.addColorStop(1, "rgba(20, 120, 50, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      for (let i = 0; i < 24; i += 1) {
        const angle = (i / 24) * Math.PI * 2;
        const radius = 60 + Math.sin(i * 4.8) * 20 + (i % 4) * 6;
        const x = 128 + Math.cos(angle) * radius;
        const y = 128 + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(118, 255, 3, 0.9)";
      for (let i = 0; i < 14; i += 1) {
        const angle = i * 2.3;
        const dist = 70 + (i % 6) * 10;
        const r = 2.5 + (i % 4) * 1.5;
        ctx.beginPath();
        ctx.arc(128 + Math.cos(angle) * dist, 128 + Math.sin(angle) * dist, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createChainTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, 128, 128);
      context.strokeStyle = "rgba(0, 245, 212, 0.85)";
      context.lineWidth = 2.5;
      for (let offset = -128; offset < 256; offset += 24) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset + 128, 128);
        context.stroke();
        context.beginPath();
        context.moveTo(offset + 128, 0);
        context.lineTo(offset, 128);
        context.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 1.4);
    return texture;
  }

  createChainLightningMesh(points: THREE.Vector3[], color = 0x00f5d4): THREE.LineSegments {
    const vertices: number[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const mid = p1.clone().lerp(p2, 0.5);
      mid.x += THREE.MathUtils.randFloatSpread(0.45);
      mid.y += THREE.MathUtils.randFloat(0.1, 0.45);
      mid.z += THREE.MathUtils.randFloatSpread(0.45);

      vertices.push(p1.x, p1.y, p1.z, mid.x, mid.y, mid.z);
      vertices.push(mid.x, mid.y, mid.z, p2.x, p2.y, p2.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      linewidth: 3,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(geometry, material);
    line.name = "chain-lightning";
    return line;
  }

  createShockwaveMesh(radius: number, color = 0xff0055): THREE.Group {
    const group = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = mesh(new THREE.RingGeometry(Math.max(0.05, radius * 0.88), radius, 36), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;

    const inkBorder = mesh(
      new THREE.RingGeometry(Math.max(0.05, radius * 0.98), radius * 1.05, 36),
      new THREE.MeshBasicMaterial({ color: 0x0a0505, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    inkBorder.rotation.x = -Math.PI / 2;
    inkBorder.position.y = 0.048;

    group.add(ring, inkBorder);
    return group;
  }

  createEliteShieldMesh(radius = 1.15): THREE.Mesh {
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      wireframe: true,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    const shield = new THREE.Mesh(geo, mat);
    shield.name = "elite-shield";
    shield.position.y = radius * 0.75;
    return shield;
  }

  createTelegraphLine(length: number, width = 1.4): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(width, length);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff0033,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.042;
    plane.name = "telegraph-line";
    return plane;
  }

  createTelegraphCircle(radius = 4.5): THREE.Group {
    const group = new THREE.Group();
    const fill = mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({ color: 0xff0044, transparent: true, opacity: 0.24, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.04;

    const border = mesh(
      new THREE.RingGeometry(radius * 0.94, radius, 32),
      new THREE.MeshBasicMaterial({ color: 0xff0044, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    );
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.042;

    group.add(fill, border);
    group.name = "telegraph-circle";
    return group;
  }
}
