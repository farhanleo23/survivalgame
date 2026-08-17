import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedModel } from "three/addons/utils/SkeletonUtils.js";
import type { EnemyDefinition, EnemyId } from "./types";

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
  hitMaterials: THREE.MeshStandardMaterial[];
  model?: THREE.Object3D;
  mixer?: THREE.AnimationMixer;
  actions?: Partial<Record<CharacterMotion, THREE.AnimationAction>>;
  activeMotion?: CharacterMotion;
  hitShell?: THREE.Mesh;
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
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
};

const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => new THREE.Mesh(geometry, material);

interface DisposableResources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
  skeletons: Set<THREE.Skeleton>;
}

const createDisposableResources = (): DisposableResources => ({
  geometries: new Set(),
  materials: new Set(),
  textures: new Set(),
  skeletons: new Set(),
});

const collectMaterial = (material: THREE.Material, resources: DisposableResources, includeTextures: boolean) => {
  resources.materials.add(material);
  if (!includeTextures) return;
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) resources.textures.add(value);
  }
};

const collectObjectResources = (root: THREE.Object3D, resources: DisposableResources, includeTextures: boolean) => {
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) resources.skeletons.add(object.skeleton);
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
    resources.geometries.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) collectMaterial(material, resources, includeTextures);
  });
};

const disposeResources = (resources: DisposableResources) => {
  for (const skeleton of resources.skeletons) skeleton.dispose();
  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();
  for (const texture of resources.textures) texture.dispose();
};

const disposeObjectResources = (root: THREE.Object3D, includeTextures = false) => {
  const resources = createDisposableResources();
  collectObjectResources(root, resources, includeTextures);
  disposeResources(resources);
};

export class VisualFactory {
  readonly groundMaterial: THREE.MeshStandardMaterial;
  private bloodTexture: THREE.CanvasTexture;
  private chainTexture: THREE.CanvasTexture;
  private bloodDecals: THREE.Mesh[] = [];
  private characterAsset: Promise<CharacterAsset>;
  private characterAssetData?: CharacterAsset;
  private asphaltTexture?: THREE.Texture;
  private characterTemplates = new Map<string, THREE.Object3D>();
  private disposed = false;
  constructor(private renderer: THREE.WebGLRenderer) {
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x788078,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.bloodTexture = this.createBloodTexture();
    this.chainTexture = this.createChainTexture();
    this.characterAsset = new GLTFLoader().loadAsync("/models/soldier.glb").then((asset) => {
      const data = { scene: asset.scene, animations: asset.animations };
      this.characterAssetData = data;
      if (this.disposed) disposeObjectResources(asset.scene, true);
      return data;
    });
    const loader = new THREE.TextureLoader();
    loader.load("/textures/depot-asphalt-v1.png", (texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }
      this.asphaltTexture = texture;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(4.5, 4.5);
      texture.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
      this.groundMaterial.map = texture;
      this.groundMaterial.bumpMap = texture;
      this.groundMaterial.bumpScale = 0.1;
      this.groundMaterial.needsUpdate = true;
    });
  }

  async ready() {
    try {
      const asset = await this.characterAsset;
      if (this.disposed) return;
      const kinds: Array<"player" | EnemyId> = ["player", "shambler", "runner", "spitter", "brute", "juggernaut"];
      for (const kind of kinds) this.getCharacterTemplate(asset.scene, kind);
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

    const paint = new THREE.MeshStandardMaterial({ color: 0xc5b36a, roughness: 0.9, transparent: true, opacity: 0.48 });
    for (let index = -4; index <= 4; index += 1) {
      const dash = mesh(new RoundedBoxGeometry(0.17, 0.025, 2.2, 2, 0.02), paint);
      dash.position.set(0, 0.024, index * 4.5);
      group.add(dash);
    }
    const laneEdge = new THREE.Mesh(
      new THREE.RingGeometry(5.6, 5.74, 72, 1, 0.15, Math.PI * 1.7),
      paint,
    );
    laneEdge.rotation.x = -Math.PI / 2;
    laneEdge.rotation.z = -0.35;
    laneEdge.position.set(2.2, 0.028, -1.2);
    group.add(laneEdge);

    const arrowMaterial = new THREE.MeshStandardMaterial({ color: 0xd6d3b4, roughness: 0.95, transparent: true, opacity: 0.34 });
    const arrowStem = mesh(new THREE.BoxGeometry(0.32, 0.025, 2.2), arrowMaterial);
    arrowStem.position.set(-7, 0.028, 0.4);
    const arrowHead = mesh(new THREE.ConeGeometry(0.75, 1.4, 3), arrowMaterial);
    arrowHead.rotation.x = Math.PI / 2;
    arrowHead.position.set(-7, 0.045, -1.2);
    group.add(arrowStem, arrowHead);

    const puddleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x17262a,
      roughness: 0.16,
      metalness: 0.05,
      transmission: 0.08,
      transparent: true,
      opacity: 0.54,
      depthWrite: false,
    });
    for (const [x, z, sx, sz] of [[-5.5, -8.2, 2.3, 0.8], [8.2, -1.5, 1.5, 0.62], [4.6, 9.3, 2.1, 0.72]] as const) {
      const puddle = mesh(new THREE.CircleGeometry(1, 48), puddleMaterial);
      puddle.rotation.x = -Math.PI / 2;
      puddle.scale.set(sx, sz, 1);
      puddle.position.set(x, 0.034, z);
      group.add(puddle);
    }
    this.addDrain(group, -2.8, 8.3, 0.15);
    this.addDrain(group, 9.8, -6.6, -0.2);
    return group;
  }

  addPerimeter(scene: THREE.Scene) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x303a3a, metalness: 0.82, roughness: 0.38 });
    const fence = new THREE.MeshStandardMaterial({
      color: 0x82928d,
      map: this.chainTexture,
      alphaMap: this.chainTexture,
      transparent: true,
      opacity: 0.62,
      alphaTest: 0.25,
      side: THREE.DoubleSide,
      metalness: 0.65,
      roughness: 0.5,
    });
    const sides: Array<[number, number, number]> = [
      [0, -20.25, 0], [0, 20.25, 0], [-20.25, 0, Math.PI / 2], [20.25, 0, Math.PI / 2],
    ];
    for (const [x, z, rotation] of sides) {
      const panel = mesh(new THREE.PlaneGeometry(40, 3.2), fence);
      panel.position.set(x, 1.65, z);
      panel.rotation.y = rotation;
      scene.add(panel);
      for (let p = -20; p <= 20; p += 4) {
        const post = mesh(new THREE.CylinderGeometry(0.075, 0.1, 3.7, 12), metal);
        post.position.set(rotation ? x : p, 1.85, rotation ? p : z);
        scene.add(post);
      }
    }

    const beaconMaterial = new THREE.MeshStandardMaterial({ color: 0x5f0c08, emissive: 0xff351f, emissiveIntensity: 3, roughness: 0.3 });
    for (const [x, z] of [[-19.7, -19.7], [19.7, -19.7], [-19.7, 19.7], [19.7, 19.7]] as const) {
      const base = mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.32, 18), metal);
      base.position.set(x, 0.16, z);
      const beacon = mesh(new THREE.SphereGeometry(0.17, 16, 10), beaconMaterial);
      beacon.position.set(x, 0.47, z);
      const light = new THREE.PointLight(0xff3b24, 8, 5, 2);
      light.position.copy(beacon.position);
      scene.add(base, beacon, light);
    }
  }

  createDepotStructure(width: number, depth: number, variant: number) {
    const root = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: variant % 2 ? 0x59615e : 0x4d5754, roughness: 0.82, metalness: 0.06 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x202b2d, roughness: 0.38, metalness: 0.76 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xb88d37, roughness: 0.66, metalness: 0.18 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x91d5c0, emissive: 0x0b4237, emissiveIntensity: 1.5, metalness: 0.28, roughness: 0.22 });

    const body = mesh(new RoundedBoxGeometry(width, 2.2, depth, 6, 0.14), concrete);
    body.position.y = 1.1;
    root.add(body);
    const cap = mesh(new RoundedBoxGeometry(width + 0.16, 0.18, depth + 0.16, 3, 0.045), frame);
    cap.position.y = 2.22;
    root.add(cap);

    const longFace = width >= depth;
    const panelCount = Math.max(2, Math.floor((longFace ? width : depth) / 1.2));
    for (let index = 0; index < panelCount; index += 1) {
      const ratio = (index + 0.5) / panelCount - 0.5;
      const rib = mesh(new THREE.BoxGeometry(longFace ? 0.055 : width + 0.04, 1.82, longFace ? depth + 0.04 : 0.055), frame);
      rib.position.set(longFace ? ratio * width : 0, 1.1, longFace ? 0 : ratio * depth);
      root.add(rib);
    }

    const doorWidth = Math.min(1.3, width * 0.3);
    const door = mesh(new RoundedBoxGeometry(doorWidth, 1.55, 0.08, 3, 0.025), frame);
    door.position.set(longFace ? width * 0.2 : depth / 2 + 0.045, 0.82, longFace ? depth / 2 + 0.045 : 0);
    if (!longFace) door.rotation.y = Math.PI / 2;
    root.add(door);
    const windowPanel = mesh(new RoundedBoxGeometry(Math.min(1.45, width * 0.35), 0.42, 0.06, 3, 0.03), glass);
    windowPanel.position.set(longFace ? -width * 0.2 : depth / 2 + 0.055, 1.48, longFace ? depth / 2 + 0.055 : 0);
    if (!longFace) windowPanel.rotation.y = Math.PI / 2;
    root.add(windowPanel);
    const stripe = mesh(new THREE.BoxGeometry(width + 0.04, 0.16, depth + 0.04), trim);
    stripe.position.y = 0.42;
    root.add(stripe);

    const vent = mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.45, 18), frame);
    vent.position.set(width * -0.26, 2.46, 0);
    const ventCap = mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 18), frame);
    ventCap.position.set(width * -0.26, 2.72, 0);
    root.add(vent, ventCap);
    castAndReceive(root);
    return root;
  }

  createBarricade(width: number, depth: number) {
    const root = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x66513c, roughness: 0.92 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2d3435, metalness: 0.8, roughness: 0.38 });
    const warning = new THREE.MeshStandardMaterial({ color: 0xcfb447, roughness: 0.75 });
    for (const x of [-width * 0.34, width * 0.34]) {
      const leg = mesh(new RoundedBoxGeometry(0.15, 0.8, depth * 1.6, 3, 0.035), steel);
      leg.position.set(x, 0.38, 0);
      root.add(leg);
    }
    for (const [y, material] of [[0.32, wood], [0.66, warning], [0.93, wood]] as const) {
      const plank = mesh(new RoundedBoxGeometry(width, 0.2, depth, 3, 0.035), material);
      plank.position.y = y;
      root.add(plank);
    }
    for (let index = -2; index <= 2; index += 1) {
      const stripe = mesh(new THREE.BoxGeometry(0.34, 0.205, depth + 0.015), steel);
      stripe.position.set(index * width / 5, 0.66, 0);
      stripe.rotation.z = 0.42;
      root.add(stripe);
    }
    castAndReceive(root);
    return root;
  }

  createFloodlight(color: number) {
    const root = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x303a3c, metalness: 0.86, roughness: 0.34 });
    const glass = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 4, roughness: 0.18 });
    const base = mesh(new THREE.CylinderGeometry(0.24, 0.42, 0.3, 18), steel);
    base.position.y = 0.15;
    const pole = mesh(new THREE.CylinderGeometry(0.07, 0.11, 4.8, 14), steel);
    pole.position.y = 2.55;
    root.add(base, pole);
    for (const x of [-0.29, 0.29]) {
      const lamp = mesh(new RoundedBoxGeometry(0.46, 0.3, 0.24, 3, 0.045), steel);
      lamp.position.set(x, 4.83, 0);
      lamp.rotation.x = -0.32;
      const face = mesh(new RoundedBoxGeometry(0.34, 0.2, 0.03, 2, 0.02), glass);
      face.position.set(x, 4.79, 0.135);
      face.rotation.x = -0.32;
      root.add(lamp, face);
    }
    castAndReceive(root);
    return root;
  }

  createBarrel() {
    const root = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0x8f2c21, roughness: 0.48, metalness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x25292a, roughness: 0.34, metalness: 0.82 });
    const warning = new THREE.MeshStandardMaterial({ color: 0xe8a83f, emissive: 0x2b1002, roughness: 0.52, metalness: 0.2 });
    const body = mesh(new THREE.CylinderGeometry(0.48, 0.46, 1.14, 32, 1), red);
    body.position.y = 0.58;
    root.add(body);
    for (const y of [0.08, 0.3, 0.87, 1.08]) {
      const band = mesh(new THREE.TorusGeometry(0.475, 0.035, 8, 32), dark);
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      root.add(band);
    }
    const cap = mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.045, 32), dark);
    cap.position.y = 1.17;
    const hazard = mesh(new THREE.BoxGeometry(0.72, 0.24, 0.012), warning);
    hazard.position.set(0, 0.61, 0.468);
    root.add(cap, hazard);
    castAndReceive(root);
    return root;
  }

  addSetDressing(scene: THREE.Scene) {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x554d3c, roughness: 0.9, metalness: 0.06 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x252b2b, roughness: 0.45, metalness: 0.65 });
    const positions: Array<[number, number, number]> = [[-16, 9, 0.2], [15, -9.5, -0.35], [-13.5, -12.4, 0.12], [13.8, 11.2, 0.7]];
    for (const [x, z, rotation] of positions) {
      const root = new THREE.Group();
      for (let level = 0; level < 2; level += 1) {
        const box = mesh(new RoundedBoxGeometry(1.15, 0.78, 0.92, 3, 0.055), crateMat);
        box.position.set(level * 0.32, 0.4 + level * 0.78, 0);
        const edge = mesh(new RoundedBoxGeometry(1.2, 0.09, 0.97, 2, 0.02), edgeMat);
        edge.position.set(level * 0.32, 0.77 + level * 0.78, 0);
        root.add(box, edge);
      }
      root.position.set(x, 0, z);
      root.rotation.y = rotation;
      castAndReceive(root);
      scene.add(root);
    }

    const rubber = new THREE.MeshStandardMaterial({ color: 0x151819, roughness: 0.76 });
    for (const [x, z] of [[-17.4, -5.4], [16.3, 3.8]] as const) {
      for (let i = 0; i < 3; i += 1) {
        const tire = mesh(new THREE.TorusGeometry(0.48, 0.16, 12, 32), rubber);
        tire.rotation.x = Math.PI / 2;
        tire.position.set(x + i * 0.08, 0.16 + i * 0.22, z + i * 0.04);
        tire.rotation.z = i * 0.3;
        tire.castShadow = true;
        scene.add(tire);
      }
    }
    this.addDust(scene);
  }

  createPlayer(): CharacterRig {
    const rig = this.createEmptyRig(1);
    const ring = mesh(
      new THREE.RingGeometry(0.52, 0.66, 40),
      new THREE.MeshBasicMaterial({ color: 0xb8ff5a, transparent: true, opacity: 0.46, side: THREE.DoubleSide }),
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
    const scale = type === "juggernaut" ? 1.62 : type === "brute" ? 1.26 : type === "runner" ? 0.88 : 1;
    const rig = this.createEmptyRig(scale);
    if (type === "juggernaut") {
      const bossRing = mesh(new THREE.RingGeometry(1.34, 1.55, 56), new THREE.MeshBasicMaterial({ color: 0xff4a34, transparent: true, opacity: 0.62, side: THREE.DoubleSide }));
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

  animateCharacter(rig: CharacterRig, dt: number, speed: number, attacking: boolean, hit: number) {
    const requested: CharacterMotion = speed > 5.4 ? "run" : speed > 0.08 ? "walk" : "idle";
    const nextAction = rig.actions?.[requested] ?? rig.actions?.idle;
    if (nextAction && rig.activeMotion !== requested) {
      const previous = rig.activeMotion ? rig.actions?.[rig.activeMotion] : undefined;
      nextAction.reset().setEffectiveWeight(1).setEffectiveTimeScale(requested === "run" ? 1.08 : 1).fadeIn(0.16).play();
      previous?.fadeOut(0.16);
      rig.activeMotion = requested;
    }
    rig.mixer?.update(dt);
    if (rig.model) {
      const attackLean = attacking ? -0.14 : 0;
      rig.model.rotation.x = THREE.MathUtils.lerp(rig.model.rotation.x, attackLean, 1 - Math.exp(-dt * 16));
      rig.model.position.z = THREE.MathUtils.lerp(rig.model.position.z, attacking ? 0.1 : 0, 1 - Math.exp(-dt * 18));
    }
    if (rig.hitShell) rig.hitShell.visible = hit > 0;
  }

  disposeCharacter(rig: CharacterRig) {
    if (rig.disposed) return;
    rig.disposed = true;
    rig.mixer?.stopAllAction();
    if (rig.model) {
      rig.mixer?.uncacheRoot(rig.model);
      rig.model.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      });
      rig.model.removeFromParent();
    }
    rig.root.removeFromParent();
    disposeObjectResources(rig.root);
    rig.root.clear();
  }

  disposeObject(root: THREE.Object3D) {
    disposeObjectResources(root);
  }

  dispose(scene: THREE.Scene) {
    if (this.disposed) return;
    this.disposed = true;
    const resources = createDisposableResources();
    collectObjectResources(scene, resources, true);
    for (const template of this.characterTemplates.values()) collectObjectResources(template, resources, true);
    if (this.characterAssetData) collectObjectResources(this.characterAssetData.scene, resources, true);
    collectMaterial(this.groundMaterial, resources, true);
    resources.textures.add(this.bloodTexture);
    resources.textures.add(this.chainTexture);
    if (this.asphaltTexture) resources.textures.add(this.asphaltTexture);
    disposeResources(resources);
    this.characterTemplates.clear();
    this.bloodDecals = [];
    scene.clear();
  }

  addBloodDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    const material = new THREE.MeshStandardMaterial({
      map: this.bloodTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.82,
      roughness: 0.56,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const decal = mesh(new THREE.PlaneGeometry(2.4 * scale, 2.4 * scale), material);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    decal.position.copy(position).setY(0.044 + Math.random() * 0.004);
    scene.add(decal);
    this.bloodDecals.push(decal);
    if (this.bloodDecals.length > 26) {
      const old = this.bloodDecals.shift();
      if (old) {
        scene.remove(old);
        old.geometry.dispose();
        (old.material as THREE.Material).dispose();
      }
    }
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
      new THREE.CircleGeometry(0.54 * scale, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.z = 0.52;
    shadow.position.y = 0.025;
    root.add(shadow);

    const placeholder = mesh(
      new THREE.CapsuleGeometry(0.25 * scale, 0.85 * scale, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x303836, roughness: 0.9, transparent: true, opacity: 0.5 }),
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
      hitMaterials: [],
      phase: Math.random() * Math.PI * 2,
      scale,
      disposed: false,
    };
  }

  private async attachAnimatedCharacter(rig: CharacterRig, kind: "player" | EnemyId, definition?: EnemyDefinition) {
    const asset = await this.characterAsset;
    if (this.disposed || rig.disposed) return;
    const template = this.getCharacterTemplate(asset.scene, kind, definition);
    const model = cloneSkinnedModel(template);
    model.scale.setScalar(rig.scale * (kind === "player" ? 1.22 : 1.14));
    model.rotation.y = Math.PI;
    if (kind === "runner") model.scale.x *= 0.86;
    if (kind === "brute") model.scale.x *= 1.12;
    if (kind === "juggernaut") model.scale.x *= 1.18;
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.receiveShadow = true;
        object.frustumCulled = true;
      }
    });
    const placeholder = rig.root.getObjectByName("character-placeholder");
    if (placeholder) {
      placeholder.removeFromParent();
      disposeObjectResources(placeholder);
    }
    rig.root.add(model);
    rig.model = model;
    if (kind === "player") {
      const weapon = this.createPlayerWeaponRig();
      rig.root.add(weapon.group);
      rig.muzzle = weapon.muzzle;
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
      new THREE.CapsuleGeometry(0.36 * rig.scale, 0.95 * rig.scale, 5, 10),
      new THREE.MeshBasicMaterial({ color: 0xff3c24, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    hitShell.position.y = 0.82 * rig.scale;
    hitShell.visible = false;
    rig.root.add(hitShell);
    rig.hitShell = hitShell;
  }

  private getCharacterTemplate(source: THREE.Object3D, kind: "player" | EnemyId, definition?: EnemyDefinition) {
    const key = kind;
    const existing = this.characterTemplates.get(key);
    if (existing) return existing;
    const template = cloneSkinnedModel(source);
    const palette: Record<"player" | EnemyId, number> = {
      player: 0xffffff,
      shambler: 0x78906e,
      runner: 0x9a755d,
      spitter: 0x688c52,
      brute: 0x6f665f,
      juggernaut: 0x6d3a35,
    };
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (kind !== "player" && object.name.toLowerCase().includes("visor")) {
        object.visible = false;
        return;
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const replacements = materials.map((material) => {
        const next = material.clone();
        if (next instanceof THREE.MeshStandardMaterial) {
          next.color.multiply(new THREE.Color(palette[kind]));
          next.roughness = kind === "player" ? 0.58 : 0.9;
          next.metalness = kind === "player" ? 0.28 : 0.04;
          if (kind !== "player") {
            next.emissive.setHex(kind === "spitter" ? 0x102608 : 0x160302);
            next.emissiveIntensity = kind === "spitter" ? 0.5 : 0.2;
          }
        }
        return next;
      });
      object.material = Array.isArray(object.material) ? replacements : replacements[0];
    });
    if (kind !== "player") this.decorateZombie(template, kind, definition?.color ?? 0x5f6d62);
    this.characterTemplates.set(key, template);
    return template;
  }

  private decorateZombie(template: THREE.Object3D, kind: EnemyId, clothingColor: number) {
    const headBone = template.getObjectByName("mixamorig:Head");
    if (!headBone) return;
    const skin = new THREE.MeshStandardMaterial({
      color: kind === "spitter" ? 0x82a55e : kind === "juggernaut" ? 0x75655c : 0x849078,
      roughness: 0.94,
      emissive: kind === "spitter" ? 0x162b0b : 0x170201,
      emissiveIntensity: 0.35,
    });
    const gore = new THREE.MeshStandardMaterial({ color: 0x5f1612, roughness: 0.8 });
    const skull = mesh(new THREE.SphereGeometry(0.145, 20, 14), skin);
    skull.scale.set(kind === "runner" ? 0.84 : 1, 1.08, 0.92);
    skull.position.set(0, 0.115, 0.012);
    const jaw = mesh(new RoundedBoxGeometry(0.19, 0.09, 0.14, 3, 0.025), skin);
    jaw.position.set(0, 0.03, 0.055);
    jaw.rotation.x = kind === "runner" ? 0.34 : 0.15;
    const wound = mesh(new THREE.CircleGeometry(0.052, 16), gore);
    wound.position.set(-0.065, 0.15, 0.128);
    headBone.add(skull, jaw, wound);
    const eyeColor = kind === "spitter" ? 0xaaff4d : 0xff4a32;
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: eyeColor });
    for (const x of [-0.05, 0.05]) {
      const eye = mesh(new THREE.SphereGeometry(0.015, 9, 7), eyeMaterial);
      eye.position.set(x, 0.145, 0.132);
      headBone.add(eye);
    }
    if (kind === "spitter") {
      const sac = mesh(
        new THREE.SphereGeometry(0.105, 18, 12),
        new THREE.MeshStandardMaterial({ color: 0x9acf55, emissive: 0x54ff1f, emissiveIntensity: 1.7, roughness: 0.5 }),
      );
      sac.scale.set(1.25, 1, 0.78);
      sac.position.set(0, -0.01, 0.11);
      headBone.add(sac);
    }
    if (kind === "brute" || kind === "juggernaut") {
      const chestBone = template.getObjectByName("mixamorig:Spine2");
      if (chestBone) {
        const plateMaterial = new THREE.MeshStandardMaterial({ color: kind === "juggernaut" ? 0x5f2926 : clothingColor, roughness: 0.5, metalness: 0.52 });
        for (const x of [-0.22, 0.22]) {
          const plate = mesh(new RoundedBoxGeometry(0.34, 0.22, 0.12, 3, 0.035), plateMaterial);
          plate.position.set(x, 0.08, 0.16);
          plate.rotation.z = x * 0.5;
          chestBone.add(plate);
        }
      }
    }
    const spine = template.getObjectByName("mixamorig:Spine1");
    if (spine) {
      const ragMaterial = new THREE.MeshStandardMaterial({ color: clothingColor, roughness: 0.98, side: THREE.DoubleSide });
      const rag = mesh(new THREE.ConeGeometry(kind === "juggernaut" ? 0.42 : 0.3, 0.46, 9, 1, true), ragMaterial);
      rag.position.set(0, 0.08, 0);
      rag.rotation.x = Math.PI;
      spine.add(rag);
    }
  }

  private createPlayerWeaponRig() {
    const group = new THREE.Group();
    group.position.set(0.08, 1.2, 0.33);
    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x151b1d, roughness: 0.27, metalness: 0.88 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x485255, roughness: 0.34, metalness: 0.72 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xe46d35, emissive: 0x4a1607, emissiveIntensity: 0.65, roughness: 0.52 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x20282a, roughness: 0.94 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x344044, roughness: 0.9 });

    const receiver = mesh(new RoundedBoxGeometry(0.23, 0.18, 0.58, 4, 0.035), gunmetal);
    receiver.position.z = 0.08;
    const upper = mesh(new RoundedBoxGeometry(0.16, 0.1, 0.5, 3, 0.025), steel);
    upper.position.set(0, 0.12, 0.13);
    const stock = mesh(new RoundedBoxGeometry(0.25, 0.2, 0.38, 4, 0.04), steel);
    stock.position.set(0, -0.015, -0.36);
    const barrel = mesh(new THREE.CylinderGeometry(0.033, 0.045, 0.62, 14), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.65;
    const suppressor = mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.28, 16), gunmetal);
    suppressor.rotation.x = Math.PI / 2;
    suppressor.position.z = 0.98;
    const grip = mesh(new RoundedBoxGeometry(0.12, 0.28, 0.13, 3, 0.025), gunmetal);
    grip.position.set(0, -0.2, 0.03);
    grip.rotation.x = -0.22;
    const foregrip = mesh(new RoundedBoxGeometry(0.1, 0.2, 0.11, 3, 0.02), accent);
    foregrip.position.set(0, -0.14, 0.43);
    foregrip.rotation.x = 0.18;
    const sight = mesh(new RoundedBoxGeometry(0.1, 0.11, 0.22, 3, 0.022), accent);
    sight.position.set(0, 0.21, 0.13);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 1.14);
    group.add(receiver, upper, stock, barrel, suppressor, grip, foregrip, sight, muzzle);

    const addArm = (elbow: THREE.Vector3, handPosition: THREE.Vector3) => {
      const direction = handPosition.clone().sub(elbow);
      const length = direction.length();
      const arm = mesh(new THREE.CapsuleGeometry(0.09, Math.max(0.08, length - 0.18), 7, 12), sleeve);
      arm.position.copy(elbow).lerp(handPosition, 0.5).sub(group.position);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      const hand = mesh(new THREE.SphereGeometry(0.115, 14, 10), glove);
      hand.position.copy(handPosition).sub(group.position);
      group.add(arm, hand);
    };
    addArm(new THREE.Vector3(0.44, 1.4, 0.03), new THREE.Vector3(0.09, 1.06, 0.34));
    addArm(new THREE.Vector3(-0.42, 1.39, 0.08), new THREE.Vector3(0.01, 1.09, 0.72));
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = false;
    });
    return { group, muzzle };
  }

  private addDrain(root: THREE.Group, x: number, z: number, rotation: number) {
    const drainMaterial = new THREE.MeshStandardMaterial({ color: 0x202426, roughness: 0.42, metalness: 0.8 });
    const drain = new THREE.Group();
    const frame = mesh(new RoundedBoxGeometry(2.3, 0.045, 0.8, 2, 0.03), drainMaterial);
    drain.add(frame);
    for (let index = -5; index <= 5; index += 1) {
      const slit = mesh(new THREE.BoxGeometry(0.08, 0.018, 0.63), new THREE.MeshBasicMaterial({ color: 0x050807 }));
      slit.position.set(index * 0.19, 0.03, 0);
      drain.add(slit);
    }
    drain.position.set(x, 0.026, z);
    drain.rotation.y = rotation;
    root.add(drain);
  }

  private addDust(scene: THREE.Scene) {
    const count = 180;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = THREE.MathUtils.randFloatSpread(39);
      positions[i * 3 + 1] = THREE.MathUtils.randFloat(0.05, 2.8);
      positions[i * 3 + 2] = THREE.MathUtils.randFloatSpread(39);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xb8c2a3, size: 0.035, transparent: true, opacity: 0.28, depthWrite: false }));
    points.name = "ambient-dust";
    scene.add(points);
  }

  private createBloodTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, 512, 512);
      const gradient = context.createRadialGradient(256, 256, 22, 256, 256, 185);
      gradient.addColorStop(0, "rgba(105, 5, 7, .92)");
      gradient.addColorStop(0.5, "rgba(69, 3, 5, .78)");
      gradient.addColorStop(1, "rgba(40, 0, 2, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      for (let i = 0; i < 32; i += 1) {
        const angle = i / 32 * Math.PI * 2;
        const radius = 115 + Math.sin(i * 4.7) * 35 + (i % 3) * 10;
        const x = 256 + Math.cos(angle) * radius;
        const y = 256 + Math.sin(angle) * radius;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
      context.fillStyle = "rgba(62, 1, 3, .72)";
      for (let i = 0; i < 26; i += 1) {
        const angle = i * 2.41;
        const distance = 135 + (i % 7) * 17;
        const radius = 3 + (i % 5) * 2.4;
        context.beginPath();
        context.arc(256 + Math.cos(angle) * distance, 256 + Math.sin(angle) * distance, radius, 0, Math.PI * 2);
        context.fill();
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
      context.strokeStyle = "rgba(220, 230, 225, .9)";
      context.lineWidth = 3;
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
    texture.repeat.set(13, 1.3);
    return texture;
  }
}
