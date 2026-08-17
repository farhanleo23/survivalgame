import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { ENEMIES, getWeaponStats, PICKUPS, WAVES, WEAPONS } from "./config";
import { GameAudio } from "./audio";
import { VisualFactory, type CharacterRig } from "./visuals";
import { GRAPHICS_BUDGETS, WEAPON_VISUALS } from "./visual-registry";
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
  rig: CharacterRig;
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
  mesh: THREE.Object3D;
  life: number;
  maxLife: number;
  mode?: "expand" | "particle" | "smoke" | "flash";
  velocity?: THREE.Vector3;
  spin?: THREE.Vector3;
}

interface Obstacle {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

const FIXED_STEP = 1 / 60;
const ARENA_LIMIT = 18.5;
const MAX_ACTIVE_ENEMIES = 36;
const CROWD_CELL_SIZE = 2.5;

await RAPIER.init();

export class GameEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;
  private profile: ProfileV1;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private renderer: THREE.WebGLRenderer;
  private visuals: VisualFactory;
  private timer = new THREE.Timer();
  private accumulator = 0;
  private frame = 0;
  private paused = true;
  private destroyed = false;
  private hudTimer = 0;
  private announcement = "";
  private announcementTimer = 0;
  private pixelRatio = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 1.5);
  private frameTimeAverage = FIXED_STEP;
  private performanceSampleTime = 0;
  private qaFramesRendered = 0;
  private visualQaMode =
    typeof window !== "undefined" &&
    window.location.hostname === "localhost" &&
    new URLSearchParams(window.location.search).has("visualqa");
  private stressMode =
    typeof window !== "undefined" &&
    window.location.hostname === "localhost" &&
    new URLSearchParams(window.location.search).has("stress");
  private visualQaRigs: CharacterRig[] = [];

  private physics = new RAPIER.World({ x: 0, y: 0, z: 0 });
  private playerBody: RAPIER.RigidBody;
  private playerMesh = new THREE.Group();
  private playerRig: CharacterRig | null = null;
  private cameraLook = new THREE.Vector3();
  private cameraShake = 0;
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
  private enemyCandidate = new THREE.Vector3();

  constructor(container: HTMLElement, profile: ProfileV1, callbacks: EngineCallbacks) {
    this.container = container;
    this.profile = profile;
    this.callbacks = callbacks;
    this.loadout = profile.equippedLoadout.length ? [...profile.equippedLoadout] : ["pistol"];
    this.pixelRatio = Math.min(window.devicePixelRatio, GRAPHICS_BUDGETS[profile.settings.graphicsQuality].maxPixelRatio);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    if (this.qaMode) this.pixelRatio = 0.5;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = !this.qaMode;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Deadwave evacuation depot combat arena");
    this.renderer.domElement.dataset.visualMode = this.visualQaMode ? "gallery" : this.stressMode ? "stress" : "gameplay";
    this.container.appendChild(this.renderer.domElement);
    this.timer.connect(document);
    this.visuals = new VisualFactory(this.renderer, profile.settings.graphicsQuality);

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
  }

  start(wave = 1) {
    this.wave = wave;
    this.audio.configure(this.profile.settings);
    this.audio.start();
    this.paused = false;
    if (this.visualQaMode) this.setupVisualQaScene();
    else if (this.stressMode) this.setupStressScene();
    else this.startWave(wave);
    this.timer.reset();
    this.scheduleFrame();
    void this.visuals.ready();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.clearInputState();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.audio.setPaused(true);
  }

  resume() {
    if (this.destroyed || !this.paused) return;
    this.paused = false;
    this.audio.setPaused(false);
    this.accumulator = 0;
    this.qaFramesRendered = 0;
    this.timer.reset();
    this.scheduleFrame();
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
    const qualityChanged = profile.settings.graphicsQuality !== this.profile.settings.graphicsQuality;
    this.profile = profile;
    this.audio.configure(profile.settings);
    this.applyPerks(profile.perkRanks);
    if (qualityChanged) this.applyGraphicsQuality();
    for (const id of profile.ownedWeapons) this.ensureWeaponState(id);
  }

  equipLoadout(ids: WeaponId[]) {
    this.loadout = ids.slice(0, 2);
    if (!this.loadout.length) this.loadout = ["pistol"];
    this.activeWeaponIndex = 0;
    for (const id of this.loadout) this.ensureWeaponState(id);
    if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, this.loadout[0] ?? "pistol");
    this.emitHud(true);
  }

  refillAmmo() {
    let changed = false;
    for (const id of new Set(this.loadout)) {
      const state = this.weaponStates.get(id);
      if (!state) continue;
      const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
      if (state.magazine === stats.magazine && state.reserve === stats.reserve && state.reloading === 0) continue;
      state.magazine = stats.magazine;
      state.reserve = stats.reserve;
      state.reloading = 0;
      changed = true;
    }
    if (!changed) return false;
    this.audio.tone(620, 0.12, 0.06, "sine");
    this.emitHud(true);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.unbindEvents();
    this.audio.stop();
    this.timer.dispose();
    if (this.playerRig) this.visuals.disposeCharacter(this.playerRig);
    for (const enemy of this.enemies) this.visuals.disposeCharacter(enemy.rig);
    for (const rig of this.visualQaRigs) this.visuals.disposeCharacter(rig);
    this.visuals.dispose(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.physics.free();
  }

  private setupScene() {
    this.scene.background = new THREE.Color(0x09100f);
    this.scene.fog = new THREE.FogExp2(0x0b1211, 0.018);

    const ambient = new THREE.HemisphereLight(0xb8d8d2, 0x101512, 0.92);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xd9eeea, 2.85);
    key.name = "tactical-key-light";
    key.position.set(-11, 22, 9);
    key.castShadow = true;
    const shadowSize = GRAPHICS_BUDGETS[this.profile.settings.graphicsQuality].shadowMapSize;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.camera.left = -20;
    key.shadow.camera.right = 20;
    key.shadow.camera.top = 20;
    key.shadow.camera.bottom = -20;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.035;
    key.shadow.radius = 2;
    this.scene.add(key);
    const coldFill = new THREE.PointLight(0x59dcb7, 14, 19, 2);
    coldFill.position.set(-13, 5, 12);
    const warning = new THREE.PointLight(0xff542f, 22, 20, 2);
    warning.position.set(14, 4.5, -11);
    this.scene.add(coldFill, warning);

    this.scene.add(this.visuals.createGround());
    this.visuals.addPerimeter(this.scene);
    this.visuals.addSetDressing(this.scene);

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
    const structure = this.visuals.createDepotStructure(width, depth, color);
    structure.position.set(x, 0, z);
    this.scene.add(structure);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2), body);
    this.obstacles.push({ x, z, hx: width / 2, hz: depth / 2 });
  }

  private addBarricade(x: number, z: number, width: number, depth: number, rotation: number) {
    const barricade = this.visuals.createBarricade(width, depth);
    barricade.position.set(x, 0, z);
    barricade.rotation.y = rotation;
    this.scene.add(barricade);
    // The conservative AABB keeps both the player and horde clear of angled cover.
    const hx = Math.abs(Math.cos(rotation) * width / 2) + Math.abs(Math.sin(rotation) * depth / 2);
    const hz = Math.abs(Math.sin(rotation) * width / 2) + Math.abs(Math.cos(rotation) * depth / 2);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.4, z).setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) }));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, 0.4, depth / 2), body);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addFloodlight(x: number, z: number, color: number) {
    const fixture = this.visuals.createFloodlight(color);
    fixture.position.set(x, 0, z);
    this.scene.add(fixture);
    const light = new THREE.SpotLight(color, 52, 22, Math.PI / 5, 0.5, 1.5);
    light.position.set(x, 4.75, z);
    light.target.position.set(x * 0.35, 0, z * 0.35);
    this.scene.add(light, light.target);
  }

  private addBarrel(x: number, z: number) {
    const group = this.visuals.createBarrel();
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.barrels.push({ mesh: group, active: true });
  }

  private createPlayer() {
    this.playerRig = this.visuals.createPlayer(this.loadout[this.activeWeaponIndex] ?? "pistol");
    this.playerMesh = this.playerRig.root;
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
    const rig = this.visuals.createEnemy(type, definition);
    const group = rig.root;
    const spawn = this.randomSpawnPoint();
    group.position.copy(spawn);
    this.scene.add(group);
    this.enemies.push({
      type,
      definition,
      mesh: group,
      rig,
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
      const shardMaterial = new THREE.MeshStandardMaterial({ color: definition.color, emissive: 0x8b5a0a, emissiveIntensity: 1.25, metalness: 0.72, roughness: 0.24 });
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.29, 0), shardMaterial);
      shard.scale.y = 1.35;
      const orbit = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.025, 6, 24), new THREE.MeshBasicMaterial({ color: 0xffd46b, transparent: true, opacity: 0.64 }));
      orbit.rotation.x = Math.PI / 2;
      group.add(shard, orbit);
    } else {
      const shell = new THREE.Mesh(
        new THREE.BoxGeometry(type === "health" ? 0.72 : 0.92, 0.4, 0.64),
        new THREE.MeshStandardMaterial({ color: type === "health" ? 0x7a2427 : 0x274750, emissive: type === "ammo" ? 0x0a4051 : 0x551216, emissiveIntensity: 0.6, roughness: 0.42, metalness: 0.42 }),
      );
      const band = new THREE.Mesh(new THREE.BoxGeometry(type === "health" ? 0.76 : 0.96, 0.11, 0.68), new THREE.MeshStandardMaterial({ color: definition.color, emissive: definition.color, emissiveIntensity: 0.72, roughness: 0.38 }));
      group.add(shell, band);
      if (type === "health") {
        const crossMaterial = new THREE.MeshBasicMaterial({ color: 0xfff5e9 });
        const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.035, 0.11), crossMaterial);
        const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.035, 0.4), crossMaterial);
        crossA.position.y = crossB.position.y = 0.225;
        group.add(crossA, crossB);
      } else {
        const cartridgeMaterial = new THREE.MeshStandardMaterial({ color: 0xe3b95e, metalness: 0.82, roughness: 0.28 });
        for (const x of [-0.25, 0, 0.25]) {
          const cartridge = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.34, 8), cartridgeMaterial);
          cartridge.position.set(x, 0.27, 0);
          group.add(cartridge);
        }
      }
    }
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.3, 1.8, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: definition.color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.y = 0.85;
    group.add(beam);
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
    const weaponVisual = WEAPON_VISUALS[id];
    if (state.reloading > 0 || state.cooldown > 0) return;
    if (state.magazine <= 0) {
      this.reloadWeapon(id);
      return;
    }
    state.magazine -= 1;
    state.cooldown = 1 / stats.fireRate;
    this.audio.tone(id === "shotgun" ? 95 : id === "smg" ? 180 : 135, id === "shotgun" ? 0.12 : 0.045, id === "shotgun" ? 0.18 : 0.08, "sawtooth");
    const origin = this.playerRig
      ? this.playerRig.muzzle.getWorldPosition(new THREE.Vector3())
      : this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.8, 1.25, this.aim.z * 0.8));
    for (let pellet = 0; pellet < stats.pellets; pellet += 1) {
      const angle = Math.atan2(this.aim.z, this.aim.x) + THREE.MathUtils.randFloatSpread(stats.spread * 2);
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(id === "shotgun" ? 0.035 : 0.027, id === "shotgun" ? 0.055 : 0.038, id === "shotgun" ? 0.52 : 0.78, 8),
        new THREE.MeshBasicMaterial({ color: weaponVisual.tracerColor, transparent: true, opacity: 0.94 }),
      );
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
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
    this.cameraShake = Math.max(this.cameraShake, weaponVisual.kick);
    if (state.magazine === 0 && state.reserve > 0) this.reloadWeapon(id);
  }

  private reload() {
    const id = this.loadout[this.activeWeaponIndex] ?? "pistol";
    this.reloadWeapon(id);
  }

  private reloadWeapon(id: WeaponId) {
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
    if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, this.loadout[this.activeWeaponIndex] ?? "pistol");
    this.audio.tone(480, 0.05, 0.04, "triangle");
    this.emitHud(true);
  }

  private updatePlayer(dt: number) {
    const movement = new THREE.Vector3(
      (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      0,
      (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0),
    );
    const moving = movement.lengthSq() > 0;
    if (moving) movement.normalize();
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
    if (this.playerRig) {
      this.visuals.animateCharacter(this.playerRig, dt, moving ? speed : 0, false, 0);
      if (this.playerRig.model) {
        this.playerRig.model.rotation.z = THREE.MathUtils.lerp(
          this.playerRig.model.rotation.z,
          this.dashRemaining > 0 ? -0.13 : 0,
          1 - Math.exp(-dt * 15),
        );
      }
    }

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
      if (this.spawnTimer <= 0 && this.enemies.length < MAX_ACTIVE_ENEMIES) {
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
    const grid = new Map<string, EnemyEntity[]>();
    for (const enemy of this.enemies) {
      const cellX = Math.floor(enemy.mesh.position.x / CROWD_CELL_SIZE);
      const cellZ = Math.floor(enemy.mesh.position.z / CROWD_CELL_SIZE);
      const key = `${cellX},${cellZ}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(enemy);
      else grid.set(key, [enemy]);
    }
    for (let index = 0; index < this.enemies.length; index += 1) {
      const enemy = this.enemies[index];
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      enemy.specialCooldown = Math.max(0, enemy.specialCooldown - dt);
      enemy.chargeRemaining = Math.max(0, enemy.chargeRemaining - dt);
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);

      const toPlayerX = playerPosition.x - enemy.mesh.position.x;
      const toPlayerZ = playerPosition.z - enemy.mesh.position.z;
      const distanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ;
      const distance = Math.sqrt(distanceSquared);
      const inverseDistance = distance > 0.01 ? 1 / distance : 0;
      const towardX = toPlayerX * inverseDistance;
      const towardZ = toPlayerZ * inverseDistance;
      let facingX = towardX;
      let facingZ = towardZ;

      if (enemy.type === "spitter" && distance < enemy.definition.attackRange && distance > 3.8) {
        if (enemy.attackCooldown <= 0) {
          this.enemyCandidate.set(towardX, 0, towardZ);
          this.spawnEnemyProjectile(enemy, this.enemyCandidate);
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
          let separationX = 0;
          let separationZ = 0;
          const cellX = Math.floor(enemy.mesh.position.x / CROWD_CELL_SIZE);
          const cellZ = Math.floor(enemy.mesh.position.z / CROWD_CELL_SIZE);
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
              const nearby = grid.get(`${cellX + offsetX},${cellZ + offsetZ}`);
              if (!nearby) continue;
              for (const other of nearby) {
                if (enemy === other) continue;
                const dx = enemy.mesh.position.x - other.mesh.position.x;
                const dz = enemy.mesh.position.z - other.mesh.position.z;
                const gapSquared = dx * dx + dz * dz;
                const minimumGap = enemy.definition.radius + other.definition.radius + 0.25;
                if (gapSquared > 0.0001 && gapSquared < minimumGap * minimumGap) {
                  const gap = Math.sqrt(gapSquared);
                  const push = (minimumGap - gap) / minimumGap;
                  separationX += dx / gap * push;
                  separationZ += dz / gap * push;
                }
              }
            }
          }
          let directionX = towardX + separationX * 0.78;
          let directionZ = towardZ + separationZ * 0.78;
          const directionLength = Math.hypot(directionX, directionZ) || 1;
          directionX /= directionLength;
          directionZ /= directionLength;
          facingX = directionX;
          facingZ = directionZ;
          this.enemyCandidate.set(
            enemy.mesh.position.x + directionX * speed * dt,
            0,
            enemy.mesh.position.z + directionZ * speed * dt,
          );
          this.resolveEnemyPosition(this.enemyCandidate, enemy.definition.radius);
          enemy.mesh.position.x = this.enemyCandidate.x;
          enemy.mesh.position.z = this.enemyCandidate.z;
        }
      }
      const targetFacing = Math.atan2(facingX, facingZ);
      const facingDelta = Math.atan2(
        Math.sin(targetFacing - enemy.mesh.rotation.y),
        Math.cos(targetFacing - enemy.mesh.rotation.y),
      );
      enemy.mesh.rotation.y += facingDelta * (1 - Math.exp(-dt * 13));
      enemy.mesh.position.y = 0;
      this.visuals.animateCharacter(
        enemy.rig,
        dt,
        distance > enemy.definition.attackRange ? enemy.definition.speed * (enemy.chargeRemaining > 0 ? 2.2 : 1) : 0,
        distance <= enemy.definition.attackRange,
        enemy.hitFlash,
      );
    }
  }

  private spawnEnemyProjectile(enemy: EnemyEntity, direction: THREE.Vector3) {
    const projectileMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.21, 1),
      new THREE.MeshStandardMaterial({ color: 0x8bef47, emissive: 0x5aff1c, emissiveIntensity: 2.4, roughness: 0.28, transparent: true, opacity: 0.94 }),
    );
    projectileMesh.position.copy(enemy.mesh.position).add(new THREE.Vector3(0, 1.2, 0));
    const glow = new THREE.PointLight(0x7dff35, 4.5, 3.2, 2);
    projectileMesh.add(glow);
    this.scene.add(projectileMesh);
    this.projectiles.push({ mesh: projectileMesh, velocity: direction.clone().multiplyScalar(8.5), damage: enemy.definition.damage, life: 2.2, enemy: true });
    this.audio.tone(155, 0.16, 0.04, "sine");
  }

  private updateProjectiles(dt: number) {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= dt;
      projectile.mesh.position.addScaledVector(projectile.velocity, dt);
      if (projectile.life <= 0 || Math.abs(projectile.mesh.position.x) > 21 || Math.abs(projectile.mesh.position.z) > 21) {
        if (projectile.enemy && Math.abs(projectile.mesh.position.x) < 20 && Math.abs(projectile.mesh.position.z) < 20) this.createAcidSplash(projectile.mesh.position);
        this.removeProjectile(index);
        continue;
      }
      if (this.pointInsideObstacle(projectile.mesh.position.x, projectile.mesh.position.z)) {
        if (projectile.enemy) this.createAcidSplash(projectile.mesh.position);
        this.removeProjectile(index);
        continue;
      }
      if (projectile.enemy) {
        if (projectile.mesh.position.distanceTo(this.playerMesh.position.clone().setY(1)) < 0.85) {
          this.damagePlayer(projectile.damage);
          this.createAcidSplash(projectile.mesh.position);
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
    this.createHitBurst(enemy.mesh.position.clone().setY(1.05 * enemy.rig.scale));
    this.audio.tone(220 + Math.random() * 60, 0.025, 0.025, "square");
    if (enemy.health <= 0) this.killEnemy(index);
  }

  private killEnemy(index: number) {
    const enemy = this.enemies[index];
    if (!enemy) return;
    const position = enemy.mesh.position.clone();
    this.visuals.disposeCharacter(enemy.rig);
    this.scene.remove(enemy.mesh);
    this.enemies.splice(index, 1);
    this.visuals.addBloodDecal(this.scene, position, enemy.type === "juggernaut" ? 1.75 : enemy.type === "brute" ? 1.25 : 0.82);
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
    this.visuals.addScorchDecal(this.scene, position, 1.45);
    const blast = new THREE.Group();
    blast.position.copy(position).setY(0.82);
    const flash = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.82, 1),
      new THREE.MeshBasicMaterial({ color: 0xffc063, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const shockwave = new THREE.Mesh(
      new THREE.TorusGeometry(0.82, 0.08, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff642e, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    shockwave.rotation.x = Math.PI / 2;
    blast.add(flash, shockwave);
    const pulse = new THREE.PointLight(0xff5a28, 28, 8, 2);
    blast.add(pulse);
    this.scene.add(blast);
    this.effects.push({ mesh: blast, life: 0.42, maxLife: 0.42, mode: "expand" });
    for (let particle = 0; particle < 13; particle += 1) {
      const smoke = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.18 + Math.random() * 0.2, 0),
        new THREE.MeshBasicMaterial({ color: particle < 5 ? 0xff6a2a : 0x24201d, transparent: true, opacity: particle < 5 ? 0.86 : 0.64, depthWrite: false }),
      );
      smoke.position.copy(position).setY(0.55 + Math.random() * 0.8);
      this.scene.add(smoke);
      this.effects.push({
        mesh: smoke,
        life: 0.55 + Math.random() * 0.5,
        maxLife: 1.05,
        mode: "smoke",
        velocity: new THREE.Vector3(THREE.MathUtils.randFloatSpread(3.8), 1.1 + Math.random() * 2.1, THREE.MathUtils.randFloatSpread(3.8)),
        spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()),
      });
    }
    this.cameraShake = 0.72;
    this.audio.tone(55, 0.35, 0.24, "sawtooth");
  }

  private createHitBurst(position: THREE.Vector3) {
    const colors = [0x7d0d10, 0xa91a17, 0x461011];
    for (let particle = 0; particle < 6; particle += 1) {
      const burst = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.045 + (particle % 3) * 0.014, 0),
        new THREE.MeshBasicMaterial({ color: colors[particle % colors.length], transparent: true, opacity: 0.88 }),
      );
      burst.position.copy(position).add(new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(0.45),
        THREE.MathUtils.randFloatSpread(0.35),
        THREE.MathUtils.randFloatSpread(0.45),
      ));
      this.scene.add(burst);
      const life = 0.18 + particle * 0.025;
      this.effects.push({
        mesh: burst,
        life,
        maxLife: life,
        mode: "particle",
        velocity: new THREE.Vector3(THREE.MathUtils.randFloatSpread(2.8), 0.7 + Math.random() * 1.8, THREE.MathUtils.randFloatSpread(2.8)),
        spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      });
    }
  }

  private createAcidSplash(position: THREE.Vector3) {
    const ground = position.clone().setY(0);
    this.visuals.addAcidDecal(this.scene, ground, 0.62 + Math.random() * 0.25);
    for (let particle = 0; particle < 7; particle += 1) {
      const drop = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.035 + Math.random() * 0.045, 0),
        new THREE.MeshBasicMaterial({ color: particle % 2 ? 0xb6ff55 : 0x55d92d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
      );
      drop.position.copy(position);
      this.scene.add(drop);
      const life = 0.28 + Math.random() * 0.2;
      this.effects.push({ mesh: drop, life, maxLife: life, mode: "particle", velocity: new THREE.Vector3(THREE.MathUtils.randFloatSpread(2.4), 0.6 + Math.random() * 1.6, THREE.MathUtils.randFloatSpread(2.4)) });
    }
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
        this.visuals.disposeObject(pickup.mesh);
        this.pickups.splice(index, 1);
      }
    }
  }

  private updateEffects(dt: number) {
    const maximum = GRAPHICS_BUDGETS[this.profile.settings.graphicsQuality].maxParticles;
    while (this.effects.length > maximum) {
      const oldest = this.effects.shift();
      if (oldest) {
        oldest.mesh.removeFromParent();
        this.visuals.disposeObject(oldest.mesh);
      }
    }
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.life -= dt;
      const progress = 1 - effect.life / effect.maxLife;
      if (effect.velocity) {
        effect.mesh.position.addScaledVector(effect.velocity, dt);
        effect.velocity.y -= dt * (effect.mode === "smoke" ? 0.35 : 5.5);
        effect.velocity.multiplyScalar(Math.exp(-dt * (effect.mode === "smoke" ? 0.8 : 2.4)));
      }
      if (effect.spin) {
        effect.mesh.rotation.x += effect.spin.x * dt;
        effect.mesh.rotation.y += effect.spin.y * dt;
        effect.mesh.rotation.z += effect.spin.z * dt;
      }
      if (effect.mode === "expand" || !effect.mode) effect.mesh.scale.setScalar(1 + progress * 3.8);
      else if (effect.mode === "smoke") effect.mesh.scale.setScalar(1 + progress * 1.8);
      effect.mesh.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const effectMaterial of materials) {
          const transparentMaterial = effectMaterial as THREE.Material & { opacity?: number };
          if (typeof transparentMaterial.opacity === "number") transparentMaterial.opacity = Math.max(0, 1 - progress);
        }
      });
      if (effect.life <= 0) {
        effect.mesh.removeFromParent();
        this.visuals.disposeObject(effect.mesh);
        this.effects.splice(index, 1);
      }
    }
  }

  private damagePlayer(amount: number) {
    if (this.dashRemaining > 0 || this.playerHealth <= 0) return;
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.cameraShake = Math.max(this.cameraShake, 0.42);
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
    if (this.visualQaMode) {
      if (this.playerRig) this.visuals.animateCharacter(this.playerRig, dt, 2.4, false, 0);
      this.visualQaRigs.forEach((rig, index) => this.visuals.animateCharacter(rig, dt, index % 3 === 0 ? 6 : 2.2, index % 4 === 0, 0));
      const dust = this.scene.getObjectByName("ambient-dust");
      if (dust) dust.rotation.y += dt * 0.012;
      this.updatePickups(dt);
      this.updateEffects(dt);
      this.emitHud();
      return;
    }
    if (this.stressMode) {
      if (this.playerRig) this.visuals.animateCharacter(this.playerRig, dt, 2.2, false, 0);
      this.enemies.forEach((enemy, index) => this.visuals.animateCharacter(enemy.rig, dt, enemy.definition.speed, index % 7 === 0, 0));
      const dust = this.scene.getObjectByName("ambient-dust");
      if (dust) dust.rotation.y += dt * 0.012;
      this.updatePickups(dt);
      this.updateEffects(dt);
      this.emitHud();
      return;
    }
    this.updateAim();
    this.updatePlayer(dt);
    this.updateWave(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.updateCamera(dt);
    this.emitHud();
  }

  private updateCamera(dt: number) {
    const desired = new THREE.Vector3(
      THREE.MathUtils.clamp(this.playerMesh.position.x * 0.42, -5.8, 5.8),
      0,
      THREE.MathUtils.clamp(this.playerMesh.position.z * 0.42, -5.2, 5.2),
    );
    this.cameraLook.lerp(desired, 1 - Math.exp(-dt * 4.2));
    const shake = this.profile.settings.reducedMotion ? 0 : this.cameraShake;
    const offsetX = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;
    const offsetZ = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;
    this.camera.position.set(this.cameraLook.x + offsetX, 20, this.cameraLook.z + 17 + offsetZ);
    this.camera.lookAt(this.cameraLook.x, 0.42, this.cameraLook.z);
    this.cameraShake = Math.max(0, this.cameraShake - dt * 2.8);
    const dust = this.scene.getObjectByName("ambient-dust");
    if (dust) dust.rotation.y += dt * 0.012;
  }

  private scheduleFrame() {
    if (!this.destroyed && !this.paused && this.frame === 0) this.frame = requestAnimationFrame(this.animate);
  }

  private animate = () => {
    this.frame = 0;
    if (this.destroyed || this.paused) return;
    this.timer.update();
    const delta = Math.min(0.05, this.timer.getDelta());
    this.frameTimeAverage += (delta - this.frameTimeAverage) * 0.04;
    this.performanceSampleTime += delta;
    if (this.performanceSampleTime >= 2) {
      this.performanceSampleTime = 0;
      this.renderer.domElement.dataset.frameTimeMs = (this.frameTimeAverage * 1000).toFixed(2);
      this.renderer.domElement.dataset.drawCalls = String(this.renderer.info.render.calls);
      this.renderer.domElement.dataset.triangles = String(this.renderer.info.render.triangles);
      const maximum = Math.min(window.devicePixelRatio, GRAPHICS_BUDGETS[this.profile.settings.graphicsQuality].maxPixelRatio);
      const nextRatio = this.frameTimeAverage > 0.021
        ? Math.max(1, this.pixelRatio - 0.15)
        : this.frameTimeAverage < 0.0172
          ? Math.min(maximum, this.pixelRatio + 0.1)
          : this.pixelRatio;
      if (Math.abs(nextRatio - this.pixelRatio) > 0.01) {
        this.pixelRatio = nextRatio;
        this.renderer.setPixelRatio(this.pixelRatio);
        this.resize();
      }
    }
    this.accumulator = Math.min(this.accumulator + delta, FIXED_STEP * 5);
    while (this.accumulator >= FIXED_STEP && !this.paused) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
    }
    if (!this.qaMode || this.qaFramesRendered < 2) {
      this.renderer.render(this.scene, this.camera);
      this.qaFramesRendered += 1;
    }
    this.scheduleFrame();
  };

  private resize = () => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;
    const view = aspect < 0.8 ? 22 : 19.5;
    this.camera.left = -view * aspect / 2;
    this.camera.right = view * aspect / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.near = 0.1;
    this.camera.far = 100;
    this.camera.position.set(0, 20, 17);
    this.camera.lookAt(0, 0.42, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    if (this.paused && !this.destroyed) this.renderer.render(this.scene, this.camera);
  };

  private applyGraphicsQuality() {
    const budget = GRAPHICS_BUDGETS[this.profile.settings.graphicsQuality];
    this.pixelRatio = Math.min(window.devicePixelRatio, budget.maxPixelRatio);
    this.renderer.shadowMap.enabled = !this.qaMode;
    this.visuals.setQuality(this.profile.settings.graphicsQuality);
    const key = this.scene.getObjectByName("tactical-key-light");
    if (key instanceof THREE.DirectionalLight) {
      key.shadow.map?.dispose();
      key.shadow.mapSize.set(budget.shadowMapSize, budget.shadowMapSize);
      key.shadow.needsUpdate = true;
    }
    this.resize();
  }

  private setupVisualQaScene() {
    this.waveActive = false;
    this.spawnQueue = [];
    this.announcement = "Visual systems gallery";
    this.announcementTimer = 4;
    if (this.playerRig) {
      this.playerMesh.position.set(-7.5, 0, -4.2);
      this.playerMesh.rotation.y = 0.35;
    }
    const weapons: WeaponId[] = ["smg", "shotgun", "rifle"];
    weapons.forEach((weapon, index) => {
      const rig = this.visuals.createPlayer(weapon);
      rig.root.position.set(-2.5 + index * 3.1, 0, -4.2);
      rig.root.rotation.y = 0.35;
      this.scene.add(rig.root);
      this.visualQaRigs.push(rig);
    });
    const enemyIds: EnemyId[] = ["shambler", "runner", "spitter", "brute", "juggernaut"];
    enemyIds.forEach((id, index) => {
      const rig = this.visuals.createEnemy(id, ENEMIES[id]);
      rig.root.position.set(-7.2 + index * 3.45, 0, 3.4);
      rig.root.rotation.y = Math.PI;
      this.scene.add(rig.root);
      this.visualQaRigs.push(rig);
    });
    this.createPickup("coin", new THREE.Vector3(-3, 0, 0), 12);
    this.createPickup("ammo", new THREE.Vector3(0, 0, 0), 1);
    this.createPickup("health", new THREE.Vector3(3, 0, 0), 25);
    this.visuals.addBloodDecal(this.scene, new THREE.Vector3(-5.4, 0, 6.1), 0.75);
    this.visuals.addAcidDecal(this.scene, new THREE.Vector3(0, 0, 6.1), 0.8);
    this.visuals.addScorchDecal(this.scene, new THREE.Vector3(5.4, 0, 6.1), 0.8);
    this.emitHud(true);
  }

  private setupStressScene() {
    this.startWave(9);
    while (this.spawnQueue.length && this.enemies.length < MAX_ACTIVE_ENEMIES) {
      const type = this.spawnQueue.shift();
      if (type) this.spawnEnemy(type);
    }
    this.spawnQueue = [];
    const replaced = this.enemies.pop();
    if (replaced) this.visuals.disposeCharacter(replaced.rig);
    this.spawnEnemy("juggernaut");
    this.enemies.forEach((enemy, index) => {
      const column = index % 6;
      const row = Math.floor(index / 6);
      enemy.mesh.position.set(-8.75 + column * 3.5, 0, -8.75 + row * 3.5);
      enemy.mesh.rotation.y = Math.atan2(-enemy.mesh.position.x, -enemy.mesh.position.z);
    });
    this.announcement = "36-hostile graphics stress scene";
    this.announcementTimer = 4;
    this.emitHud(true);
  }

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.paused && event.button === 0) this.firing = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.firing = false;
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      if (!event.repeat) this.callbacks.onPauseToggle();
      return;
    }
    if (this.paused) return;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyR") this.reload();
    if (event.code === "KeyQ") this.switchWeapon();
    if (event.code === "Digit1" && this.loadout[0]) {
      this.activeWeaponIndex = 0;
      if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, this.loadout[0]);
      this.emitHud(true);
    }
    if (event.code === "Digit2" && this.loadout[1]) {
      this.activeWeaponIndex = 1;
      if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, this.loadout[1]);
      this.emitHud(true);
    }
    if ((event.code === "ShiftLeft" || event.code === "ShiftRight" || event.code === "Space") && this.dashCooldown <= 0) {
      this.dashRemaining = 0.18;
      this.dashCooldown = 2.8;
      this.audio.tone(260, 0.08, 0.045, "sine");
    }
    if (event.code === "KeyK" && this.qaMode) {
      for (const enemy of this.enemies) {
        this.visuals.disposeCharacter(enemy.rig);
        this.scene.remove(enemy.mesh);
      }
      this.enemies = [];
      this.spawnQueue = [];
      this.waveActive = false;
      this.pause();
      this.emitHud(true);
      if (this.wave >= 10) this.callbacks.onVictory();
      else this.callbacks.onWaveComplete(this.wave);
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private clearInputState() {
    this.keys.clear();
    this.firing = false;
    this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  private onFocusLost = () => {
    this.clearInputState();
    if (this.paused || this.destroyed) return;
    this.pause();
    this.callbacks.onPauseToggle();
  };

  private onVisibilityChange = () => {
    if (document.hidden) this.onFocusLost();
  };

  private onContextMenu = (event: Event) => event.preventDefault();

  private bindEvents() {
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("blur", this.onFocusLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
  }

  private unbindEvents() {
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("blur", this.onFocusLost);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("contextmenu", this.onContextMenu);
  }

  private shuffle<T>(values: T[]) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1));
      [values[index], values[other]] = [values[other], values[index]];
    }
  }
}
