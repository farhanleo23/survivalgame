import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { COMIC, ComicPalette, inkInPlace } from "./comic";
import type { EnemyId, WeaponId } from "./types";

/**
 * Skinned character models, cel-shaded and dressed per archetype.
 *
 * Five infected meshes cover six enemy types: scale, girth, tint and bolted-on
 * signature props (pustules, armour, horns, a reactor core) do the rest, so
 * nothing reads as a plain recolour of its neighbour. The operator uses the
 * Vanguard model, the highest-fidelity asset in the project.
 *
 * Each source model was authored with its own armature naming convention, so
 * clips are resolved through a normalised motion table rather than by name.
 */

export type CharacterKind = "player" | EnemyId;
export type CharacterMotion = "idle" | "walk" | "run" | "attack";

export interface CharacterRig {
  root: THREE.Group;
  /** Leans and recoils as a whole; GameEngine tilts this during dashes. */
  body: THREE.Group;
  /** Set once the async model load resolves. */
  model?: THREE.Object3D;
  muzzle: THREE.Object3D;

  weaponGroup?: THREE.Group;
  weaponModels?: Map<WeaponId, { group: THREE.Group; muzzle: THREE.Object3D }>;
  currentWeaponId?: WeaponId;
  recoilZ: number;
  recoilPitch: number;

  mixer?: THREE.AnimationMixer;
  actions: Partial<Record<CharacterMotion, THREE.AnimationAction>>;
  activeMotion?: CharacterMotion;

  /** Upper-body bones re-posed onto the weapon grip after each mixer update. */
  aimBones?: {
    rightArm: THREE.Object3D;
    rightForeArm: THREE.Object3D;
    rightHand: THREE.Object3D;
    leftArm: THREE.Object3D;
    leftForeArm: THREE.Object3D;
    leftHand: THREE.Object3D;
    /** Bind-pose hand rotations, so the hands stay in line with the forearms. */
    rightHandRest: THREE.Quaternion;
    leftHandRest: THREE.Quaternion;
  };

  /** Cloned per rig so a hit flash never bleeds across characters. */
  tintMaterials: THREE.MeshToonMaterial[];
  /** Untinted colour per material, so a status tint can be undone exactly. */
  baseColors: number[];
  /** Resting emissive, restored after a hit flash. Zero for most rigs. */
  baseGlow: { color: number; intensity: number };
  /**
   * Every material created for this rig alone, released when it dies. The
   * shared ones (contact shadow, ink shell) are deliberately not in here.
   */
  ownedMaterials: THREE.Material[];
  glowSac?: THREE.Mesh;
  bossCore?: THREE.Mesh;
  /** Small billboarded marker shown while a status is active. */
  statusPip?: THREE.Mesh;

  kind: CharacterKind;
  spec: ArchetypeSpec;
  phase: number;
  attackBlend: number;
  hitBlend: number;
  /** Currently applied status colour, or null. Avoids per-frame re-tinting. */
  activeStatus?: number | null;
  scale: number;
  disposed: boolean;
}

interface ArchetypeSpec {
  /** Model height in world units after normalisation. */
  height: number;
  /** Non-uniform girth applied on X/Z only. Above 1 reads as bulk. */
  girth: number;
  asset: string;
  /** Archetype hue multiplied over the baked texture. */
  tint?: number;
  /** 0 = texture untouched, 1 = tint dominates. Defaults to a subtle 0.5. */
  tintStrength?: number;
  /**
   * Constant emissive lift under the texture. A multiply tint can only darken
   * a map; this is what keeps the shadowed side of the operator blue instead
   * of black-green, so the hue survives the toon ramp's shadow band.
   */
  glow?: number;
  glowIntensity?: number;
  /** Multiplier on clip playback rate; sells speed without new clips. */
  gaitRate: number;
  /**
   * Yaw correction in radians when the source model's forward axis is not
   * +Z. The engine rotates characters with `atan2(aim.x, aim.z)`, so a model
   * authored facing -Z aims exactly backwards without this.
   */
  yawOffset?: number;
}

const ARCHETYPES: Record<CharacterKind, ArchetypeSpec> = {
  // Tinted operator blue so the player is findable in a pile of infected —
  // but not so hard that the texture is dropped. At full strength the map
  // went away entirely and the operator rendered as a featureless cyan
  // mannequin: no face, no straps, no pouches, just a silhouette. Two thirds
  // keeps the hue shift and lets the sculpted detail show through it.
  player: {
    height: 1.95,
    girth: 1,
    asset: "/models/soldier.glb",
    yawOffset: Math.PI,
    tint: COMIC.operator,
    tintStrength: 0.8,
    glow: COMIC.operatorDeep,
    glowIntensity: 0.32,
    gaitRate: 1,
  },
  shambler: { height: 1.85, girth: 1, asset: "/models/zombie-shambler.glb", gaitRate: 0.85 },
  // Authored with arms raised, so its bind-pose box is taller than the figure
  // and normalisation undershoots. The height here is compensated, not literal.
  runner: { height: 2.55, girth: 0.9, asset: "/models/zombie-runner.glb", gaitRate: 1.5 },
  spitter: { height: 1.8, girth: 1, asset: "/models/zombie-spitter.glb", tint: COMIC.spitter, gaitRate: 0.8 },
  boomer: { height: 1.75, girth: 1.55, asset: "/models/zombie-boomer.glb", tint: COMIC.boomer, gaitRate: 0.8 },
  brute: { height: 2.55, girth: 1.6, asset: "/models/zombie-shambler.glb", tint: COMIC.brute, gaitRate: 0.7 },
  juggernaut: {
    height: 4.0,
    girth: 1.5,
    asset: "/models/zombie-heavy.glb",
    tint: COMIC.juggernaut,
    tintStrength: 0.88,
    gaitRate: 0.6,
  },
};

/**
 * Clip names differ per source model — `Armature|Walk`, `CharacterArmature|Run`,
 * `EnemyArmature|EnemyArmature|EnemyArmature|Attack`, `Zombie|ZombieWalk`. Match
 * on the trailing segment instead of the full name.
 */
const MOTION_PATTERNS: Record<CharacterMotion, RegExp[]> = {
  idle: [/^idle$/i, /idle$/i],
  walk: [/^walk2?$/i, /walk$/i],
  run: [/^run(_arms)?$/i, /run$/i, /running/i],
  attack: [/^attack$/i, /attack$/i, /bite$/i, /punch$/i, /headbutt$/i, /scream$/i],
};

function resolveClip(clips: THREE.AnimationClip[], motion: CharacterMotion): THREE.AnimationClip | undefined {
  for (const pattern of MOTION_PATTERNS[motion]) {
    const hit = clips.find((clip) => {
      const leaf = clip.name.split("|").pop() ?? clip.name;
      return pattern.test(leaf);
    });
    if (hit) return hit;
  }
  return undefined;
}

interface LoadedAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/** Bone names survive export in several forms — `mixamorig:RightArm`,
 *  `mixamorigRightArm`, or bare `RightArm`. Try each, then fall back to a
 *  suffix scan so a renamed rig still resolves. */
function findBone(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const direct =
    root.getObjectByName(`mixamorig:${name}`) ??
    root.getObjectByName(`mixamorig${name}`) ??
    root.getObjectByName(name);
  if (direct) return direct;

  let found: THREE.Object3D | undefined;
  const needle = name.toLowerCase();
  root.traverse((child) => {
    if (!found && child.name.toLowerCase().endsWith(needle)) found = child;
  });
  return found;
}

/**
 * The two-handed grip, as fractions of the operator's height in body space:
 * +Z is forward, +X is the operator's left, +Y up.
 *
 * The arms used to be pinned to four hand-tuned quaternions that were meant
 * to "meet the weapon" but never did: the forearms crossed over the chest
 * like folded arms while the gun sat on a fixed mount off to one side. The
 * pose is now solved from where the hands need to be — the weapon's grip —
 * so the two always agree, on every frame and in every animation state.
 *
 * Both targets sit at roughly 92% of the arm's reach, which is the braced
 * isosceles stance: elbows a touch bent, weapon out in front at chest height.
 */
const AIM_GRIP = {
  /** Rear of the weapon body; the hands wrap this point. */
  weapon: new THREE.Vector3(-0.015, 0.63, 0.145),
  rightHand: new THREE.Vector3(-0.041, 0.62, 0.159),
  leftHand: new THREE.Vector3(0.01, 0.61, 0.19),
  /** Which way each elbow bends, so the solve never locks an arm backwards. */
  rightPole: new THREE.Vector3(-1, -0.6, -0.2),
  leftPole: new THREE.Vector3(1, -0.6, -0.2),
};

/** Scratch space for the arm solve so the per-frame path allocates nothing. */
const IK = {
  shoulder: new THREE.Vector3(),
  elbow: new THREE.Vector3(),
  wrist: new THREE.Vector3(),
  target: new THREE.Vector3(),
  pole: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  dir: new THREE.Vector3(),
  perp: new THREE.Vector3(),
  bend: new THREE.Vector3(),
  childDir: new THREE.Vector3(),
  desired: new THREE.Vector3(),
  parentQuat: new THREE.Quaternion(),
  bodyQuat: new THREE.Quaternion(),
};

/**
 * Rotate `bone` so that the axis running to `child` points at `worldTarget`.
 *
 * A bone's own frame is arbitrary per rig, but the direction to its child in
 * that frame is fixed, so aiming that direction is the one operation that
 * works without knowing how the rig was authored. Minimal rotation, so the
 * twist about the bone is whatever falls out; for arms that is acceptable.
 */
function aimBoneAt(bone: THREE.Object3D, child: THREE.Object3D, worldTarget: THREE.Vector3) {
  const parent = bone.parent;
  if (!parent) return;
  IK.childDir.copy(child.position).normalize();
  bone.getWorldPosition(IK.desired);
  IK.desired.subVectors(worldTarget, IK.desired);
  if (IK.desired.lengthSq() < 1e-8) return;
  parent.getWorldQuaternion(IK.parentQuat);
  IK.desired.applyQuaternion(IK.parentQuat.invert()).normalize();
  bone.quaternion.setFromUnitVectors(IK.childDir, IK.desired);
}

/**
 * Analytic two-bone solve: put the wrist on `target` with the elbow bent
 * toward `pole`. Both are world-space. Reach is clamped just short of a
 * straight arm so the elbow never snaps through.
 */
function solveArm(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
) {
  upper.getWorldPosition(IK.shoulder);
  lower.getWorldPosition(IK.elbow);
  end.getWorldPosition(IK.wrist);
  const upperLength = IK.shoulder.distanceTo(IK.elbow);
  const lowerLength = IK.elbow.distanceTo(IK.wrist);
  if (upperLength < 1e-5 || lowerLength < 1e-5) return;

  IK.toTarget.subVectors(target, IK.shoulder);
  const reach = (upperLength + lowerLength) * 0.985;
  let distance = IK.toTarget.length();
  if (distance < 1e-5) return;
  if (distance > reach) {
    IK.toTarget.multiplyScalar(reach / distance);
    distance = reach;
  }
  IK.dir.copy(IK.toTarget).normalize();

  // Law of cosines gives the shoulder angle; the elbow lies that far off the
  // shoulder–target line, in the plane that contains the pole.
  const cosShoulder = THREE.MathUtils.clamp(
    (upperLength * upperLength + distance * distance - lowerLength * lowerLength) /
      (2 * upperLength * distance),
    -1,
    1,
  );
  const shoulderAngle = Math.acos(cosShoulder);
  IK.perp.copy(pole).addScaledVector(IK.dir, -pole.dot(IK.dir));
  if (IK.perp.lengthSq() < 1e-6) IK.perp.set(0, -1, 0).addScaledVector(IK.dir, IK.dir.y);
  IK.perp.normalize();
  IK.bend
    .copy(IK.shoulder)
    .addScaledVector(IK.dir, Math.cos(shoulderAngle) * upperLength)
    .addScaledVector(IK.perp, Math.sin(shoulderAngle) * upperLength);

  aimBoneAt(upper, lower, IK.bend);
  upper.updateMatrixWorld(true);
  IK.target.copy(IK.shoulder).add(IK.toTarget);
  aimBoneAt(lower, end, IK.target);
  lower.updateMatrixWorld(true);
}

/**
 * Measure a character's real world-space extent.
 *
 * `Box3.setFromObject` is wrong for skinned meshes: it transforms the raw
 * bind-pose geometry bounds by the node matrix and ignores the skeleton
 * entirely. Across these source models that produced heights from 0.004 to 44
 * units, so normalisation collapsed most of them to nothing. `SkinnedMesh
 * .computeBoundingBox()` applies the bone transforms and gives the true extent.
 */
/** Reused for status tinting so the hot path allocates nothing. */
const SCRATCH_COLOR = new THREE.Color();

function measureCharacter(model: THREE.Object3D): THREE.Box3 {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  let measured = false;

  model.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) {
      child.computeBoundingBox();
      if (!child.boundingBox) return;
      scratch.copy(child.boundingBox).applyMatrix4(child.matrixWorld);
      box.union(scratch);
      measured = true;
    } else if (child instanceof THREE.Mesh) {
      child.geometry.computeBoundingBox();
      if (!child.geometry.boundingBox) return;
      scratch.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
      box.union(scratch);
      measured = true;
    }
  });

  if (!measured) box.setFromObject(model);
  return box;
}

export class CharacterFactory {
  private loader = new GLTFLoader();
  private assets = new Map<string, Promise<LoadedAsset>>();
  private shadowGeometry = new THREE.CircleGeometry(1, 20);
  private shadowMaterial: THREE.MeshBasicMaterial;
  /** Shared backing for every status pip; unlike the coloured face, it never changes. */
  private statusPipInkMaterial: THREE.MeshBasicMaterial;
  private ownedGeometries: THREE.BufferGeometry[] = [];
  /**
   * Signature-part geometry, keyed by archetype and part. Sizes derive from
   * the archetype's fixed height, so one copy serves every spawn; building a
   * fresh sphere per spitter and two fresh planes per zombie leaked GPU
   * buffers for the life of the engine.
   */
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private disposed = false;

  constructor(private palette: ComicPalette) {
    this.shadowMaterial = palette.flat(COMIC.ink, { transparent: true, opacity: 0.34 });
    this.statusPipInkMaterial = palette.flat(COMIC.ink);
  }

  /** Warm the cache so the first wave does not pop in mid-fight. */
  preload(): Promise<unknown> {
    const paths = new Set(Object.values(ARCHETYPES).map((spec) => spec.asset));
    return Promise.all([...paths].map((path) => this.load(path).catch(() => undefined)));
  }

  private load(path: string): Promise<LoadedAsset> {
    const cached = this.assets.get(path);
    if (cached) return cached;
    const promise = this.loader
      .loadAsync(path)
      .then((gltf) => ({ scene: gltf.scene, animations: gltf.animations }));
    this.assets.set(path, promise);
    return promise;
  }

  createCharacter(kind: CharacterKind, colorOverride?: number): CharacterRig {
    const spec = ARCHETYPES[kind];

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    // Drawn contact shadow rather than a cast one: it stays readable under a
    // pile of overlapping enemies, where real shadows turn to mush.
    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.scale.setScalar(spec.height * 0.3 * spec.girth);
    shadow.renderOrder = -2;
    root.add(shadow);

    // Placeholder muzzle until the model loads and the weapon claims it.
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, spec.height * 0.7, spec.height * 0.35);
    root.add(muzzle);

    const rig: CharacterRig = {
      root,
      body,
      muzzle,
      recoilZ: 0,
      recoilPitch: 0,
      actions: {},
      tintMaterials: [],
      baseColors: [],
      baseGlow: { color: spec.glow ?? 0x000000, intensity: spec.glow === undefined ? 1 : spec.glowIntensity ?? 0.3 },
      ownedMaterials: [],
      kind,
      spec,
      phase: Math.random() * Math.PI * 2,
      attackBlend: 0,
      hitBlend: 0,
      scale: spec.height / 1.85,
      disposed: false,
    };

    void this.attachModel(rig, kind, spec, colorOverride).catch((error) => {
      console.warn(`character model failed to load for ${kind}`, error);
    });

    return rig;
  }

  private async attachModel(
    rig: CharacterRig,
    kind: CharacterKind,
    spec: ArchetypeSpec,
    colorOverride?: number,
  ) {
    const asset = await this.load(spec.asset);
    if (this.disposed || rig.disposed) return;

    const model = cloneSkinned(asset.scene);

    // Source models arrive at wildly different scales and origins; normalise to
    // a known height, then drop the feet onto y=0 and centre on the origin.
    const bounds = measureCharacter(model);
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const uniform = spec.height / Math.max(0.0001, size.y);
    model.scale.set(uniform * spec.girth, uniform, uniform * spec.girth);
    model.rotation.y = spec.yawOffset ?? 0;

    const scaled = measureCharacter(model);
    model.position.y = -scaled.min.y;
    model.position.x = -(scaled.min.x + scaled.max.x) / 2;
    model.position.z = -(scaled.min.z + scaled.max.z) / 2;

    this.applyComicMaterials(rig, model, colorOverride ?? spec.tint, spec.tintStrength);

    rig.body.add(model);
    rig.model = model;

    if (asset.animations.length) {
      const mixer = new THREE.AnimationMixer(model);
      rig.mixer = mixer;
      for (const motion of ["idle", "walk", "run", "attack"] as CharacterMotion[]) {
        const clip = resolveClip(asset.animations, motion);
        if (clip) rig.actions[motion] = mixer.clipAction(clip);
      }
      // Walk stands in for run when a model lacks one, and vice versa.
      rig.actions.run ??= rig.actions.walk;
      rig.actions.walk ??= rig.actions.run;
      rig.actions.idle ??= rig.actions.walk;
    }

    this.addSignatureParts(kind, rig, spec);
    if (kind === "player") this.attachWeapons(rig, model, spec);
  }

  /**
   * Swap every surface to a cel material, always keeping the model's own
   * texture — the baked detail is most of what stops these reading as toys.
   *
   * Archetype tints are lightened toward white before being multiplied over the
   * map. A full-strength tint either crushes the texture to a flat silhouette
   * or turns it muddy; pulled halfway to white it shifts hue while the sculpted
   * detail still shows through.
   */
  private applyComicMaterials(rig: CharacterRig, model: THREE.Object3D, tint?: number, strength = 0.5) {
    const wash =
      tint === undefined
        ? undefined
        : new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 1 - strength);

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = false;

      const source = child.material as THREE.MeshStandardMaterial | undefined;
      const material = this.claim(rig, this.palette.toon(0xffffff));

      // A tint multiplies against the map, so it can only ever darken. At full
      // strength drop the map instead: the operator has to be findable in a
      // pile of infected, and the Vanguard's sculpted armour still reads
      // through flat colour at this camera distance.
      if (source?.map && strength < 0.95) {
        material.map = source.map;
        if (wash) material.color.copy(wash);
      } else if (wash) {
        material.color.copy(wash);
      } else if (source?.color) {
        material.color.copy(source.color);
      }

      material.emissive.setHex(rig.baseGlow.color);
      material.emissiveIntensity = rig.baseGlow.intensity;

      child.material = material;
      rig.tintMaterials.push(material);
      rig.baseColors.push(material.color.getHex());
    });
  }

  /** Per-archetype identifiers, sized against the model's real height. */
  private addSignatureParts(kind: CharacterKind, rig: CharacterRig, spec: ArchetypeSpec) {
    const h = spec.height;
    const ink = this.palette.outlineMaterial();

    if (kind === "spitter") {
      const sac = new THREE.Mesh(
        this.cachedGeometry(`${kind}:sac`, () => new THREE.SphereGeometry(h * 0.16, 12, 9)),
        this.claim(rig, this.palette.toon(COMIC.acid, { emissive: COMIC.acid, emissiveIntensity: 1.4 })),
      );
      sac.position.set(0, h * 0.72, h * 0.15);
      inkInPlace(sac, ink, 0.06);
      rig.body.add(sac);
      rig.glowSac = sac;
    }

    if (kind === "boomer") {
      const pustuleGeo = this.cachedGeometry(`${kind}:pustule`, () => new THREE.SphereGeometry(h * 0.075, 8, 6));
      const pustuleMat = this.claim(rig, this.palette.toon(COMIC.acid, { emissive: COMIC.acid, emissiveIntensity: 1.2 }));
      let last: THREE.Mesh | undefined;
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2;
        const pustule = new THREE.Mesh(pustuleGeo, pustuleMat);
        pustule.position.set(
          Math.cos(angle) * h * 0.24,
          h * (0.4 + Math.sin(angle * 2) * 0.12),
          Math.sin(angle) * h * 0.2,
        );
        rig.body.add(pustule);
        last = pustule;
      }
      rig.glowSac = last;
    }

    if (kind === "brute") {
      // Asymmetric shoulder slab — reads as "flank it".
      const slab = new THREE.Mesh(
        this.cachedGeometry(`${kind}:slab`, () => new RoundedBoxGeometry(h * 0.34, h * 0.26, h * 0.2, 2, 0.02 * h)),
        this.claim(rig, this.palette.toon(0x503586)),
      );
      slab.position.set(-h * 0.19, h * 0.72, 0);
      inkInPlace(slab, ink, 0.05);
      rig.body.add(slab);
    }

    if (kind === "juggernaut") {
      const core = new THREE.Mesh(
        this.cachedGeometry(`${kind}:core`, () => new THREE.SphereGeometry(h * 0.085, 12, 10)),
        this.claim(rig, this.palette.toon(COMIC.gold, { emissive: COMIC.fire, emissiveIntensity: 2.2 })),
      );
      core.position.set(0, h * 0.52, h * 0.3);
      rig.body.add(core);
      rig.bossCore = core;

      const hornGeo = this.cachedGeometry(`${kind}:horn`, () => new THREE.ConeGeometry(h * 0.045, h * 0.2, 7));
      const trim = this.claim(rig, this.palette.toon(0x8c1226));
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(hornGeo, trim);
        horn.position.set(side * h * 0.17, h * 0.86, h * 0.12);
        horn.rotation.z = side * -0.55;
        inkInPlace(horn, ink, 0.06);
        rig.body.add(horn);
      }

    }

    // Status marker. This used to be a translucent sphere wrapped around the
    // whole body, which read as a bubble sitting on the character rather than a
    // state the character was in — and two of them overlapping in a crowd was
    // unreadable. A tinted body plus one small diamond says the same thing
    // without covering the silhouette.
    const pip = new THREE.Mesh(
      this.cachedGeometry(`${kind}:pip`, () => new THREE.PlaneGeometry(h * 0.22, h * 0.22)),
      // Per rig: its colour is rewritten as the status changes.
      this.claim(rig, this.palette.flat(COMIC.frost)),
    );
    pip.position.y = h * 1.08;
    pip.rotation.z = Math.PI / 4;
    pip.visible = false;
    pip.raycast = () => {};
    // Ink backing: a bare diamond washes out against the bright floor.
    const pipInk = new THREE.Mesh(
      this.cachedGeometry(`${kind}:pip-ink`, () => new THREE.PlaneGeometry(h * 0.3, h * 0.3)),
      this.statusPipInkMaterial,
    );
    pipInk.position.z = -0.01;
    pip.add(pipInk);
    rig.body.add(pip);
    rig.statusPip = pip;
  }

  /**
   * Comic weapon silhouettes parented to the operator's right hand so they
   * follow the skinned animation instead of floating at a fixed offset.
   */
  private attachWeapons(rig: CharacterRig, model: THREE.Object3D, spec: ArchetypeSpec) {
    const ink = this.palette.outlineMaterial();
    // Mid-tone rather than near-black: under the toon ramp and a thick ink
    // shell the old gunmetal collapsed into one black brick with no edges.
    const gunmetal = this.palette.toon(0x55627d);
    const steel = this.palette.toon(COMIC.steel);
    const glow = this.palette.toon(COMIC.gold, { emissive: COMIC.gold, emissiveIntensity: 1.6 });

    // The weapon rides the body, NOT the right hand bone.
    //
    // Parented to the hand it would inherit whatever the animation does to the
    // arm, so the barrel would sweep and tracers would leave from wherever the
    // hand happened to be. Mounted on the body it always points down +Z, which
    // is exactly the direction the engine rotates toward the cursor, so muzzle
    // and aim agree on every frame. The arms are then solved onto its grip.
    const weaponGroup = new THREE.Group();
    weaponGroup.position.copy(AIM_GRIP.weapon).multiplyScalar(spec.height);
    weaponGroup.scale.setScalar(spec.height * 0.42);
    rig.body.add(weaponGroup);
    rig.weaponGroup = weaponGroup;

    const rightArm = findBone(model, "RightArm");
    const rightForeArm = findBone(model, "RightForeArm");
    const rightHand = findBone(model, "RightHand");
    const leftArm = findBone(model, "LeftArm");
    const leftForeArm = findBone(model, "LeftForeArm");
    const leftHand = findBone(model, "LeftHand");
    if (rightArm && rightForeArm && rightHand && leftArm && leftForeArm && leftHand) {
      // Captured before the mixer ever runs, so these are the bind pose.
      rig.aimBones = {
        rightArm,
        rightForeArm,
        rightHand,
        leftArm,
        leftForeArm,
        leftHand,
        rightHandRest: rightHand.quaternion.clone(),
        leftHandRest: leftHand.quaternion.clone(),
      };
    }

    const models = new Map<WeaponId, { group: THREE.Group; muzzle: THREE.Object3D }>();

    const build = (
      id: WeaponId,
      bodyLength: number,
      bodyHeight: number,
      barrelLength: number,
      barrelRadius: number,
      magDepth: number,
    ) => {
      const group = new THREE.Group();

      // Slim in X: the receiver was as wide as it was tall, which read as a
      // box rather than a firearm from every angle the game uses.
      const gun = new THREE.Mesh(
        this.own(new RoundedBoxGeometry(0.09, bodyHeight, bodyLength, 2, 0.02)),
        gunmetal,
      );
      gun.position.z = bodyLength / 2;
      inkInPlace(gun, ink, 0.05);
      group.add(gun);

      const barrel = new THREE.Mesh(
        this.own(new THREE.CylinderGeometry(barrelRadius, barrelRadius, barrelLength, 8)),
        steel,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, bodyHeight * 0.16, bodyLength + barrelLength * 0.5);
      inkInPlace(barrel, ink, 0.08);
      group.add(barrel);

      // Grip under the rear of the receiver, where the right hand lands.
      const grip = new THREE.Mesh(
        this.own(new RoundedBoxGeometry(0.07, bodyHeight * 0.9, 0.09, 2, 0.015)),
        gunmetal,
      );
      grip.position.set(0, -bodyHeight * 0.75, bodyLength * 0.18);
      grip.rotation.x = -0.28;
      inkInPlace(grip, ink, 0.06);
      group.add(grip);

      if (magDepth > 0) {
        const mag = new THREE.Mesh(
          this.own(new RoundedBoxGeometry(0.06, magDepth, 0.11, 2, 0.015)),
          gunmetal,
        );
        mag.position.set(0, -magDepth / 2 - bodyHeight * 0.3, bodyLength * 0.5);
        inkInPlace(mag, ink, 0.07);
        group.add(mag);
      }

      const sight = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.05, 0.05, 0.05)), glow);
      sight.position.set(0, bodyHeight * 0.7, bodyLength * 0.8);
      group.add(sight);

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, bodyHeight * 0.16, bodyLength + barrelLength + 0.08);
      group.add(muzzle);

      group.visible = false;
      weaponGroup.add(group);
      models.set(id, { group, muzzle });
    };

    build("pistol", 0.3, 0.17, 0.16, 0.032, 0);
    build("smg", 0.44, 0.2, 0.22, 0.038, 0.3);
    build("shotgun", 0.5, 0.22, 0.34, 0.055, 0);
    build("rifle", 0.56, 0.19, 0.42, 0.042, 0.26);

    rig.weaponModels = models;
    // Honour a weapon selected before the model finished loading.
    const active = models.get(rig.currentWeaponId ?? "pistol");
    if (active) {
      active.group.visible = true;
      rig.currentWeaponId ??= "pistol";
      rig.muzzle = active.muzzle;
    }
  }

  setWeapon(rig: CharacterRig, weaponId: WeaponId) {
    rig.currentWeaponId = weaponId;
    if (!rig.weaponModels) return;
    for (const [id, model] of rig.weaponModels) {
      const active = id === weaponId;
      model.group.visible = active;
      if (active) rig.muzzle = model.muzzle;
    }
  }

  /**
   * Drives the skinned clips. Motion comes from speed, attacks crossfade over
   * the top, and playback rate scales with speed so a shambler and a sprinting
   * runner never share a cadence.
   */
  animate(
    rig: CharacterRig,
    dt: number,
    speed: number,
    attacking: boolean,
    hit: number,
    isChilled = false,
    isBurning = false,
  ) {
    rig.phase += dt * 2.4;
    rig.attackBlend += ((attacking ? 1 : 0) - rig.attackBlend) * (1 - Math.exp(-dt * 14));
    rig.hitBlend += ((hit > 0 ? 1 : 0) - rig.hitBlend) * (1 - Math.exp(-dt * 22));

    if (rig.mixer) {
      const desired: CharacterMotion =
        attacking && rig.actions.attack
          ? "attack"
          : speed > 3.2
            ? "run"
            : speed > 0.08
              ? "walk"
              : "idle";

      const next = rig.actions[desired] ?? rig.actions.idle;
      if (next && rig.activeMotion !== desired) {
        const previous = rig.activeMotion ? rig.actions[rig.activeMotion] : undefined;
        next.reset().setEffectiveWeight(1).fadeIn(0.16).play();
        if (previous && previous !== next) previous.fadeOut(0.16);
        rig.activeMotion = desired;
      }

      if (next && (desired === "walk" || desired === "run")) {
        // Chilled enemies animate slower, selling the slow without a HUD cue.
        const chill = isChilled ? 0.45 : 1;
        next.setEffectiveTimeScale(
          THREE.MathUtils.clamp(speed / (desired === "run" ? 4.2 : 2.0), 0.35, 2.2) *
            rig.spec.gaitRate *
            chill,
        );
      }

      rig.mixer.update(dt);

      // Solve the arms *after* the mixer, or the locomotion clip wins and the
      // arms swing the weapon off target mid-burst. Legs keep walking, upper
      // body stays on the grip: the twin-stick split.
      if (rig.aimBones && rig.model) this.poseArmsOnGrip(rig);
    }

    // Hit flash drives the tint materials white, then decays back to the
    // rig's resting glow (black for the infected, deep blue for the operator).
    if (rig.hitBlend > 0.01) {
      for (const material of rig.tintMaterials) {
        material.emissive.setRGB(rig.hitBlend, rig.hitBlend, rig.hitBlend);
        material.emissiveIntensity = rig.hitBlend * 1.5;
      }
    } else if (rig.hitBlend > 0) {
      for (const material of rig.tintMaterials) {
        material.emissive.setHex(rig.baseGlow.color);
        material.emissiveIntensity = rig.baseGlow.intensity;
      }
    }

    // Burning outranks chilled when both somehow apply.
    const statusColor = isBurning ? COMIC.fire : isChilled ? COMIC.frost : null;
    if (statusColor !== rig.activeStatus) {
      rig.activeStatus = statusColor;
      for (let i = 0; i < rig.tintMaterials.length; i += 1) {
        const material = rig.tintMaterials[i];
        material.color.setHex(rig.baseColors[i] ?? 0xffffff);
        // Partial lerp, not a replacement: the archetype's own colour has to
        // survive so a burning brute still reads as a brute.
        if (statusColor !== null) material.color.lerp(SCRATCH_COLOR.setHex(statusColor), 0.68);
      }
      if (rig.statusPip) {
        rig.statusPip.visible = statusColor !== null;
        if (statusColor !== null) {
          (rig.statusPip.material as THREE.MeshBasicMaterial).color.setHex(statusColor);
        }
      }
    }
    if (rig.statusPip?.visible) {
      // Billboard, and pulse gently so it catches the eye without flashing.
      rig.statusPip.rotation.set(0, -rig.root.rotation.y, Math.PI / 4);
      rig.statusPip.scale.setScalar(1 + Math.sin(rig.phase * 4) * 0.12);
    }

    if (rig.glowSac) {
      const material = rig.glowSac.material as THREE.MeshToonMaterial;
      material.emissiveIntensity = 1 + Math.sin(rig.phase * 2.2) * 0.5;
    }
    if (rig.bossCore) {
      const material = rig.bossCore.material as THREE.MeshToonMaterial;
      material.emissiveIntensity = 1.8 + Math.sin(rig.phase * 3.4) * 1.1;
    }

    if (rig.weaponGroup) {
      rig.recoilZ = THREE.MathUtils.lerp(rig.recoilZ, 0, 1 - Math.exp(-dt * 24));
      rig.recoilPitch = THREE.MathUtils.lerp(rig.recoilPitch, 0, 1 - Math.exp(-dt * 26));
      rig.weaponGroup.rotation.x = -rig.recoilPitch;
    }
  }

  /**
   * Put both hands on the weapon.
   *
   * World matrices are stale after the mixer runs (three.js refreshes them at
   * render time), so the skeleton is brought up to date first; the solve then
   * reads real joint positions and writes bone rotations the renderer will
   * pick up this frame.
   */
  private poseArmsOnGrip(rig: CharacterRig) {
    const bones = rig.aimBones;
    if (!bones || !rig.model) return;
    rig.model.updateMatrixWorld(true);
    rig.body.getWorldQuaternion(IK.bodyQuat);
    const h = rig.spec.height;

    IK.target.copy(AIM_GRIP.rightHand).multiplyScalar(h);
    rig.body.localToWorld(IK.target);
    IK.pole.copy(AIM_GRIP.rightPole).applyQuaternion(IK.bodyQuat);
    solveArm(bones.rightArm, bones.rightForeArm, bones.rightHand, IK.target, IK.pole);

    IK.target.copy(AIM_GRIP.leftHand).multiplyScalar(h);
    rig.body.localToWorld(IK.target);
    IK.pole.copy(AIM_GRIP.leftPole).applyQuaternion(IK.bodyQuat);
    solveArm(bones.leftArm, bones.leftForeArm, bones.leftHand, IK.target, IK.pole);

    // Hands follow their forearms rather than whatever the walk cycle left
    // them doing, otherwise they flop at the wrist while the arms hold still.
    bones.rightHand.quaternion.copy(bones.rightHandRest);
    bones.leftHand.quaternion.copy(bones.leftHandRest);
  }

  private own<T extends THREE.BufferGeometry>(geometry: T): T {
    this.ownedGeometries.push(geometry);
    return geometry;
  }

  private cachedGeometry<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    const hit = this.geometryCache.get(key);
    if (hit) return hit as T;
    const geometry = this.own(make());
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  /** Record a material as belonging to one rig, so its death frees it. */
  private claim<T extends THREE.Material>(rig: CharacterRig, material: T): T {
    rig.ownedMaterials.push(material);
    return material;
  }

  disposeCharacter(rig: CharacterRig) {
    rig.mixer?.stopAllAction();
    rig.mixer = undefined;
    rig.root.removeFromParent();
    for (const material of rig.ownedMaterials) this.palette.release(material);
    rig.ownedMaterials = [];
    rig.tintMaterials = [];
  }

  dispose() {
    this.disposed = true;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries = [];
    this.geometryCache.clear();
    this.shadowGeometry.dispose();
    this.assets.clear();
  }
}
