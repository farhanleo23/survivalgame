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

  /** Upper-body bones pinned to an aiming pose after each mixer update. */
  aimBones?: {
    rightArm?: THREE.Object3D;
    rightForeArm?: THREE.Object3D;
    leftArm?: THREE.Object3D;
    leftForeArm?: THREE.Object3D;
  };

  /** Cloned per rig so a hit flash never bleeds across characters. */
  tintMaterials: THREE.MeshToonMaterial[];
  glowSac?: THREE.Mesh;
  bossCore?: THREE.Mesh;
  frostShell?: THREE.Mesh;
  burnShell?: THREE.Mesh;

  kind: CharacterKind;
  spec: ArchetypeSpec;
  phase: number;
  attackBlend: number;
  hitBlend: number;
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
  // Tinted operator blue: the Vanguard's brown camo reads identically to the
  // infected at the top-down camera, and finding yourself instantly matters
  // more than the texture's original colour.
  player: {
    height: 1.95,
    girth: 1,
    asset: "/models/soldier.glb",
    yawOffset: Math.PI,
    tint: COMIC.operator,
    tintStrength: 1,
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
 * Braced two-handed aiming pose, in local bone space for the Vanguard rig.
 *
 * Applied after the mixer runs so it overrides whatever the locomotion clip
 * did to the arms, giving the classic twin-stick split: legs keep walking,
 * upper body stays locked on the cursor.
 */
const AIM_POSE = {
  rightArm: new THREE.Quaternion(0.3512, 0, 0.7243, 0.5934),
  rightForeArm: new THREE.Quaternion(0.6332, 0, 0.0612, 0.7715),
  leftArm: new THREE.Quaternion(-0.5229, 0, 0.5282, 0.669),
  leftForeArm: new THREE.Quaternion(-0.3079, 0, -0.2463, 0.919),
};

/**
 * Measure a character's real world-space extent.
 *
 * `Box3.setFromObject` is wrong for skinned meshes: it transforms the raw
 * bind-pose geometry bounds by the node matrix and ignores the skeleton
 * entirely. Across these source models that produced heights from 0.004 to 44
 * units, so normalisation collapsed most of them to nothing. `SkinnedMesh
 * .computeBoundingBox()` applies the bone transforms and gives the true extent.
 */
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
  private ownedGeometries: THREE.BufferGeometry[] = [];
  private disposed = false;

  constructor(private palette: ComicPalette) {
    this.shadowMaterial = palette.flat(COMIC.ink, { transparent: true, opacity: 0.34 });
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
      const material = this.palette.toon(0xffffff);

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

      child.material = material;
      rig.tintMaterials.push(material);
    });
  }

  /** Per-archetype identifiers, sized against the model's real height. */
  private addSignatureParts(kind: CharacterKind, rig: CharacterRig, spec: ArchetypeSpec) {
    const h = spec.height;
    const ink = this.palette.outlineMaterial();

    if (kind === "spitter") {
      const sac = new THREE.Mesh(
        this.own(new THREE.SphereGeometry(h * 0.16, 12, 9)),
        this.palette.toon(COMIC.acid, { emissive: COMIC.acid, emissiveIntensity: 1.4 }),
      );
      sac.position.set(0, h * 0.72, h * 0.15);
      inkInPlace(sac, ink, 0.06);
      rig.body.add(sac);
      rig.glowSac = sac;
    }

    if (kind === "boomer") {
      const pustuleGeo = this.own(new THREE.SphereGeometry(h * 0.075, 8, 6));
      const pustuleMat = this.palette.toon(COMIC.acid, { emissive: COMIC.acid, emissiveIntensity: 1.2 });
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
        this.own(new RoundedBoxGeometry(h * 0.34, h * 0.26, h * 0.2, 2, 0.02 * h)),
        this.palette.toon(0x503586),
      );
      slab.position.set(-h * 0.19, h * 0.72, 0);
      inkInPlace(slab, ink, 0.05);
      rig.body.add(slab);
    }

    if (kind === "juggernaut") {
      const core = new THREE.Mesh(
        this.own(new THREE.SphereGeometry(h * 0.085, 12, 10)),
        this.palette.toon(COMIC.gold, { emissive: COMIC.fire, emissiveIntensity: 2.2 }),
      );
      core.position.set(0, h * 0.52, h * 0.3);
      rig.body.add(core);
      rig.bossCore = core;

      const hornGeo = this.own(new THREE.ConeGeometry(h * 0.045, h * 0.2, 7));
      const trim = this.palette.toon(0x8c1226);
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(hornGeo, trim);
        horn.position.set(side * h * 0.17, h * 0.86, h * 0.12);
        horn.rotation.z = side * -0.55;
        inkInPlace(horn, ink, 0.06);
        rig.body.add(horn);
      }

    }

    // Status shells wrap the whole body and toggle with chill/burn.
    const shellGeo = this.own(new THREE.SphereGeometry(h * 0.42, 12, 9));
    const frost = new THREE.Mesh(shellGeo, this.palette.flat(COMIC.frost, { transparent: true, opacity: 0.4 }));
    frost.position.y = h * 0.5;
    frost.scale.z = 0.7;
    frost.visible = false;
    frost.raycast = () => {};
    rig.body.add(frost);
    rig.frostShell = frost;

    const burn = new THREE.Mesh(shellGeo, this.palette.flat(COMIC.fire, { transparent: true, opacity: 0.4 }));
    burn.position.y = h * 0.5;
    burn.scale.z = 0.7;
    burn.visible = false;
    burn.raycast = () => {};
    rig.body.add(burn);
    rig.burnShell = burn;
  }

  /**
   * Comic weapon silhouettes parented to the operator's right hand so they
   * follow the skinned animation instead of floating at a fixed offset.
   */
  private attachWeapons(rig: CharacterRig, model: THREE.Object3D, spec: ArchetypeSpec) {
    const ink = this.palette.outlineMaterial();
    const gunmetal = this.palette.toon(0x2b3346);
    const steel = this.palette.toon(COMIC.steel);
    const glow = this.palette.toon(COMIC.gold, { emissive: COMIC.gold, emissiveIntensity: 1.6 });

    // The weapon rides a fixed chest mount, NOT the right hand bone.
    //
    // Parented to the hand it inherits the walk cycle's full arm swing, so the
    // barrel sweeps through a wide arc while firing and tracers appear to leave
    // from wherever the arm happened to be — the aim never matches the shot.
    // Mounted on the body it always points down the character's +Z, which is
    // exactly the direction the engine rotates toward the cursor, so muzzle and
    // aim agree on every frame. The arms are then posed to meet the weapon.
    const weaponGroup = new THREE.Group();
    weaponGroup.position.set(spec.height * 0.09, spec.height * 0.58, spec.height * 0.2);
    weaponGroup.scale.setScalar(spec.height * 0.42);
    rig.body.add(weaponGroup);
    rig.weaponGroup = weaponGroup;

    rig.aimBones = {
      rightArm: findBone(model, "RightArm"),
      rightForeArm: findBone(model, "RightForeArm"),
      leftArm: findBone(model, "LeftArm"),
      leftForeArm: findBone(model, "LeftForeArm"),
    };

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

      const gun = new THREE.Mesh(
        this.own(new RoundedBoxGeometry(0.16, bodyHeight, bodyLength, 2, 0.02)),
        gunmetal,
      );
      gun.position.z = bodyLength / 2;
      inkInPlace(gun, ink, 0.09);
      group.add(gun);

      const barrel = new THREE.Mesh(
        this.own(new THREE.CylinderGeometry(barrelRadius, barrelRadius, barrelLength, 8)),
        steel,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, bodyHeight * 0.16, bodyLength + barrelLength * 0.5);
      inkInPlace(barrel, ink, 0.11);
      group.add(barrel);

      if (magDepth > 0) {
        const mag = new THREE.Mesh(
          this.own(new RoundedBoxGeometry(0.1, magDepth, 0.13, 2, 0.02)),
          gunmetal,
        );
        mag.position.set(0, -magDepth / 2 - bodyHeight * 0.3, bodyLength * 0.42);
        inkInPlace(mag, ink, 0.1);
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

      // Pin the aiming pose *after* the mixer, or the locomotion clip wins and
      // the arms swing the weapon off target mid-burst.
      if (rig.aimBones) {
        const { rightArm, rightForeArm, leftArm, leftForeArm } = rig.aimBones;
        rightArm?.quaternion.copy(AIM_POSE.rightArm);
        rightForeArm?.quaternion.copy(AIM_POSE.rightForeArm);
        leftArm?.quaternion.copy(AIM_POSE.leftArm);
        leftForeArm?.quaternion.copy(AIM_POSE.leftForeArm);
      }
    }

    // Hit flash drives the tint materials white, then decays back to unlit.
    if (rig.hitBlend > 0.01) {
      for (const material of rig.tintMaterials) {
        material.emissive.setRGB(rig.hitBlend, rig.hitBlend, rig.hitBlend);
        material.emissiveIntensity = rig.hitBlend * 1.5;
      }
    } else if (rig.hitBlend > 0) {
      for (const material of rig.tintMaterials) material.emissive.setRGB(0, 0, 0);
    }

    if (rig.frostShell) rig.frostShell.visible = isChilled;
    if (rig.burnShell) {
      rig.burnShell.visible = isBurning;
      if (isBurning) rig.burnShell.scale.setScalar(1 + Math.sin(rig.phase * 6) * 0.05);
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

  private own<T extends THREE.BufferGeometry>(geometry: T): T {
    this.ownedGeometries.push(geometry);
    return geometry;
  }

  disposeCharacter(rig: CharacterRig) {
    rig.mixer?.stopAllAction();
    rig.mixer = undefined;
    rig.root.removeFromParent();
  }

  dispose() {
    this.disposed = true;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries = [];
    this.shadowGeometry.dispose();
    this.assets.clear();
  }
}
