import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { ENEMIES, getWeaponStats, PICKUPS, WAVES, WEAPONS } from "./config";
import { GameAudio } from "./audio";
import type {
  EnemyDefinition,
  EnemyId,
  HudState,
  PerkId,
  PickupId,
  ProfileV1,
  WeaponId,
  WeaponInstance,
} from "./types";

interface EngineCallbacks {
  onHud: (hud: HudState) => void;
  onCoins: (amount: number) => void;
  onWaveChange: (wave: number) => void;
  onWaveComplete: (wave: number) => void;
  onDeath: () => void;
  onVictory: () => void;
  onPauseToggle: () => void;
}

interface EnemyEntity {
  type: EnemyId;
  definition: EnemyDefinition;
  mesh: THREE.Group;
  health: number;
  maxHealth: number;
  attackCooldown: number;
  specialCooldown: number;
  chargeRemaining: number;
  hitFlash: number;
}

interface ProjectileEntity {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  damage: number;
  life: number;
  enemy: boolean;
}

interface PickupEntity {
  type: PickupId;
  mesh: THREE.Group;
  value: number;
  age: number;
}

interface BarrelEntity {
  mesh: THREE.Group;
  active: boolean;
}

interface EffectEntity {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

interface Obstacle {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

const FIXED_STEP = 1 / 60;
const ARENA_LIMIT = 18.5;

await RAPIER.init();

export class GameEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;
  private profile: ProfileV1;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private accumulator = 0;
  private frame = 0;
  private paused = true;
  private destroyed = false;
  private hudTimer = 0;
  private announcement = "";
  private announcementTimer = 0;

  private physics = new RAPIER.World({ x: 0, y: 0, z: 0 });
  private playerBody: RAPIER.RigidBody;
  private playerMesh = new THREE.Group();
  private playerHealth = 100;
  private maxHealth = 100;
  private moveSpeed = 6.2;
  private pickupRadius = 2.2;
  private dashCooldown = 0;
  private dashRemaining = 0;
  private aim = new THREE.Vector3(0, 0, 1);
  private mouseNdc = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private keys = new Set<string>();
  private firing = false;
  private qaMode =
    typeof window !== "undefined" &&
    window.location.hostname === "localhost" &&
    new URLSearchParams(window.location.search).has("qa");

  private enemies: EnemyEntity[] = [];
  private projectiles: ProjectileEntity[] = [];
  private pickups: PickupEntity[] = [];
  private barrels: BarrelEntity[] = [];
  private effects: EffectEntity[] = [];
  private obstacles: Obstacle[] = [];
  private weaponStates = new Map<WeaponId, WeaponInstance>();
  private loadout: WeaponId[];
  private activeWeaponIndex = 0;

  private wave = 1;
  private spawnQueue: EnemyId[] = [];
  private spawnTimer = 0;
  private waveActive = false;
  private audio = new GameAudio();

  constructor(container: HTMLElement, profile: ProfileV1, callbacks: EngineCallbacks) {
    this.container = container;
    this.profile = profile;
    this.callbacks = callbacks;
    this.loadout = profile.equippedLoadout.length ? [...profile.equippedLoadout] : ["pistol"];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Deadwave evacuation depot combat arena");
    this.container.appendChild(this.renderer.domElement);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.72, 0)
      .lockRotations()
      .setLinearDamping(18);
    this.playerBody = this.physics.createRigidBody(bodyDesc);
    this.physics.createCollider(
      RAPIER.ColliderDesc.cylinder(0.7, 0.45).setFriction(0).setRestitution(0),
      this.playerBody,
    );

    this.applyPerks(profile.perkRanks);
    this.setupScene();
    this.createPlayer();
    this.createWeaponStates();
    this.bindEvents();
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  start(wave = 1) {
    this.wave = wave;
    this.audio.configure(this.profile.settings);
    this.audio.start();
    this.paused = false;
    this.startWave(wave);
  }

  pause() {
    this.paused = true;
    this.firing = false;
  }

  resume() {
    this.paused = false;
    this.clock.getDelta();
  }

  startNextWave() {
    this.wave = Math.min(10, this.wave + 1);
    this.startWave(this.wave);
    this.resume();
  }

  getWave() {
    return this.wave;
  }

  setProfile(profile: ProfileV1) {
    this.profile = profile;
    this.audio.configure(profile.settings);
    this.applyPerks(profile.perkRanks);
    for (const id of profile.ownedWeapons) this.ensureWeaponState(id);
  }

  unlockAndEquip(id: WeaponId) {
    this.ensureWeaponState(id);
    if (!this.loadout.includes(id)) {
      if (this.loadout.length < 2) this.loadout.push(id);
      else this.loadout[1] = id;
    }
    this.activeWeaponIndex = this.loadout.indexOf(id);
    this.emitHud(true);
  }

  equipLoadout(ids: WeaponId[]) {
    this.loadout = ids.slice(0, 2);
    if (!this.loadout.length) this.loadout = ["pistol"];
    this.activeWeaponIndex = 0;
    for (const id of this.loadout) this.ensureWeaponState(id);
  }

  refillAmmo() {
    for (const [id, state] of this.weaponStates) {
      const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
      state.magazine = stats.magazine;
      state.reserve = stats.reserve;
      state.reloading = 0;
    }
    this.audio.tone(620, 0.12, 0.06, "sine");
    this.emitHud(true);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.unbindEvents();
    this.audio.stop();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material?.dispose?.();
    });
    this.physics.free();
  }

  private setupScene() {
    this.scene.background = new THREE.Color(0x07100d);
    this.scene.fog = new THREE.FogExp2(0x07100d, 0.025);

    const ambient = new THREE.HemisphereLight(0xb8ffd0, 0x06100b, 1.45);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xd8ffb4, 3.2);
    key.position.set(-10, 20, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -24;
    key.shadow.camera.right = 24;
    key.shadow.camera.top = 24;
    key.shadow.camera.bottom = -24;
    this.scene.add(key);
    const warning = new THREE.PointLight(0xff593d, 35, 18, 2);
    warning.position.set(14, 4, -11);
    this.scene.add(warning);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(42, 42, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x18251e, roughness: 0.96, metalness: 0.06 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(42, 42, 0x385b43, 0x203429);
    grid.position.y = 0.012;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.22;
    this.scene.add(grid);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(19.3, 19.55, 72),
      new THREE.MeshBasicMaterial({ color: 0x7bff9a, transparent: true, opacity: 0.32, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    this.scene.add(ring);

    this.addObstacle(-8.5, -5.5, 4.5, 1.2, 0x273b32);
    this.addObstacle(8.5, 5.2, 4.3, 1.15, 0x273b32);
    this.addObstacle(-10.6, 7.9, 2.7, 1.4, 0x33483f);
    this.addObstacle(10.9, -8.5, 2.8, 1.35, 0x33483f);
    this.addObstacle(0, -11.3, 2.1, 1.25, 0x26372f);

    this.addBarricade(-3.4, 5.6, 4.2, 0.42, -0.28);
    this.addBarricade(4.2, -4.8, 3.4, 0.42, 0.32);
    this.addFloodlight(-15, -13, 0x9fffc2);
    this.addFloodlight(15, 13, 0xff745c);
    this.addBarrel(-3, -2.5);
    this.addBarrel(5.5, 2.2);
    this.addBarrel(12, -1.5);
    this.addBarrel(-13, 1.8);
  }

  private addObstacle(x: number, z: number, width: number, depth: number, color: number) {
    const height = 2.2;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.42 }),
    );
    mesh.position.set(x, height / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.02, 0.22, depth + 0.02),
      new THREE.MeshStandardMaterial({ color: 0xc8e05b, emissive: 0x303a0a }),
    );
    stripe.position.set(x, 1.2, z);
    this.scene.add(stripe);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2), body);
    this.obstacles.push({ x, z, hx: width / 2, hz: depth / 2 });
  }

  private addBarricade(x: number, z: number, width: number, depth: number, rotation: number) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.8, depth),
      new THREE.MeshStandardMaterial({ color: 0x5f5b45, roughness: 0.9 }),
    );
    mesh.position.set(x, 0.4, z);
    mesh.rotation.y = rotation;
    mesh.castShadow = true;
    this.scene.add(mesh);
    // The conservative AABB keeps both the player and horde clear of angled cover.
    const hx = Math.abs(Math.cos(rotation) * width / 2) + Math.abs(Math.sin(rotation) * depth / 2);
    const hz = Math.abs(Math.sin(rotation) * width / 2) + Math.abs(Math.cos(rotation) * depth / 2);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.4, z).setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) }));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, 0.4, depth / 2), body);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addFloodlight(x: number, z: number, color: number) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.12, 4.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x28352f, metalness: 0.8 }),
    );
    pole.position.set(x, 2.4, z);
    this.scene.add(pole);
    const light = new THREE.PointLight(color, 28, 12, 2);
    light.position.set(x, 4.5, z);
    this.scene.add(light);
  }

  private addBarrel(x: number, z: number) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.47, 0.47, 1.15, 14),
      new THREE.MeshStandardMaterial({ color: 0x7d2f27, roughness: 0.55, metalness: 0.45 }),
    );
    body.position.y = 0.58;
    body.castShadow = true;
    group.add(body);
    const bandMaterial = new THREE.MeshStandardMaterial({ color: 0xff7b43, emissive: 0x471109 });
    for (const y of [0.28, 0.86]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.045, 6, 16), bandMaterial);
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      group.add(band);
    }
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.barrels.push({ mesh: group, active: true });
  }

  private createPlayer() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.78, 28),
      new THREE.MeshBasicMaterial({ color: 0xb8ff5a, transparent: true, opacity: 0.58, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    this.playerMesh.add(ring);
    const legs = new THREE.Mesh(
      new THREE.CylinderGeometry(0.33, 0.4, 0.65, 9),
      new THREE.MeshStandardMaterial({ color: 0x18211e, roughness: 0.9 }),
    );
    legs.position.y = 0.55;
    legs.castShadow = true;
    this.playerMesh.add(legs);
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.9, 10),
      new THREE.MeshStandardMaterial({ color: 0xd5ddcf, roughness: 0.65 }),
    );
    torso.position.y = 1.25;
    torso.castShadow = true;
    this.playerMesh.add(torso);
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x39453f, roughness: 0.52, metalness: 0.3 }),
    );
    helmet.position.y = 1.92;
    helmet.castShadow = true;
    this.playerMesh.add(helmet);
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 1.18),
      new THREE.MeshStandardMaterial({ color: 0x202826, metalness: 0.75, roughness: 0.32 }),
    );
    gun.position.set(0.26, 1.35, 0.65);
    gun.castShadow = true;
    this.playerMesh.add(gun);
    this.scene.add(this.playerMesh);
  }

  private createWeaponStates() {
    for (const id of this.profile.ownedWeapons) this.ensureWeaponState(id);
  }

  private ensureWeaponState(id: WeaponId) {
    if (this.weaponStates.has(id)) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    this.weaponStates.set(id, {
      id,
      rank: this.profile.weaponRanks[id],
      magazine: stats.magazine,
      reserve: stats.reserve,
      cooldown: 0,
      reloading: 0,
    });
  }

  private applyPerks(perks: Record<PerkId, number>) {
    const previousMax = this.maxHealth;
    this.maxHealth = 100 + perks.vitality * 20;
    if (this.playerHealth === previousMax || !this.playerHealth) this.playerHealth = this.maxHealth;
    else this.playerHealth = Math.min(this.maxHealth, this.playerHealth + Math.max(0, this.maxHealth - previousMax));
    this.moveSpeed = 6.2 * (1 + perks.mobility * 0.06);
    this.pickupRadius = 2.2 + perks.magnet * 1.3;
  }

  private startWave(number: number) {
    const definition = WAVES[number - 1];
    this.wave = number;
    this.spawnQueue = [];
    for (const [id, count] of Object.entries(definition.enemies) as [EnemyId, number][]) {
      if (id === "juggernaut") continue;
      for (let index = 0; index < count; index += 1) this.spawnQueue.push(id);
    }
    this.shuffle(this.spawnQueue);
    const bossCount = definition.enemies.juggernaut ?? 0;
    for (let index = 0; index < bossCount; index += 1) this.spawnQueue.push("juggernaut");
    this.spawnTimer = 0.45;
    this.waveActive = true;
    this.playerHealth = Math.min(this.maxHealth, this.playerHealth + 16);
    this.announcement = `Wave ${number} // ${definition.label}`;
    this.announcementTimer = 2.8;
    this.createPickup("ammo", new THREE.Vector3(0, 0, number % 2 ? -3.2 : 3.2), 1);
    this.callbacks.onWaveChange(number);
    this.emitHud(true);
  }

  private spawnEnemy(type: EnemyId) {
    const definition = ENEMIES[type];
    const group = new THREE.Group();
    const scale = type === "juggernaut" ? 1.65 : type === "brute" ? 1.25 : type === "runner" ? 0.86 : 1;
    const legs = new THREE.Mesh(
      new THREE.CylinderGeometry(definition.radius * 0.54, definition.radius * 0.7, 0.75 * scale, 8),
      new THREE.MeshStandardMaterial({ color: 0x27322b, roughness: 0.95 }),
    );
    legs.position.y = 0.42 * scale;
    legs.castShadow = true;
    group.add(legs);
    const torsoMaterial = new THREE.MeshStandardMaterial({ color: definition.color, roughness: 0.82 });
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(definition.radius * 0.62, definition.radius * 0.78, 1.05 * scale, 9),
      torsoMaterial,
    );
    torso.position.y = 1.18 * scale;
    torso.castShadow = true;
    group.add(torso);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(definition.radius * 0.48, 10, 8),
      new THREE.MeshStandardMaterial({ color: type === "spitter" ? 0xa4ff64 : 0x8c9a78, roughness: 0.8 }),
    );
    head.position.set(0, 1.94 * scale, 0.06);
    head.castShadow = true;
    group.add(head);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: type === "spitter" ? 0xc4ff45 : 0xff6548 });
    for (const x of [-0.13, 0.13]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045 * scale, 6, 5), eyeMaterial);
      eye.position.set(x * scale, 2.02 * scale, definition.radius * 0.42);
      group.add(eye);
    }
    if (type === "juggernaut") {
      const bossRing = new THREE.Mesh(
        new THREE.RingGeometry(1.45, 1.68, 36),
        new THREE.MeshBasicMaterial({ color: 0xff4935, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      bossRing.rotation.x = -Math.PI / 2;
      bossRing.position.y = 0.05;
      group.add(bossRing);
    }
    const spawn = this.randomSpawnPoint();
    group.position.copy(spawn);
    this.scene.add(group);
    this.enemies.push({
      type,
      definition,
      mesh: group,
      health: definition.health,
      maxHealth: definition.health,
      attackCooldown: Math.random() * 0.6,
      specialCooldown: type === "juggernaut" ? 3.5 : Math.random() * 1.2,
      chargeRemaining: 0,
      hitFlash: 0,
    });
  }

  private randomSpawnPoint() {
    const side = Math.floor(Math.random() * 4);
    const offset = THREE.MathUtils.randFloat(-15.5, 15.5);
    if (side === 0) return new THREE.Vector3(-17.8, 0, offset);
    if (side === 1) return new THREE.Vector3(17.8, 0, offset);
    if (side === 2) return new THREE.Vector3(offset, 0, -17.8);
    return new THREE.Vector3(offset, 0, 17.8);
  }

  private createPickup(type: PickupId, position: THREE.Vector3, value: number) {
    const group = new THREE.Group();
    const definition = PICKUPS[type];
    if (type === "coin") {
      const coin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 0.09, 12),
        new THREE.MeshStandardMaterial({ color: definition.color, emissive: 0x57440a, metalness: 0.65, roughness: 0.28 }),
      );
      coin.rotation.x = Math.PI / 2;
      group.add(coin);
    } else {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(type === "health" ? 0.7 : 0.88, 0.38, 0.62),
        new THREE.MeshStandardMaterial({ color: definition.color, emissive: type === "ammo" ? 0x092941 : 0x471014, roughness: 0.45 }),
      );
      group.add(box);
      if (type === "health") {
        const crossMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.06, 0.1), crossMaterial);
        const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.38), crossMaterial);
        crossA.position.y = crossB.position.y = 0.22;
        group.add(crossA, crossB);
      }
    }
    const glow = new THREE.PointLight(definition.color, 4, 3.5, 2);
    glow.position.y = 0.6;
    group.add(glow);
    group.position.set(position.x, 0.55, position.z);
    this.scene.add(group);
    this.pickups.push({ type, mesh: group, value, age: Math.random() * 5 });
  }

  private fire() {
    const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.cooldown > 0) return;
    if (state.magazine <= 0) {
      this.reload();
      return;
    }
    state.magazine -= 1;
    state.cooldown = 1 / stats.fireRate;
    this.audio.tone(id === "shotgun" ? 95 : id === "smg" ? 180 : 135, id === "shotgun" ? 0.12 : 0.045, id === "shotgun" ? 0.18 : 0.08, "sawtooth");
    const origin = this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.8, 1.25, this.aim.z * 0.8));
    for (let pellet = 0; pellet < stats.pellets; pellet += 1) {
      const angle = Math.atan2(this.aim.z, this.aim.x) + THREE.MathUtils.randFloatSpread(stats.spread * 2);
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(id === "shotgun" ? 0.075 : 0.065, 6, 4),
        new THREE.MeshBasicMaterial({ color: stats.color }),
      );
      mesh.position.copy(origin);
      this.scene.add(mesh);
      this.projectiles.push({ mesh, velocity: direction.multiplyScalar(id === "shotgun" ? 30 : 37), damage: stats.damage, life: 1.35, enemy: false });
    }
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(id === "shotgun" ? 0.35 : 0.22, 8, 5),
      new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: 0.9 }),
    );
    flash.position.copy(origin).addScaledVector(this.aim, 0.2);
    this.scene.add(flash);
    this.effects.push({ mesh: flash, life: 0.06, maxLife: 0.06 });
    if (state.magazine === 0 && state.reserve > 0) window.setTimeout(() => this.reload(), 110);
  }

  private reload() {
    const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.magazine >= stats.magazine || state.reserve <= 0) return;
    state.reloading = stats.reload;
    this.audio.tone(310, 0.08, 0.035, "triangle");
  }

  private switchWeapon(direction = 1) {
    if (this.loadout.length < 2) return;
    this.activeWeaponIndex = (this.activeWeaponIndex + direction + this.loadout.length) % this.loadout.length;
    this.audio.tone(480, 0.05, 0.04, "triangle");
    this.emitHud(true);
  }

  private updatePlayer(dt: number) {
    const movement = new THREE.Vector3(
      (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      0,
      (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0),
    );
    if (movement.lengthSq() > 0) movement.normalize();
    const speed = this.dashRemaining > 0 ? 16.5 : this.moveSpeed;
    const velocity = movement.multiplyScalar(speed);
    this.playerBody.setLinvel({ x: velocity.x, y: 0, z: velocity.z }, true);
    this.physics.timestep = dt;
    this.physics.step();
    const translation = this.playerBody.translation();
    if (Math.abs(translation.x) > ARENA_LIMIT || Math.abs(translation.z) > ARENA_LIMIT) {
      this.playerBody.setTranslation({ x: THREE.MathUtils.clamp(translation.x, -ARENA_LIMIT, ARENA_LIMIT), y: 0.72, z: THREE.MathUtils.clamp(translation.z, -ARENA_LIMIT, ARENA_LIMIT) }, true);
    }
    const position = this.playerBody.translation();
    this.playerMesh.position.set(position.x, 0, position.z);
    this.playerMesh.rotation.y = Math.atan2(this.aim.x, this.aim.z);

    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.dashRemaining = Math.max(0, this.dashRemaining - dt);
    if (this.firing) this.fire();

    for (const [id, state] of this.weaponStates) {
      state.cooldown = Math.max(0, state.cooldown - dt);
      if (state.reloading > 0) {
        state.reloading = Math.max(0, state.reloading - dt);
        if (state.reloading === 0) {
          const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
          const needed = stats.magazine - state.magazine;
          const transfer = Math.min(needed, state.reserve);
          state.magazine += transfer;
          state.reserve -= transfer;
          this.audio.tone(440, 0.06, 0.03, "triangle");
        }
      }
    }
  }

  private updateAim() {
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.aim.copy(hit.sub(this.playerMesh.position)).setY(0);
      if (this.aim.lengthSq() > 0.01) this.aim.normalize();
    }
  }

  private updateWave(dt: number) {
    if (!this.waveActive) return;
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemies.length < 50) {
        const type = this.spawnQueue.shift();
        if (type) this.spawnEnemy(type);
        this.spawnTimer = WAVES[this.wave - 1].spawnInterval;
      }
    } else if (this.enemies.length === 0) {
      this.waveActive = false;
      this.pause();
      if (this.wave >= 10) this.callbacks.onVictory();
      else this.callbacks.onWaveComplete(this.wave);
    }
  }

  private updateEnemies(dt: number) {
    const playerPosition = this.playerMesh.position;
    for (let index = 0; index < this.enemies.length; index += 1) {
      const enemy = this.enemies[index];
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      enemy.specialCooldown = Math.max(0, enemy.specialCooldown - dt);
      enemy.chargeRemaining = Math.max(0, enemy.chargeRemaining - dt);
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);

      const towardPlayer = playerPosition.clone().sub(enemy.mesh.position).setY(0);
      const distance = towardPlayer.length();
      if (distance > 0.01) towardPlayer.normalize();
      enemy.mesh.rotation.y = Math.atan2(towardPlayer.x, towardPlayer.z);

      if (enemy.type === "spitter" && distance < enemy.definition.attackRange && distance > 3.8) {
        if (enemy.attackCooldown <= 0) {
          this.spawnEnemyProjectile(enemy, towardPlayer);
          enemy.attackCooldown = enemy.definition.attackCooldown;
        }
      } else {
        if (enemy.type === "juggernaut" && enemy.specialCooldown <= 0 && distance > 4) {
          enemy.chargeRemaining = 1.05;
          enemy.specialCooldown = 5.8;
          this.announcement = "Juggernaut charge incoming";
          this.announcementTimer = 1.15;
        }
        if (distance <= enemy.definition.attackRange) {
          if (enemy.attackCooldown <= 0) {
            this.damagePlayer(enemy.definition.damage);
            enemy.attackCooldown = enemy.definition.attackCooldown;
          }
        } else {
          const speed = enemy.definition.speed * (enemy.chargeRemaining > 0 ? 3.4 : 1);
          const separation = new THREE.Vector3();
          for (let otherIndex = 0; otherIndex < this.enemies.length; otherIndex += 1) {
            if (index === otherIndex) continue;
            const other = this.enemies[otherIndex];
            const delta = enemy.mesh.position.clone().sub(other.mesh.position).setY(0);
            const gap = delta.length();
            if (gap > 0 && gap < enemy.definition.radius + other.definition.radius + 0.25) {
              separation.add(delta.normalize().multiplyScalar((1.6 - gap) * 0.5));
            }
          }
          const direction = towardPlayer.add(separation).normalize();
          const candidate = enemy.mesh.position.clone().addScaledVector(direction, speed * dt);
          const resolved = this.resolveEnemyPosition(candidate, enemy.definition.radius);
          enemy.mesh.position.copy(resolved);
        }
      }
      const bob = Math.sin(performance.now() * 0.008 + index) * 0.035;
      enemy.mesh.position.y = bob;
    }
  }

  private spawnEnemyProjectile(enemy: EnemyEntity, direction: THREE.Vector3) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xa5ff4d }),
    );
    mesh.position.copy(enemy.mesh.position).add(new THREE.Vector3(0, 1.2, 0));
    this.scene.add(mesh);
    this.projectiles.push({ mesh, velocity: direction.clone().multiplyScalar(8.5), damage: enemy.definition.damage, life: 2.2, enemy: true });
    this.audio.tone(155, 0.16, 0.04, "sine");
  }

  private updateProjectiles(dt: number) {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= dt;
      projectile.mesh.position.addScaledVector(projectile.velocity, dt);
      if (projectile.life <= 0 || Math.abs(projectile.mesh.position.x) > 21 || Math.abs(projectile.mesh.position.z) > 21) {
        this.removeProjectile(index);
        continue;
      }
      if (projectile.enemy) {
        if (projectile.mesh.position.distanceTo(this.playerMesh.position.clone().setY(1)) < 0.85) {
          this.damagePlayer(projectile.damage);
          this.removeProjectile(index);
        }
        continue;
      }

      const barrel = this.barrels.find((item) => item.active && item.mesh.position.distanceTo(projectile.mesh.position.clone().setY(0)) < 0.72);
      if (barrel) {
        this.explodeBarrel(barrel);
        this.removeProjectile(index);
        continue;
      }
      if (this.pointInsideObstacle(projectile.mesh.position.x, projectile.mesh.position.z)) {
        this.removeProjectile(index);
        continue;
      }
      let hit = false;
      for (let enemyIndex = this.enemies.length - 1; enemyIndex >= 0; enemyIndex -= 1) {
        const enemy = this.enemies[enemyIndex];
        const dx = projectile.mesh.position.x - enemy.mesh.position.x;
        const dz = projectile.mesh.position.z - enemy.mesh.position.z;
        if (dx * dx + dz * dz <= (enemy.definition.radius + 0.18) ** 2) {
          this.damageEnemy(enemy, projectile.damage, enemyIndex);
          this.removeProjectile(index);
          hit = true;
          break;
        }
      }
      if (hit) continue;
    }
  }

  private damageEnemy(enemy: EnemyEntity, damage: number, index: number) {
    enemy.health -= damage;
    enemy.hitFlash = 0.08;
    this.audio.tone(220 + Math.random() * 60, 0.025, 0.025, "square");
    if (enemy.health <= 0) this.killEnemy(index);
  }

  private killEnemy(index: number) {
    const enemy = this.enemies[index];
    if (!enemy) return;
    const position = enemy.mesh.position.clone();
    this.scene.remove(enemy.mesh);
    this.enemies.splice(index, 1);
    this.createPickup("coin", position, enemy.definition.reward);
    if (Math.random() < 0.16 || (this.activeAmmoTotal() < 5 && Math.random() < 0.7)) this.createPickup("ammo", position.clone().add(new THREE.Vector3(0.55, 0, 0)), 1);
    if (Math.random() < 0.065) this.createPickup("health", position.clone().add(new THREE.Vector3(-0.55, 0, 0)), 25);
    const burst = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.42, 16),
      new THREE.MeshBasicMaterial({ color: 0xff6448, transparent: true, opacity: 0.65, side: THREE.DoubleSide }),
    );
    burst.rotation.x = -Math.PI / 2;
    burst.position.copy(position).setY(0.06);
    this.scene.add(burst);
    this.effects.push({ mesh: burst, life: 0.35, maxLife: 0.35 });
  }

  private explodeBarrel(barrel: BarrelEntity) {
    barrel.active = false;
    barrel.mesh.visible = false;
    const position = barrel.mesh.position.clone();
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      const distance = enemy.mesh.position.distanceTo(position);
      if (distance < 5.4) this.damageEnemy(enemy, 190 * (1 - distance / 6.2), index);
    }
    const blast = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.52, wireframe: true }),
    );
    blast.position.copy(position).setY(0.9);
    this.scene.add(blast);
    this.effects.push({ mesh: blast, life: 0.48, maxLife: 0.48 });
    this.audio.tone(55, 0.35, 0.24, "sawtooth");
  }

  private updatePickups(dt: number) {
    for (let index = this.pickups.length - 1; index >= 0; index -= 1) {
      const pickup = this.pickups[index];
      pickup.age += dt;
      pickup.mesh.rotation.y += dt * 2.2;
      pickup.mesh.position.y = 0.58 + Math.sin(pickup.age * 3.2) * 0.12;
      const delta = this.playerMesh.position.clone().sub(pickup.mesh.position).setY(0);
      const distance = delta.length();
      if (pickup.type === "coin" && distance < this.pickupRadius && distance > 0.05) {
        pickup.mesh.position.addScaledVector(delta.normalize(), dt * (4 + (this.pickupRadius - distance) * 2));
      }
      if (distance < 1.05) {
        if (pickup.type === "coin") {
          this.callbacks.onCoins(pickup.value);
          this.audio.tone(760, 0.08, 0.05, "sine");
        } else if (pickup.type === "ammo") {
          const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
          const state = this.weaponStates.get(id);
          if (state) {
            const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
            state.reserve = Math.min(stats.reserve, state.reserve + Math.ceil(stats.reserve * 0.34));
          }
          this.audio.tone(590, 0.1, 0.05, "triangle");
        } else {
          this.playerHealth = Math.min(this.maxHealth, this.playerHealth + pickup.value);
          this.audio.tone(410, 0.18, 0.05, "sine");
        }
        this.scene.remove(pickup.mesh);
        this.pickups.splice(index, 1);
      }
    }
  }

  private updateEffects(dt: number) {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.life -= dt;
      const progress = 1 - effect.life / effect.maxLife;
      effect.mesh.scale.setScalar(1 + progress * 3.8);
      const material = effect.mesh.material as THREE.Material & { opacity?: number };
      if (typeof material.opacity === "number") material.opacity = Math.max(0, 1 - progress);
      if (effect.life <= 0) {
        this.scene.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        (effect.mesh.material as THREE.Material).dispose();
        this.effects.splice(index, 1);
      }
    }
  }

  private damagePlayer(amount: number) {
    if (this.dashRemaining > 0 || this.playerHealth <= 0) return;
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.audio.tone(70, 0.12, 0.12, "sawtooth");
    this.container.classList.remove("is-hit");
    void this.container.offsetWidth;
    this.container.classList.add("is-hit");
    if (this.playerHealth <= 0) {
      this.pause();
      this.emitHud(true);
      this.callbacks.onDeath();
    }
  }

  private activeAmmoTotal() {
    const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
    const state = this.weaponStates.get(id);
    return state ? state.magazine + state.reserve : 0;
  }

  private resolveEnemyPosition(position: THREE.Vector3, radius: number) {
    position.x = THREE.MathUtils.clamp(position.x, -ARENA_LIMIT, ARENA_LIMIT);
    position.z = THREE.MathUtils.clamp(position.z, -ARENA_LIMIT, ARENA_LIMIT);
    for (const obstacle of this.obstacles) {
      const dx = position.x - obstacle.x;
      const dz = position.z - obstacle.z;
      const overlapX = obstacle.hx + radius - Math.abs(dx);
      const overlapZ = obstacle.hz + radius - Math.abs(dz);
      if (overlapX > 0 && overlapZ > 0) {
        if (overlapX < overlapZ) position.x += Math.sign(dx || 1) * overlapX;
        else position.z += Math.sign(dz || 1) * overlapZ;
      }
    }
    return position;
  }

  private pointInsideObstacle(x: number, z: number) {
    return this.obstacles.some((obstacle) => Math.abs(x - obstacle.x) <= obstacle.hx && Math.abs(z - obstacle.z) <= obstacle.hz);
  }

  private removeProjectile(index: number) {
    const projectile = this.projectiles[index];
    if (!projectile) return;
    this.scene.remove(projectile.mesh);
    projectile.mesh.geometry.dispose();
    (projectile.mesh.material as THREE.Material).dispose();
    this.projectiles.splice(index, 1);
  }

  private emitHud(force = false) {
    if (!force && this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
    const state = this.weaponStates.get(id);
    const boss = this.enemies.find((enemy) => enemy.type === "juggernaut");
    this.callbacks.onHud({
      health: this.playerHealth,
      maxHealth: this.maxHealth,
      wave: this.wave,
      enemies: this.enemies.length + this.spawnQueue.length,
      weapon: id,
      weaponName: WEAPONS[id].name,
      magazine: state?.magazine ?? 0,
      reserve: state?.reserve ?? 0,
      reloading: state?.reloading ?? 0,
      dash: 1 - Math.min(1, this.dashCooldown / 2.8),
      bossHealth: boss?.health,
      bossMaxHealth: boss?.maxHealth,
      announcement: this.announcementTimer > 0 ? this.announcement : undefined,
    });
  }

  private step(dt: number) {
    this.hudTimer -= dt;
    this.announcementTimer = Math.max(0, this.announcementTimer - dt);
    this.updateAim();
    this.updatePlayer(dt);
    this.updateWave(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.emitHud();
  }

  private animate = () => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    const delta = Math.min(0.05, this.clock.getDelta());
    if (!this.paused) {
      this.accumulator = Math.min(this.accumulator + delta, FIXED_STEP * 5);
      while (this.accumulator >= FIXED_STEP) {
        this.step(FIXED_STEP);
        this.accumulator -= FIXED_STEP;
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  private resize = () => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;
    const view = aspect < 1 ? 27 : 23;
    this.camera.left = -view * aspect / 2;
    this.camera.right = view * aspect / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.near = 0.1;
    this.camera.far = 100;
    this.camera.position.set(0, 25, 20);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  private onPointerDown = (event: PointerEvent) => {
    if (event.button === 0) this.firing = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.firing = false;
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyR") this.reload();
    if (event.code === "KeyQ") this.switchWeapon();
    if (event.code === "Digit1" && this.loadout[0]) { this.activeWeaponIndex = 0; this.emitHud(true); }
    if (event.code === "Digit2" && this.loadout[1]) { this.activeWeaponIndex = 1; this.emitHud(true); }
    if ((event.code === "ShiftLeft" || event.code === "ShiftRight" || event.code === "Space") && this.dashCooldown <= 0) {
      this.dashRemaining = 0.18;
      this.dashCooldown = 2.8;
      this.audio.tone(260, 0.08, 0.045, "sine");
    }
    if (event.code === "Escape") this.callbacks.onPauseToggle();
    if (event.code === "KeyK" && this.qaMode) {
      for (const enemy of this.enemies) this.scene.remove(enemy.mesh);
      this.enemies = [];
      this.spawnQueue = [];
      this.emitHud(true);
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private bindEvents() {
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  private unbindEvents() {
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
  }

  private shuffle<T>(values: T[]) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1));
      [values[index], values[other]] = [values[other], values[index]];
    }
  }
}
