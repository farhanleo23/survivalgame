import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CHARACTER_VISUALS, GRAPHICS_BUDGETS, WEAPON_VISUALS, type CharacterVisualId } from "../visual-registry";
import type { EnemyDefinition, EnemyId, GraphicsQuality, WeaponId } from "../types";
import { disposeObject, enableShadows, material, mesh, rounded, type CharacterRig } from "./shared";

const limb = (radius: number, length: number, mat: THREE.Material) => {
  const object = mesh(new THREE.CapsuleGeometry(radius, Math.max(0.05, length - radius * 2), 5, 9), mat);
  object.position.y = -length / 2;
  return object;
};

const addEye = (head: THREE.Group, x: number, y: number, z: number, color: number, size = 0.024) => {
  const eye = mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color }));
  eye.position.set(x, y, z);
  head.add(eye);
};

export class CharacterVisualSystem {
  private quality: GraphicsQuality;

  constructor(quality: GraphicsQuality) {
    this.quality = quality;
  }

  setQuality(quality: GraphicsQuality) {
    this.quality = quality;
  }

  async ready() {
    await Promise.resolve();
  }

  createPlayer(weapon: WeaponId): CharacterRig {
    const rig = this.createBaseRig("player");
    const cfg = CHARACTER_VISUALS.player;
    const armor = material(cfg.bodyColor, 0.5, 0.34);
    const dark = material(0x182222, 0.86, 0.12);
    const accent = material(0x8bcf4e, 0.38, 0.22, cfg.emissiveColor, 1.15);
    const visor = material(0x173b39, 0.18, 0.48, 0x4cffcc, 1.8);
    rig.hitMaterials.push(armor, dark);
    rig.accentMaterials.push(accent, visor);

    const chest = rounded(0.72, 0.72, 0.42, armor, 0.09);
    chest.position.y = 1.16;
    const vest = rounded(0.58, 0.46, 0.5, dark, 0.06);
    vest.position.set(0, 1.08, 0.05);
    const pack = rounded(0.48, 0.68, 0.24, dark, 0.06);
    pack.position.set(0, 1.17, -0.28);
    rig.torso.add(chest, vest, pack);

    for (const x of [-0.43, 0.43]) {
      const plate = rounded(0.25, 0.16, 0.39, accent, 0.045);
      plate.position.set(x, 1.43, 0);
      plate.rotation.z = -x * 0.28;
      rig.torso.add(plate);
    }

    const helmet = mesh(new THREE.SphereGeometry(0.27, 16, 10), armor);
    helmet.scale.set(1, 0.86, 1.08);
    helmet.position.y = 1.83;
    const face = rounded(0.38, 0.13, 0.16, visor, 0.045);
    face.position.set(0, 1.82, 0.23);
    const helmetStripe = rounded(0.075, 0.28, 0.04, accent, 0.02);
    helmetStripe.position.set(0, 2.01, 0.08);
    rig.head.add(helmet, face, helmetStripe);

    this.addArmoredLimb(rig.leftArm, -0.46, 1.44, 0.2, 0.72, dark, armor);
    this.addArmoredLimb(rig.rightArm, 0.46, 1.44, 0.2, 0.72, dark, armor);
    this.addArmoredLimb(rig.leftLeg, -0.2, 0.78, 0.22, 0.78, dark, armor);
    this.addArmoredLimb(rig.rightLeg, 0.2, 0.78, 0.22, 0.78, dark, armor);

    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xb8ff5a, transparent: true, opacity: 0.66, side: THREE.DoubleSide, depthWrite: false });
    const ring = mesh(new THREE.RingGeometry(0.57, 0.7, 48), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    rig.root.add(ring);
    this.setWeapon(rig, weapon);
    this.finalize(rig, true);
    return rig;
  }

  createEnemy(type: EnemyId, definition: EnemyDefinition): CharacterRig {
    const rig = this.createBaseRig(type);
    if (type === "runner") this.buildRunner(rig);
    else if (type === "spitter") this.buildSpitter(rig);
    else if (type === "brute") this.buildBrute(rig, false);
    else if (type === "juggernaut") this.buildBrute(rig, true);
    else this.buildShambler(rig);
    this.collapseEnemyGeometry(rig);

    const range = type === "spitter" ? 1.22 : type === "juggernaut" ? 1.58 : type === "brute" ? 1.2 : 0.82;
    const telegraph = mesh(
      new THREE.RingGeometry(range * 0.82, range, 40),
      new THREE.MeshBasicMaterial({
        color: type === "spitter" ? 0x8dff50 : definition.color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    telegraph.rotation.x = -Math.PI / 2;
    telegraph.position.y = 0.045;
    telegraph.visible = false;
    rig.attackTelegraph = telegraph;
    rig.root.add(telegraph);

    if (type === "juggernaut") {
      const bossRing = mesh(
        new THREE.RingGeometry(1.28, 1.5, 56),
        new THREE.MeshBasicMaterial({ color: 0xff402e, transparent: true, opacity: 0.58, side: THREE.DoubleSide, depthWrite: false }),
      );
      bossRing.rotation.x = -Math.PI / 2;
      bossRing.position.y = 0.035;
      rig.root.add(bossRing);
    }
    const budget = GRAPHICS_BUDGETS[this.quality];
    const casts = type === "juggernaut" || (type === "brute" && budget.dynamicCharacterShadows >= 4);
    this.finalize(rig, casts);
    return rig;
  }

  setWeapon(rig: CharacterRig, id: WeaponId) {
    if (rig.kind !== "player" || rig.activeWeapon === id) return;
    rig.weaponMount.clear();
    const weapon = this.createWeapon(id);
    rig.weaponMount.add(weapon.group);
    rig.muzzle = weapon.muzzle;
    rig.activeWeapon = id;
  }

  animate(rig: CharacterRig, dt: number, speed: number, attacking: boolean, hit: number) {
    rig.phase += dt * (speed > 5.4 ? 10.5 : speed > 0.08 ? 6.2 : 2.1);
    const cfg = CHARACTER_VISUALS[rig.kind];
    const moving = speed > 0.08;
    const swing = moving ? Math.sin(rig.phase) : Math.sin(rig.phase * 0.5) * 0.08;
    const gaitScale = cfg.gait === "sprint" ? 0.86 : cfg.gait === "heavy" || cfg.gait === "siege" ? 0.34 : 0.5;
    const attackLean = attacking ? (cfg.gait === "stalk" ? -0.42 : -0.24) : cfg.gait === "sprint" ? -0.28 : cfg.gait === "drag" ? -0.14 : 0;
    rig.model.rotation.x = THREE.MathUtils.lerp(rig.model.rotation.x, attackLean, 1 - Math.exp(-dt * 14));
    rig.model.position.y = THREE.MathUtils.lerp(rig.model.position.y, moving ? Math.abs(Math.sin(rig.phase * 2)) * 0.035 : 0, 1 - Math.exp(-dt * 12));
    rig.leftLeg.rotation.x = THREE.MathUtils.lerp(rig.leftLeg.rotation.x, swing * gaitScale, 1 - Math.exp(-dt * 18));
    rig.rightLeg.rotation.x = THREE.MathUtils.lerp(rig.rightLeg.rotation.x, -swing * gaitScale, 1 - Math.exp(-dt * 18));
    const armSwing = rig.kind === "player" ? 0.08 : gaitScale * 0.75;
    rig.leftArm.rotation.x = THREE.MathUtils.lerp(rig.leftArm.rotation.x, attacking ? -0.8 : -swing * armSwing, 1 - Math.exp(-dt * 18));
    rig.rightArm.rotation.x = THREE.MathUtils.lerp(rig.rightArm.rotation.x, attacking ? -0.8 : swing * armSwing, 1 - Math.exp(-dt * 18));
    if (cfg.gait === "drag") rig.leftArm.rotation.z = -0.2 + Math.sin(rig.phase * 0.4) * 0.08;
    if (cfg.gait === "stalk") rig.head.scale.setScalar(1 + (attacking ? 0.12 : 0));
    if (cfg.gait === "siege") rig.torso.rotation.z = Math.sin(rig.phase * 0.5) * 0.035;

    for (const mat of rig.hitMaterials) {
      mat.emissive.setHex(hit > 0 ? 0x9f160d : 0x080302);
      mat.emissiveIntensity = hit > 0 ? 1.8 : 0.12;
    }
    if (rig.attackTelegraph) {
      const mat = rig.attackTelegraph.material as THREE.MeshBasicMaterial;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, attacking ? 0.38 + Math.sin(rig.phase * 2) * 0.12 : 0, 1 - Math.exp(-dt * 14));
      rig.attackTelegraph.visible = attacking || mat.opacity > 0.01;
      rig.attackTelegraph.rotation.z += dt * (cfg.gait === "stalk" ? 1.4 : 0.55);
    }
  }

  dispose(rig: CharacterRig) {
    if (rig.disposed) return;
    rig.disposed = true;
    rig.root.removeFromParent();
    disposeObject(rig.root);
    rig.root.clear();
  }

  private createBaseRig(kind: CharacterVisualId): CharacterRig {
    const root = new THREE.Group();
    const model = new THREE.Group();
    const torso = new THREE.Group();
    const head = new THREE.Group();
    const leftArm = new THREE.Group();
    const rightArm = new THREE.Group();
    const leftLeg = new THREE.Group();
    const rightLeg = new THREE.Group();
    const weaponMount = new THREE.Group();
    const muzzle = new THREE.Object3D();
    model.add(torso, head, leftArm, rightArm, leftLeg, rightLeg, weaponMount);
    root.add(model);
    const cfg = CHARACTER_VISUALS[kind];
    root.scale.setScalar(cfg.scale);
    const contact = mesh(new THREE.CircleGeometry(kind === "juggernaut" ? 0.72 : kind === "brute" ? 0.6 : 0.48, 28), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.43, depthWrite: false }));
    contact.rotation.x = -Math.PI / 2;
    contact.scale.z = 0.55;
    contact.position.y = 0.02;
    root.add(contact);
    return { root, model, torso, head, leftArm, rightArm, leftLeg, rightLeg, weaponMount, muzzle, hitMaterials: [], accentMaterials: [], phase: Math.random() * Math.PI * 2, scale: cfg.scale, kind, disposed: false };
  }

  private collapseEnemyGeometry(rig: CharacterRig) {
    rig.model.updateMatrixWorld(true);
    const inverseModel = rig.model.matrixWorld.clone().invert();
    const baseGeometries: THREE.BufferGeometry[] = [];
    const accentGeometries: THREE.BufferGeometry[] = [];
    const originals: THREE.Mesh[] = [];
    rig.model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      originals.push(object);
      object.updateWorldMatrix(true, false);
      let geometry = object.geometry.clone();
      if (geometry.index) geometry = geometry.toNonIndexed();
      geometry.applyMatrix4(inverseModel.clone().multiply(object.matrixWorld));
      const sourceMaterial = Array.isArray(object.material) ? object.material[0] : object.material;
      const color = sourceMaterial instanceof THREE.MeshBasicMaterial || sourceMaterial instanceof THREE.MeshStandardMaterial
        ? sourceMaterial.color
        : new THREE.Color(0x778079);
      const colors = new Float32Array((geometry.getAttribute("position")?.count ?? 0) * 3);
      for (let index = 0; index < colors.length; index += 3) {
        colors[index] = color.r;
        colors[index + 1] = color.g;
        colors[index + 2] = color.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const isAccent = sourceMaterial instanceof THREE.MeshBasicMaterial
        || (sourceMaterial instanceof THREE.MeshStandardMaterial && sourceMaterial.emissiveIntensity >= 0.5);
      (isAccent ? accentGeometries : baseGeometries).push(geometry);
    });
    for (const original of originals) {
      original.removeFromParent();
      original.geometry.dispose();
      const materials = Array.isArray(original.material) ? original.material : [original.material];
      for (const originalMaterial of materials) originalMaterial.dispose();
    }
    const baseGeometry = baseGeometries.length ? mergeGeometries(baseGeometries, false) : null;
    const accentGeometry = accentGeometries.length ? mergeGeometries(accentGeometries, false) : null;
    for (const geometry of [...baseGeometries, ...accentGeometries]) geometry.dispose();
    rig.hitMaterials = [];
    rig.accentMaterials = [];
    if (baseGeometry) {
      const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.1, emissive: 0x080302, emissiveIntensity: 0.12 });
      const body = new THREE.Mesh(baseGeometry, bodyMaterial);
      body.castShadow = rig.kind === "juggernaut" || (rig.kind === "brute" && GRAPHICS_BUDGETS[this.quality].dynamicCharacterShadows >= 4);
      body.receiveShadow = true;
      rig.model.add(body);
      rig.hitMaterials.push(bodyMaterial);
    }
    if (accentGeometry) {
      const accentMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
      const accents = new THREE.Mesh(accentGeometry, accentMaterial);
      accents.castShadow = false;
      rig.model.add(accents);
    }
  }

  private addArmoredLimb(group: THREE.Group, x: number, y: number, radius: number, length: number, cloth: THREE.Material, plate: THREE.Material) {
    group.position.set(x, y, 0);
    const base = limb(radius, length, cloth);
    const armor = rounded(radius * 1.7, length * 0.34, radius * 1.7, plate, 0.045);
    armor.position.y = -length * 0.3;
    group.add(base, armor);
  }

  private buildShambler(rig: CharacterRig) {
    const cfg = CHARACTER_VISUALS.shambler;
    const flesh = material(0x6e7563, 0.96, 0, 0x120201, 0.1);
    const cloth = material(cfg.bodyColor, 0.94, 0.03);
    const gore = material(0x6e1812, 0.82, 0.02, 0x2b0201, 0.16);
    rig.hitMaterials.push(flesh, cloth);
    const torso = rounded(0.7, 0.78, 0.43, cloth, 0.1);
    torso.position.set(-0.06, 1.14, 0);
    torso.rotation.z = -0.08;
    const tear = mesh(new THREE.CircleGeometry(0.12, 12), gore);
    tear.position.set(0.15, 1.25, 0.222);
    rig.torso.add(torso, tear);
    this.addZombieHead(rig, flesh, cfg.emissiveColor, 1.74, 0.28);
    this.addZombieLimb(rig.leftArm, -0.48, 1.42, 0.18, 0.84, flesh, cloth, 1.25);
    this.addZombieLimb(rig.rightArm, 0.42, 1.4, 0.14, 0.7, flesh, cloth, 0.92);
    this.addZombieLimb(rig.leftLeg, -0.21, 0.76, 0.17, 0.76, flesh, cloth, 1.05);
    this.addZombieLimb(rig.rightLeg, 0.2, 0.76, 0.17, 0.7, flesh, cloth, 0.95);
  }

  private buildRunner(rig: CharacterRig) {
    const cfg = CHARACTER_VISUALS.runner;
    const flesh = material(0x8e7562, 0.94, 0, 0x1f0301, 0.12);
    const cloth = material(0x4e4039, 0.96, 0);
    rig.hitMaterials.push(flesh, cloth);
    const torso = rounded(0.46, 0.72, 0.32, cloth, 0.07);
    torso.position.set(0, 1.12, 0.08);
    torso.rotation.x = -0.18;
    rig.torso.add(torso);
    this.addZombieHead(rig, flesh, cfg.emissiveColor, 1.68, 0.22);
    this.addZombieLimb(rig.leftArm, -0.34, 1.37, 0.105, 0.88, flesh, cloth, 1);
    this.addZombieLimb(rig.rightArm, 0.34, 1.37, 0.105, 0.88, flesh, cloth, 1);
    this.addZombieLimb(rig.leftLeg, -0.14, 0.78, 0.12, 0.86, flesh, cloth, 1);
    this.addZombieLimb(rig.rightLeg, 0.14, 0.78, 0.12, 0.86, flesh, cloth, 1);
    for (const hand of [rig.leftArm, rig.rightArm]) {
      for (const x of [-0.045, 0, 0.045]) {
        const claw = mesh(new THREE.ConeGeometry(0.018, 0.16, 5), flesh);
        claw.rotation.x = Math.PI / 2;
        claw.position.set(x, -0.9, 0.08);
        hand.add(claw);
      }
    }
  }

  private buildSpitter(rig: CharacterRig) {
    const cfg = CHARACTER_VISUALS.spitter;
    const flesh = material(0x62715a, 0.9, 0.01, 0x112806, 0.25);
    const cloth = material(0x33443b, 0.96, 0);
    const acid = material(0x76a64c, 0.45, 0.02, cfg.emissiveColor, 2.3);
    rig.hitMaterials.push(flesh, cloth);
    rig.accentMaterials.push(acid);
    const torso = rounded(0.66, 0.78, 0.42, cloth, 0.09);
    torso.position.y = 1.12;
    rig.torso.add(torso);
    this.addZombieHead(rig, flesh, cfg.emissiveColor, 1.72, 0.25);
    const throat = mesh(new THREE.SphereGeometry(0.16, 14, 10), acid);
    throat.scale.set(0.9, 1.25, 0.76);
    throat.position.set(0, 1.53, 0.24);
    rig.head.add(throat);
    for (const [x, y, scale] of [[-0.18, 1.22, 0.19], [0.19, 1.3, 0.16], [0, 1.05, 0.22]] as const) {
      const sac = mesh(new THREE.SphereGeometry(scale, 12, 9), acid);
      sac.position.set(x, y, -0.28);
      rig.torso.add(sac);
    }
    this.addZombieLimb(rig.leftArm, -0.43, 1.4, 0.145, 0.76, flesh, cloth, 1);
    this.addZombieLimb(rig.rightArm, 0.43, 1.4, 0.145, 0.76, flesh, cloth, 1);
    this.addZombieLimb(rig.leftLeg, -0.2, 0.76, 0.16, 0.74, flesh, cloth, 1);
    this.addZombieLimb(rig.rightLeg, 0.2, 0.76, 0.16, 0.74, flesh, cloth, 1);
  }

  private buildBrute(rig: CharacterRig, boss: boolean) {
    const cfg = CHARACTER_VISUALS[boss ? "juggernaut" : "brute"];
    const flesh = material(boss ? 0x6f5c52 : 0x80695c, 0.91, 0.02, 0x210301, 0.16);
    const cloth = material(boss ? 0x282b2b : 0x433d38, 0.9, 0.08);
    const armor = material(boss ? 0x5a2220 : 0x5d4e43, 0.5, 0.62, cfg.emissiveColor, boss ? 0.22 : 0.05);
    const accent = material(boss ? 0x9f2c22 : 0x95462e, 0.38, 0.55, cfg.emissiveColor, boss ? 1.1 : 0.2);
    rig.hitMaterials.push(flesh, cloth, armor);
    rig.accentMaterials.push(accent);
    const torso = rounded(boss ? 1.05 : 0.92, boss ? 0.9 : 0.82, boss ? 0.68 : 0.58, cloth, 0.14);
    torso.position.y = 1.18;
    rig.torso.add(torso);
    const chest = rounded(boss ? 0.95 : 0.8, 0.38, boss ? 0.72 : 0.61, armor, 0.08);
    chest.position.set(0, 1.3, 0.07);
    rig.torso.add(chest);
    for (const x of [-0.43, 0.43]) {
      const shoulder = mesh(new THREE.SphereGeometry(boss ? 0.31 : 0.26, 13, 9), armor);
      shoulder.scale.set(1.25, 0.72, 1);
      shoulder.position.set(x * (boss ? 1.22 : 1), 1.53, 0);
      rig.torso.add(shoulder);
    }
    this.addZombieHead(rig, flesh, cfg.emissiveColor, 1.75, boss ? 0.27 : 0.24);
    this.addZombieLimb(rig.leftArm, boss ? -0.66 : -0.56, 1.46, boss ? 0.27 : 0.23, boss ? 0.92 : 0.84, flesh, armor, 1.2);
    this.addZombieLimb(rig.rightArm, boss ? 0.66 : 0.56, 1.46, boss ? 0.27 : 0.23, boss ? 0.92 : 0.84, flesh, armor, 1.2);
    this.addZombieLimb(rig.leftLeg, -0.27, 0.78, boss ? 0.23 : 0.2, 0.78, flesh, cloth, 1);
    this.addZombieLimb(rig.rightLeg, 0.27, 0.78, boss ? 0.23 : 0.2, 0.78, flesh, cloth, 1);
    if (boss) {
      const core = mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.13, 12), accent);
      core.rotation.x = Math.PI / 2;
      core.position.set(0, 1.3, 0.43);
      rig.torso.add(core);
      for (const x of [-0.37, 0.37]) {
        const spike = mesh(new THREE.ConeGeometry(0.08, 0.42, 7), armor);
        spike.position.set(x, 1.82, -0.04);
        spike.rotation.z = x < 0 ? 0.55 : -0.55;
        rig.torso.add(spike);
      }
    }
  }

  private addZombieHead(rig: CharacterRig, flesh: THREE.MeshStandardMaterial, eyeColor: number, y: number, size: number) {
    const skull = mesh(new THREE.SphereGeometry(size, 14, 10), flesh);
    skull.scale.set(0.92, 1.08, 0.95);
    skull.position.y = y;
    const jaw = rounded(size * 1.2, size * 0.46, size * 0.82, flesh, 0.035);
    jaw.position.set(0, y - size * 0.48, size * 0.44);
    jaw.rotation.x = 0.2;
    rig.head.add(skull, jaw);
    addEye(rig.head, -size * 0.34, y + size * 0.12, size * 0.88, eyeColor, size * 0.09);
    addEye(rig.head, size * 0.34, y + size * 0.12, size * 0.88, eyeColor, size * 0.09);
  }

  private addZombieLimb(group: THREE.Group, x: number, y: number, radius: number, length: number, flesh: THREE.Material, clothing: THREE.Material, widthScale: number) {
    group.position.set(x, y, 0);
    const upper = limb(radius * widthScale, length * 0.53, clothing);
    upper.position.y = -length * 0.28;
    const lower = limb(radius * 0.82, length * 0.52, flesh);
    lower.position.y = -length * 0.72;
    group.add(upper, lower);
  }

  private createWeapon(id: WeaponId) {
    const cfg = WEAPON_VISUALS[id];
    const group = new THREE.Group();
    group.position.set(0.08, 1.22, 0.33);
    const gun = material(0x161f21, 0.3, 0.82);
    const steel = material(0x506165, 0.36, 0.68);
    const accent = material(cfg.accentColor, 0.45, 0.28, cfg.accentColor, 0.56);
    const body = rounded(cfg.width, 0.17, cfg.length * 0.52, gun, 0.035);
    body.position.z = cfg.length * 0.04;
    const upper = rounded(cfg.width * 0.68, 0.09, cfg.length * 0.5, steel, 0.025);
    upper.position.set(0, 0.12, cfg.length * 0.06);
    const barrel = mesh(new THREE.CylinderGeometry(0.026 + cfg.width * 0.03, 0.034 + cfg.width * 0.03, cfg.barrelLength, 10), gun);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = cfg.length * 0.34 + cfg.barrelLength * 0.48;
    const grip = rounded(cfg.width * 0.55, 0.27, 0.11, gun, 0.025);
    grip.position.set(0, -0.18, -cfg.length * 0.08);
    grip.rotation.x = -0.18;
    const sight = rounded(0.08, 0.09, 0.18, accent, 0.02);
    sight.position.set(0, 0.19, cfg.length * 0.04);
    group.add(body, upper, barrel, grip, sight);
    if (cfg.stockLength > 0) {
      const stock = rounded(cfg.width * 1.05, 0.2, cfg.stockLength, steel, 0.04);
      stock.position.z = -cfg.length * 0.3 - cfg.stockLength * 0.3;
      group.add(stock);
    }
    if (id === "shotgun") {
      const pump = rounded(cfg.width * 1.15, 0.16, 0.3, accent, 0.025);
      pump.position.z = cfg.length * 0.28;
      group.add(pump);
    }
    if (id === "smg") {
      const magazine = rounded(0.13, 0.34, 0.15, accent, 0.025);
      magazine.position.set(0, -0.23, 0.12);
      magazine.rotation.x = 0.12;
      group.add(magazine);
    }
    if (id === "rifle") {
      const optic = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.24, 12), accent);
      optic.rotation.x = Math.PI / 2;
      optic.position.set(0, 0.22, 0.02);
      group.add(optic);
    }
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, cfg.length * 0.35 + cfg.barrelLength);
    group.add(muzzle);
    enableShadows(group, false);
    return { group, muzzle };
  }

  private finalize(rig: CharacterRig, castShadow: boolean) {
    enableShadows(rig.model, castShadow);
  }
}
