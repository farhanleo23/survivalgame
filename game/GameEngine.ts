import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { ENEMIES, getWeaponStats, PICKUPS, WAVES, WEAPONS } from "./config";
import { GameAudio } from "./audio";
import { VisualFactory, type CharacterRig } from "./visuals";
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
  knockback: THREE.Vector3;
}

interface ProjectileEntity {
  mesh: THREE.Mesh | THREE.Group;
  velocity: THREE.Vector3;
  direction: THREE.Vector3;
  damage: number;
  knockback: number;
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
  fade?: boolean;
}

interface Obstacle {
  x: number;
  z: number;
  hx: number;
  hz: number;
  radius?: number;
}

const FIXED_STEP = 1 / 60;
const ARENA_LIMIT = 18.5;
const MAX_ACTIVE_ENEMIES = 36;
const CROWD_CELL_SIZE = 2.5;

await RAPIER.init();

export class GameEngine {
  private container: HTMLElement;
  private floatingLayer: HTMLElement;
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
  private comboCount = 0;
  private comboTimer = 0;
  private hitStopTimer = 0;
  private waveCleared = false;
  private extractionTimer = 0;
  private readonly extractionRequiredTime = 3.2;
  private extractionZoneMesh!: THREE.Group;
  private pixelRatio = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 1.5);
  private frameTimeAverage = FIXED_STEP;
  private performanceSampleTime = 0;
  private qaFramesRendered = 0;

  private physics = new RAPIER.World({ x: 0, y: 0, z: 0 });
  private playerBody: RAPIER.RigidBody;
  private playerMesh = new THREE.Group();
  private playerRig: CharacterRig | null = null;
  private playerVelocity = new THREE.Vector3();
  private cameraLook = new THREE.Vector3();
  private cameraRecoil = new THREE.Vector3();
  private cameraShake = 0;
  private playerHealth = 100;
  private maxHealth = 100;
  private missionElapsed = 0;
  private moveSpeed = 6.2;
  private pickupRadius = 2.2;
  private dashCooldown = 0;
  private dashRemaining = 0;
  private dashTotal = 0.22;
  private dashDirection = new THREE.Vector3(0, 0, 1);
  private aim = new THREE.Vector3(0, 0, 1);
  private mouseWorldPos = new THREE.Vector3();
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

  // Shared pre-allocated materials to eliminate shader recompilation lag
  private coinMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd34d,
    emissive: 0xffaa00,
    emissiveIntensity: 1.5,
    metalness: 0.85,
    roughness: 0.2,
  });
  private ammoMaterial = new THREE.MeshStandardMaterial({
    color: 0x62c8ff,
    emissive: 0x00b4d8,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.6,
  });
  private healthMaterial = new THREE.MeshStandardMaterial({
    color: 0xff5f66,
    emissive: 0xd90429,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.6,
  });
  private deathBurstGeometry = new THREE.RingGeometry(0.18, 0.48, 16);
  private deathBurstMaterial = new THREE.MeshBasicMaterial({ color: 0x00f5d4, transparent: true, opacity: 0.75, side: THREE.DoubleSide });

  constructor(container: HTMLElement, profile: ProfileV1, callbacks: EngineCallbacks) {
    this.container = container;
    this.profile = profile;
    this.callbacks = callbacks;
    this.loadout = profile.equippedLoadout.length ? [...profile.equippedLoadout] : ["pistol"];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    if (this.qaMode) this.pixelRatio = 0.5;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = !this.qaMode;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.36;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Deadwave evacuation depot combat arena");
    this.container.appendChild(this.renderer.domElement);

    this.floatingLayer = document.createElement("div");
    this.floatingLayer.className = "floating-hud-layer";
    this.container.appendChild(this.floatingLayer);

    this.timer.connect(document);
    this.visuals = new VisualFactory(this.renderer);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.72, 0)
      .lockRotations()
      .setLinearDamping(0);
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
    this.startWave(wave);
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
    this.profile = profile;
    this.audio.configure(profile.settings);
    this.applyPerks(profile.perkRanks);
    for (const id of profile.ownedWeapons) this.ensureWeaponState(id);
    if (profile.equippedLoadout && profile.equippedLoadout.length) {
      this.loadout = [...profile.equippedLoadout];
    } else if (profile.ownedWeapons && profile.ownedWeapons.length) {
      this.loadout = [...profile.ownedWeapons];
    }
    this.emitHud(true);
  }

  equipLoadout(ids: WeaponId[]) {
    this.loadout = ids.slice(0, 2);
    if (!this.loadout.length) this.loadout = this.profile.ownedWeapons.length ? [...this.profile.ownedWeapons] : ["pistol"];
    this.activeWeaponIndex = 0;
    for (const id of this.loadout) this.ensureWeaponState(id);
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
    this.audio.playReload();
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
    this.visuals.dispose(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.floatingLayer.remove();
    this.physics.free();
  }

  private setupScene() {
    // Warm industrial warehouse background & atmosphere
    this.scene.background = new THREE.Color(0x181512);
    this.scene.fog = new THREE.FogExp2(0x181512, 0.012);

    // Warm tungsten ceiling ambient illumination with warm floor bounce
    const ambient = new THREE.HemisphereLight(0xffeedd, 0x3d3028, 2.2);
    this.scene.add(ambient);

    // Strong overhead directional sunlight/floodlight
    const key = new THREE.DirectionalLight(0xffecd0, 3.8);
    key.position.set(-12, 24, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -24;
    key.shadow.camera.right = 24;
    key.shadow.camera.top = 24;
    key.shadow.camera.bottom = -24;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.035;
    key.shadow.radius = 2;
    this.scene.add(key);

    this.scene.add(this.visuals.createGround());
    this.visuals.addPerimeter(this.scene);
    this.visuals.addSetDressing(this.scene);

    // 1. Glowing furnace heaters on stands (matching screenshot left & right)
    this.addFurnaceBeacon(-11.5, 5.5);
    this.addFurnaceBeacon(12.5, -4.5);

    // 2. Glowing toxic green slime pools
    this.addSlimePool(-6.5, -7.5, 1.8);
    this.addSlimePool(7.5, 6.5, 1.6);
    this.addToxicVat(-12.5, -9.5);
    this.addToxicVat(9.5, 9.2);

    // 3. Concrete traffic barricades with hazard stripes & cones
    this.addTrafficBarricade(-2.5, 2.5, -0.2);
    this.addTrafficBarricade(3.8, -3.2, 0.35);
    this.addTrafficCone(-4.2, 3.2);
    this.addTrafficCone(-1.2, 2.4);
    this.addTrafficCone(2.6, -3.8);
    this.addPallet(6.5, -2.5);

    // 4. Generators and barrels
    this.addGenerator(-10.6, 7.9);
    this.addGenerator(10.9, -8.5);
    this.addBarrel(-3.5, -2.5);
    this.addBarrel(5.5, 2.2);
    this.addBarrel(11.5, -1.5);
    this.addBarrel(-13.5, 1.8);

    this.extractionZoneMesh = this.visuals.createExtractionZone();
    this.extractionZoneMesh.position.set(0, 0, 0);
    this.extractionZoneMesh.visible = false;
    this.scene.add(this.extractionZoneMesh);
  }

  private addFurnaceBeacon(x: number, z: number) {
    const beacon = this.visuals.createFurnaceBeacon();
    beacon.position.set(x, 0, z);
    this.scene.add(beacon);
    const radius = 0.6;
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.8, z));
    this.physics.createCollider(RAPIER.ColliderDesc.cylinder(0.8, radius), body);
    this.obstacles.push({ x, z, hx: radius, hz: radius, radius });
  }

  private addTrafficBarricade(x: number, z: number, rotation = 0) {
    const barricade = this.visuals.createTrafficBarricade(2.4);
    barricade.position.set(x, 0, z);
    barricade.rotation.y = rotation;
    this.scene.add(barricade);
    const hx = 1.2;
    const hz = 0.3;
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, 0.39, z)
        .setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) }),
    );
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, 0.39, hz), body);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addTrafficCone(x: number, z: number) {
    const cone = this.visuals.createTrafficCone();
    cone.position.set(x, 0, z);
    this.scene.add(cone);
  }

  private addPallet(x: number, z: number) {
    const pallet = this.visuals.createPallet();
    pallet.position.set(x, 0, z);
    this.scene.add(pallet);
  }

  private addSlimePool(x: number, z: number, radius = 1.4) {
    const pool = this.visuals.createSlimePool(radius);
    pool.position.set(x, 0, z);
    this.scene.add(pool);
  }

  private addToxicVat(x: number, z: number) {
    const vat = this.visuals.createToxicVat();
    vat.position.set(x, 0, z);
    this.scene.add(vat);
    const radius = 1.35;
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 1.35, z));
    this.physics.createCollider(RAPIER.ColliderDesc.cylinder(1.35, radius), body);
    this.obstacles.push({ x, z, hx: radius, hz: radius, radius });
  }

  private addGenerator(x: number, z: number) {
    const gen = this.visuals.createGenerator();
    gen.position.set(x, 0, z);
    this.scene.add(gen);
    const hx = 1.3;
    const hz = 0.85;
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 1.0, z));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, 1.0, hz), body);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addObstacle(x: number, z: number, width: number, depth: number, color: number) {
    const height = 2.3;
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
    const hx = Math.abs(Math.cos(rotation) * width / 2) + Math.abs(Math.sin(rotation) * depth / 2);
    const hz = Math.abs(Math.sin(rotation) * width / 2) + Math.abs(Math.cos(rotation) * depth / 2);
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, 0.42, z)
        .setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) }),
    );
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, 0.42, depth / 2), body);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addFloodlight(x: number, z: number, color: number) {
    const fixture = this.visuals.createFloodlight(color);
    fixture.position.set(x, 0, z);
    this.scene.add(fixture);
    const light = new THREE.SpotLight(color, 58, 24, Math.PI / 4.8, 0.5, 1.5);
    light.position.set(x, 5.0, z);
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
    this.playerRig = this.visuals.createPlayer();
    this.playerMesh = this.playerRig.root;
    this.scene.add(this.playerMesh);
    this.visuals.setPlayerWeapon(this.playerRig, this.getActiveWeaponId());
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

  private startWave(wave: number) {
    this.wave = wave;
    this.waveActive = true;
    this.waveCleared = false;
    this.extractionTimer = 0;
    if (this.extractionZoneMesh) this.extractionZoneMesh.visible = false;
    this.spawnQueue = [];
    this.announcement = `Wave ${wave}: ${WAVES[wave - 1].label}`;
    this.announcementTimer = 2.6;
    this.callbacks.onWaveChange(wave);

    const definition = WAVES[wave - 1];
    for (const [id, count] of Object.entries(definition.enemies)) {
      for (let i = 0; i < (count ?? 0); i += 1) this.spawnQueue.push(id as EnemyId);
    }
    this.shuffle(this.spawnQueue);
    this.spawnTimer = 0.2;
    this.emitHud(true);
  }

  private spawnEnemy(type: EnemyId) {
    const definition = ENEMIES[type];
    const candidate = new THREE.Vector3();
    let valid = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const edge = Math.floor(Math.random() * 4);
      const span = THREE.MathUtils.randFloat(-17, 17);
      if (edge === 0) candidate.set(span, 0, -17.5);
      else if (edge === 1) candidate.set(span, 0, 17.5);
      else if (edge === 2) candidate.set(-17.5, 0, span);
      else candidate.set(17.5, 0, span);

      if (candidate.distanceTo(this.playerMesh.position) < 5.5) continue;
      if (this.pointInsideObstacle(candidate.x, candidate.z)) continue;
      valid = true;
      break;
    }
    if (!valid) candidate.set(16, 0, 16);

    const rig = this.visuals.createEnemy(type, definition);
    const mesh = rig.root;
    mesh.position.copy(candidate);
    this.scene.add(mesh);
    this.enemies.push({
      type,
      definition,
      mesh,
      rig,
      health: definition.health,
      maxHealth: definition.health,
      attackCooldown: Math.random() * 0.5,
      specialCooldown: 2 + Math.random() * 2,
      chargeRemaining: 0,
      hitFlash: 0,
      knockback: new THREE.Vector3(),
    });
  }

  private createPickup(type: PickupId, position: THREE.Vector3, value: number) {
    const definition = PICKUPS[type];
    const group = new THREE.Group();
    if (type === "coin") {
      const coin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.09, 14),
        this.coinMaterial,
      );
      coin.rotation.x = Math.PI / 2;
      group.add(coin);
    } else {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.38, 0.42),
        type === "health" ? this.healthMaterial : this.ammoMaterial,
      );
      group.add(box);
      if (type === "health") {
        const crossMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.06, 0.1), crossMat);
        const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.38), crossMat);
        crossA.position.y = crossB.position.y = 0.22;
        group.add(crossA, crossB);
      }
    }

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.58, 20),
      new THREE.MeshBasicMaterial({ color: definition.color, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.3;
    group.add(halo);

    group.position.set(position.x, 0.55, position.z);
    this.scene.add(group);
    this.pickups.push({ type, mesh: group, value, age: Math.random() * 5 });
  }

  private getAvailableWeapons(): WeaponId[] {
    if (this.loadout && this.loadout.length > 1) return this.loadout;
    if (this.profile && this.profile.ownedWeapons && this.profile.ownedWeapons.length > 0) return this.profile.ownedWeapons;
    return ["pistol"];
  }

  private getActiveWeaponId(): WeaponId {
    const available = this.getAvailableWeapons();
    return available[this.activeWeaponIndex % available.length] ?? "pistol";
  }

  private fire() {
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.cooldown > 0) return;
    if (state.magazine <= 0) {
      this.reloadWeapon(id);
      return;
    }
    state.magazine -= 1;
    state.cooldown = 1 / stats.fireRate;

    // Multi-layered audio gunshot
    this.audio.playShoot(id);

    // Visible weapon model recoil kickback
    const recoilWeight = id === "shotgun" ? 1.6 : id === "rifle" ? 1.25 : id === "pistol" ? 0.9 : 0.65;
    if (this.playerRig) {
      this.visuals.applyWeaponRecoil(this.playerRig, recoilWeight);
    }

    // Directional camera recoil kickback
    this.cameraRecoil.addScaledVector(this.aim, -0.15 * recoilWeight);

    const origin = this.playerRig
      ? this.playerRig.muzzle.getWorldPosition(new THREE.Vector3())
      : this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.8, 1.25, this.aim.z * 0.8));

    const baseKnockback = id === "shotgun" ? 14 : id === "rifle" ? 9 : id === "pistol" ? 5.5 : 3.2;

    for (let pellet = 0; pellet < stats.pellets; pellet += 1) {
      const angle = Math.atan2(this.aim.z, this.aim.x) + THREE.MathUtils.randFloatSpread(stats.spread * 2);
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));

      const tracerLen = id === "rifle" ? 1.2 : id === "shotgun" ? 0.45 : 0.75;
      const tracerGeo = new THREE.CylinderGeometry(
        id === "shotgun" ? 0.04 : id === "rifle" ? 0.045 : 0.028,
        id === "shotgun" ? 0.06 : id === "rifle" ? 0.055 : 0.038,
        tracerLen,
        8,
      );
      const tracerMat = new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: 0.95 });
      const bullet = new THREE.Mesh(tracerGeo, tracerMat);
      bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      bullet.position.copy(origin);
      this.scene.add(bullet);
      this.projectiles.push({
        mesh: bullet,
        velocity: direction.clone().multiplyScalar(id === "shotgun" ? 34 : id === "rifle" ? 45 : 38),
        direction: direction.clone(),
        damage: stats.damage,
        knockback: baseKnockback,
        life: 1.35,
        enemy: false,
      });
    }

    const flash = this.visuals.createMuzzleFlashMesh(stats.color);
    flash.position.copy(origin).addScaledVector(this.aim, 0.22);
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.aim);
    this.scene.add(flash);
    this.effects.push({ mesh: flash, life: 0.05, maxLife: 0.05 });

    this.cameraShake = Math.max(this.cameraShake, id === "shotgun" ? 0.28 : id === "rifle" ? 0.16 : 0.07);
    if (state.magazine === 0 && state.reserve > 0) this.reloadWeapon(id);
  }

  private reload() {
    const id = this.getActiveWeaponId();
    this.reloadWeapon(id);
  }

  private reloadWeapon(id: WeaponId) {
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.magazine >= stats.magazine || state.reserve <= 0) return;
    state.reloading = stats.reload;
    this.audio.playReload();
  }

  private switchWeapon(direction = 1) {
    const available = this.getAvailableWeapons();
    if (available.length < 2) {
      this.audio.tone(200, 0.04, 0.02, "square");
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.4), "ONLY 1 WEAPON OWNED", "ammo");
      return;
    }
    this.activeWeaponIndex = (this.activeWeaponIndex + direction + available.length) % available.length;
    const newWeaponId = available[this.activeWeaponIndex];
    this.ensureWeaponState(newWeaponId);
    if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, newWeaponId);
    this.audio.tone(520, 0.06, 0.05, "triangle");
    this.spawnFloatingText(this.playerMesh.position.clone().setY(1.4), `ARMED: ${WEAPONS[newWeaponId].name.toUpperCase()}`, "ammo");
    this.emitHud(true);
  }

  private selectWeaponByIndex(index: number) {
    const available = this.getAvailableWeapons();
    if (index < 0 || index >= available.length) return;
    this.activeWeaponIndex = index;
    const newWeaponId = available[this.activeWeaponIndex];
    this.ensureWeaponState(newWeaponId);
    if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, newWeaponId);
    this.audio.tone(520, 0.06, 0.05, "triangle");
    this.spawnFloatingText(this.playerMesh.position.clone().setY(1.4), `ARMED: ${WEAPONS[newWeaponId].name.toUpperCase()}`, "ammo");
    this.emitHud(true);
  }

  private updatePlayer(dt: number) {
    const inputDir = new THREE.Vector3(
      (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      0,
      (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0),
    );
    const hasInput = inputDir.lengthSq() > 0;
    if (hasInput) inputDir.normalize();

    // Natural responsive acceleration & deceleration friction
    const targetSpeed = this.dashRemaining > 0 ? 18.5 : this.moveSpeed;
    const targetVelocity = hasInput
      ? (this.dashRemaining > 0 ? this.dashDirection : inputDir).clone().multiplyScalar(targetSpeed)
      : new THREE.Vector3(0, 0, 0);

    const accelRate = this.dashRemaining > 0 ? 90 : hasInput ? 54 : 18;
    this.playerVelocity.lerp(targetVelocity, 1 - Math.exp(-dt * accelRate));

    const currentSpeed = this.playerVelocity.length();

    // Smooth obstacle collision & tangential wall sliding
    const nextPos = this.playerMesh.position.clone().addScaledVector(this.playerVelocity, dt);
    const playerRadius = 0.48;

    for (const obstacle of this.obstacles) {
      if (obstacle.radius) {
        // Cylindrical vat collision
        const dx = nextPos.x - obstacle.x;
        const dz = nextPos.z - obstacle.z;
        const distSq = dx * dx + dz * dz;
        const minDist = obstacle.radius + playerRadius;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq) || 0.001;
          const normalX = dx / dist;
          const normalZ = dz / dist;
          nextPos.x = obstacle.x + normalX * minDist;
          nextPos.z = obstacle.z + normalZ * minDist;
          // Tangential sliding: remove normal component of velocity
          const dot = this.playerVelocity.x * normalX + this.playerVelocity.z * normalZ;
          if (dot < 0) {
            this.playerVelocity.x -= dot * normalX;
            this.playerVelocity.z -= dot * normalZ;
          }
        }
      } else {
        // AABB Obstacle collision with rounded slide
        const clampedX = THREE.MathUtils.clamp(nextPos.x, obstacle.x - obstacle.hx, obstacle.x + obstacle.hx);
        const clampedZ = THREE.MathUtils.clamp(nextPos.z, obstacle.z - obstacle.hz, obstacle.z + obstacle.hz);
        const dx = nextPos.x - clampedX;
        const dz = nextPos.z - clampedZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < playerRadius * playerRadius) {
          const dist = Math.sqrt(distSq) || 0.001;
          const normalX = dx / dist;
          const normalZ = dz / dist;
          nextPos.x = clampedX + normalX * playerRadius;
          nextPos.z = clampedZ + normalZ * playerRadius;
          const dot = this.playerVelocity.x * normalX + this.playerVelocity.z * normalZ;
          if (dot < 0) {
            this.playerVelocity.x -= dot * normalX;
            this.playerVelocity.z -= dot * normalZ;
          }
        }
      }
    }

    // Arena boundary clamp
    nextPos.x = THREE.MathUtils.clamp(nextPos.x, -ARENA_LIMIT, ARENA_LIMIT);
    nextPos.z = THREE.MathUtils.clamp(nextPos.z, -ARENA_LIMIT, ARENA_LIMIT);

    this.playerBody.setTranslation({ x: nextPos.x, y: 0.72, z: nextPos.z }, true);
    this.playerMesh.position.set(nextPos.x, 0, nextPos.z);

    // Snappy smoothed aim rotation
    const targetFacing = Math.atan2(this.aim.x, this.aim.z);
    const facingDelta = Math.atan2(
      Math.sin(targetFacing - this.playerMesh.rotation.y),
      Math.cos(targetFacing - this.playerMesh.rotation.y),
    );
    this.playerMesh.rotation.y += facingDelta * (1 - Math.exp(-dt * 32));

    if (this.playerRig) {
      this.visuals.animateCharacter(this.playerRig, dt, currentSpeed, false, 0);
      if (this.playerRig.model) {
        // Dynamic roll/lean during turns and dash
        const strafeTilt = (this.playerVelocity.x * Math.cos(this.playerMesh.rotation.y) - this.playerVelocity.z * Math.sin(this.playerMesh.rotation.y)) * 0.024;
        this.playerRig.model.rotation.z = THREE.MathUtils.lerp(
          this.playerRig.model.rotation.z,
          strafeTilt + (this.dashRemaining > 0 ? -0.22 : 0),
          1 - Math.exp(-dt * 18),
        );
      }
    }

    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.dashRemaining > 0) {
      this.dashRemaining = Math.max(0, this.dashRemaining - dt);
      if (Math.random() < 0.75) {
        const ghost = this.visuals.createDashGhost(this.playerMesh);
        this.scene.add(ghost);
        this.effects.push({ mesh: ghost, life: 0.24, maxLife: 0.24, fade: true });
      }
    }

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
          this.audio.playReload();
        }
      }
    }
  }

  private updateAim() {
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.mouseWorldPos.copy(hit);
      this.aim.copy(hit.clone().sub(this.playerMesh.position)).setY(0);
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
      if (this.wave >= 10) {
        this.waveActive = false;
        this.pause();
        this.callbacks.onVictory();
        return;
      }

      if (!this.waveCleared) {
        this.waveCleared = true;
        this.extractionTimer = 0;
        if (this.extractionZoneMesh) this.extractionZoneMesh.visible = true;
        this.announcement = "⚡ WAVE CLEARED! Step into the Central Beacon to advance";
        this.announcementTimer = 4.0;
        this.audio.playPickup("coin");
      }

      if (this.waveCleared) {
        if (this.extractionZoneMesh) {
          this.extractionZoneMesh.visible = true;
          this.extractionZoneMesh.rotation.y += dt * 1.5;
        }

        const playerDist = Math.hypot(this.playerMesh.position.x, this.playerMesh.position.z);
        if (playerDist < 3.2) {
          this.extractionTimer += dt;
          if (this.extractionTimer >= this.extractionRequiredTime) {
            this.waveCleared = false;
            this.waveActive = false;
            this.extractionTimer = 0;
            if (this.extractionZoneMesh) this.extractionZoneMesh.visible = false;
            this.pause();
            this.callbacks.onWaveComplete(this.wave);
          }
        } else {
          this.extractionTimer = Math.max(0, this.extractionTimer - dt * 2.0);
        }
      }
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

      // Apply and decay physical bullet knockback
      if (enemy.knockback.lengthSq() > 0.001) {
        enemy.mesh.position.addScaledVector(enemy.knockback, dt);
        enemy.knockback.lerp(new THREE.Vector3(), 1 - Math.exp(-dt * 14));
      }

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
          enemy.chargeRemaining = 1.1;
          enemy.specialCooldown = 5.6;
          this.announcement = "⚠️ Juggernaut charge incoming!";
          this.announcementTimer = 1.25;
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
                  separationX += (dx / gap) * push;
                  separationZ += (dz / gap) * push;
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
      enemy.mesh.rotation.y += facingDelta * (1 - Math.exp(-dt * 14));
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
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 6),
      new THREE.MeshBasicMaterial({ color: 0x39ff14 }),
    );
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x76ff03, transparent: true, opacity: 0.45 }),
    );
    group.add(core, aura);
    group.position.copy(enemy.mesh.position).add(new THREE.Vector3(0, 1.25, 0));
    this.scene.add(group);
    this.projectiles.push({
      mesh: group,
      velocity: direction.clone().multiplyScalar(9.0),
      direction: direction.clone(),
      damage: enemy.definition.damage,
      knockback: 4,
      life: 2.2,
      enemy: true,
    });
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
      if (this.pointInsideObstacle(projectile.mesh.position.x, projectile.mesh.position.z)) {
        this.removeProjectile(index);
        continue;
      }

      if (projectile.enemy) {
        if (projectile.mesh.position.distanceTo(this.playerMesh.position.clone().setY(1)) < 0.9) {
          this.damagePlayer(projectile.damage);
          this.removeProjectile(index);
        }
        continue;
      }

      const barrel = this.barrels.find(
        (item) => item.active && item.mesh.position.distanceTo(projectile.mesh.position.clone().setY(0)) < 0.72,
      );
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
        if (dx * dx + dz * dz <= (enemy.definition.radius + 0.2) ** 2) {
          this.damageEnemy(enemy, projectile.damage, projectile.knockback, projectile.direction, enemyIndex);
          this.removeProjectile(index);
          hit = true;
          break;
        }
      }
      if (hit) continue;
    }
  }

  private damageEnemy(
    enemy: EnemyEntity,
    damage: number,
    knockbackForce: number,
    bulletDir: THREE.Vector3,
    index: number,
  ) {
    const isCrit = Math.random() < 0.2;
    const finalDamage = isCrit ? Math.round(damage * 1.5) : damage;

    enemy.health -= finalDamage;
    enemy.hitFlash = 0.12;

    // Impart physical bullet knockback
    const effectiveKnockback = enemy.type === "juggernaut" ? knockbackForce * 0.15 : enemy.type === "brute" ? knockbackForce * 0.45 : knockbackForce;
    enemy.knockback.addScaledVector(bulletDir, effectiveKnockback);

    const hitPos = enemy.mesh.position.clone().setY(1.05 * enemy.rig.scale);
    this.createDirectionalHitBurst(hitPos, bulletDir, enemy.type === "spitter");

    // Tactile micro hit-stop on crits or heavy kills
    if (isCrit || finalDamage >= 60) {
      this.hitStopTimer = Math.max(this.hitStopTimer, 0.035);
    }

    this.spawnFloatingText(hitPos, isCrit ? `CRIT ${finalDamage}!` : `${finalDamage}`, isCrit ? "crit" : "damage");
    this.audio.playHit(isCrit);

    if (enemy.health <= 0) this.killEnemy(index);
  }

  private killEnemy(index: number) {
    const enemy = this.enemies[index];
    if (!enemy) return;
    const position = enemy.mesh.position.clone();
    this.visuals.disposeCharacter(enemy.rig);
    this.scene.remove(enemy.mesh);
    this.enemies.splice(index, 1);

    if (enemy.type === "spitter") {
      this.visuals.addAcidDecal(this.scene, position, 1.1);
    } else {
      this.visuals.addBloodDecal(
        this.scene,
        position,
        enemy.type === "juggernaut" ? 1.8 : enemy.type === "brute" ? 1.3 : 0.85,
      );
    }

    this.comboCount += 1;
    this.comboTimer = 2.8;
    if (this.comboCount === 3) {
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.5, 0)), "3x COMBO!", "combo");
    } else if (this.comboCount === 5) {
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.5, 0)), "5x MULTI-KILL!", "combo");
    } else if (this.comboCount === 8) {
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.5, 0)), "8x RAMPAGE!", "combo");
    } else if (this.comboCount >= 10 && this.comboCount % 5 === 0) {
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.5, 0)), `${this.comboCount}x UNSTOPPABLE!`, "combo");
    }

    this.createPickup("coin", position, enemy.definition.reward);
    if (Math.random() < 0.18 || (this.activeAmmoTotal() < 5 && Math.random() < 0.75)) {
      this.createPickup("ammo", position.clone().add(new THREE.Vector3(0.55, 0, 0)), 1);
    }
    if (Math.random() < 0.08) {
      this.createPickup("health", position.clone().add(new THREE.Vector3(-0.55, 0, 0)), 25);
    }

    const burst = new THREE.Mesh(this.deathBurstGeometry, this.deathBurstMaterial);
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
      if (distance < 5.6) {
        const pushDir = enemy.mesh.position.clone().sub(position).setY(0).normalize();
        this.damageEnemy(enemy, 200 * (1 - distance / 6.5), 18, pushDir, index);
      }
    }

    const blast = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.75, wireframe: true }),
    );
    blast.position.copy(position).setY(0.9);
    this.scene.add(blast);
    this.effects.push({ mesh: blast, life: 0.45, maxLife: 0.45 });

    this.visuals.addBloodDecal(this.scene, position, 1.4);
    this.cameraShake = 0.8;
    this.audio.playExplosion();
  }

  private createDirectionalHitBurst(position: THREE.Vector3, bulletDir: THREE.Vector3, isAcid = false) {
    const colors = isAcid ? [0x39ff14, 0x76ff03, 0x22c55e] : [0xff0055, 0xd90429, 0xef233c];
    for (let particle = 0; particle < 4; particle += 1) {
      const burst = new THREE.Mesh(
        new THREE.SphereGeometry(0.045 + particle * 0.015, 6, 4),
        new THREE.MeshBasicMaterial({ color: colors[particle % colors.length], transparent: true, opacity: 0.9 }),
      );
      // Spray particles backwards along the bullet angle with spread
      const spray = bulletDir.clone().multiplyScalar(0.4 + particle * 0.15).add(
        new THREE.Vector3(
          THREE.MathUtils.randFloatSpread(0.35),
          THREE.MathUtils.randFloat(0.1, 0.4),
          THREE.MathUtils.randFloatSpread(0.35),
        ),
      );
      burst.position.copy(position).add(spray);
      this.scene.add(burst);
      this.effects.push({ mesh: burst, life: 0.18 + particle * 0.03, maxLife: 0.18 + particle * 0.03 });
    }
  }

  private updatePickups(dt: number) {
    for (let index = this.pickups.length - 1; index >= 0; index -= 1) {
      const pickup = this.pickups[index];
      pickup.age += dt;
      pickup.mesh.rotation.y += dt * 2.5;
      pickup.mesh.position.y = 0.58 + Math.sin(pickup.age * 3.5) * 0.14;
      const delta = this.playerMesh.position.clone().sub(pickup.mesh.position).setY(0);
      const distance = delta.length();

      if (pickup.type === "coin" && distance < this.pickupRadius && distance > 0.05) {
        pickup.mesh.position.addScaledVector(delta.normalize(), dt * (4.5 + (this.pickupRadius - distance) * 2.5));
      }

      if (distance < 1.1) {
        const pickupPos = pickup.mesh.position.clone().setY(1.2);
        this.audio.playPickup(pickup.type);
        if (pickup.type === "coin") {
          this.callbacks.onCoins(pickup.value);
          this.spawnFloatingText(pickupPos, `+${pickup.value} 🪙`, "coin");
        } else if (pickup.type === "ammo") {
          const id = this.getActiveWeaponId();
          const state = this.weaponStates.get(id);
          if (state) {
            const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
            state.reserve = Math.min(stats.reserve, state.reserve + Math.ceil(stats.reserve * 0.35));
          }
          this.spawnFloatingText(pickupPos, "+AMMO ⚡", "ammo");
        } else {
          this.playerHealth = Math.min(this.maxHealth, this.playerHealth + pickup.value);
          this.spawnFloatingText(pickupPos, `+${pickup.value} HP 💚`, "health");
        }
        this.scene.remove(pickup.mesh);
        this.visuals.disposeObject(pickup.mesh);
        this.pickups.splice(index, 1);
      }
    }
  }

  private updateEffects(dt: number) {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.life -= dt;
      const progress = 1 - effect.life / effect.maxLife;
      if (!effect.fade) {
        effect.mesh.scale.setScalar(1 + progress * 3.5);
      }
      effect.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material & { opacity?: number };
          if (typeof mat.opacity === "number") mat.opacity = Math.max(0, 1 - progress);
        }
      });
      if (effect.life <= 0) {
        this.scene.remove(effect.mesh);
        this.visuals.disposeObject(effect.mesh);
        this.effects.splice(index, 1);
      }
    }
  }

  private damagePlayer(amount: number) {
    if (this.dashRemaining > 0 || this.playerHealth <= 0) return;
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.cameraShake = Math.max(this.cameraShake, 0.48);
    this.audio.playPlayerDamage();

    this.spawnFloatingText(this.playerMesh.position.clone().setY(1.3), `-${amount}`, "player-damage");

    this.container.classList.remove("is-hit");
    void this.container.offsetWidth;
    this.container.classList.add("is-hit");

    if (this.playerHealth <= 0) {
      this.pause();
      this.emitHud(true);
      this.callbacks.onDeath();
    }
  }

  private spawnFloatingText(
    worldPos: THREE.Vector3,
    text: string,
    type: "damage" | "crit" | "coin" | "health" | "ammo" | "player-damage" | "combo",
  ) {
    if (typeof window === "undefined") return;
    const projected = worldPos.clone().project(this.camera);
    if (projected.z < -1 || projected.z > 1) return;

    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;
    const screenX = ((projected.x + 1) / 2) * width + THREE.MathUtils.randFloatSpread(18);
    const screenY = ((-projected.y + 1) / 2) * height + THREE.MathUtils.randFloatSpread(12);

    const span = document.createElement("div");
    span.className = `floating-popup floating-popup--${type}`;
    span.textContent = text;
    span.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;

    this.floatingLayer.appendChild(span);
    setTimeout(() => {
      span.remove();
    }, 650);
  }

  private activeAmmoTotal() {
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    return state ? state.magazine + state.reserve : 0;
  }

  private resolveEnemyPosition(position: THREE.Vector3, radius: number) {
    position.x = THREE.MathUtils.clamp(position.x, -ARENA_LIMIT, ARENA_LIMIT);
    position.z = THREE.MathUtils.clamp(position.z, -ARENA_LIMIT, ARENA_LIMIT);
    for (const obstacle of this.obstacles) {
      if (obstacle.radius) {
        const dx = position.x - obstacle.x;
        const dz = position.z - obstacle.z;
        const distSq = dx * dx + dz * dz;
        const minDist = obstacle.radius + radius;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq) || 0.001;
          position.x = obstacle.x + (dx / dist) * minDist;
          position.z = obstacle.z + (dz / dist) * minDist;
        }
      } else {
        const dx = position.x - obstacle.x;
        const dz = position.z - obstacle.z;
        const overlapX = obstacle.hx + radius - Math.abs(dx);
        const overlapZ = obstacle.hz + radius - Math.abs(dz);
        if (overlapX > 0 && overlapZ > 0) {
          if (overlapX < overlapZ) position.x += Math.sign(dx || 1) * overlapX;
          else position.z += Math.sign(dz || 1) * overlapZ;
        }
      }
    }
    return position;
  }

  private pointInsideObstacle(x: number, z: number) {
    return this.obstacles.some(
      (obstacle) => Math.abs(x - obstacle.x) <= obstacle.hx && Math.abs(z - obstacle.z) <= obstacle.hz,
    );
  }

  private removeProjectile(index: number) {
    const projectile = this.projectiles[index];
    if (!projectile) return;
    this.scene.remove(projectile.mesh);
    this.visuals.disposeObject(projectile.mesh);
    this.projectiles.splice(index, 1);
  }

  private emitHud(force = false) {
    if (!force && this.hudTimer > 0) return;
    this.hudTimer = 0.08;
    const id = this.getActiveWeaponId();
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
      comboCount: this.comboCount,
      comboTimer: this.comboTimer,
      extractionZoneActive: this.waveCleared,
      extractionProgress: this.waveCleared ? Math.min(1, this.extractionTimer / this.extractionRequiredTime) : 0,
      missionTime: this.missionElapsed,
      playerPos: {
        x: this.playerMesh.position.x,
        z: this.playerMesh.position.z,
        rotation: Math.atan2(this.aim.x, this.aim.z),
      },
      minimapEnemies: this.enemies.slice(0, 32).map((enemy) => ({
        x: enemy.mesh.position.x,
        z: enemy.mesh.position.z,
        type: enemy.type,
      })),
    });
  }

  private step(dt: number) {
    this.missionElapsed += dt;
    this.hudTimer -= dt;
    this.announcementTimer = Math.max(0, this.announcementTimer - dt);

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
      }
    }

    this.updateAim();

    // Hit-stop micro freeze frame (slow down/freeze simulation momentarily for punchy impact)
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= dt;
      this.updateCamera(dt);
      this.emitHud();
      return;
    }

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
    // Dynamic mouse-leading camera: forward look toward the aim cursor
    const aimDistance = this.mouseWorldPos.distanceTo(this.playerMesh.position);
    const leadAmount = THREE.MathUtils.clamp(aimDistance * 0.28, 0, 4.2);
    const leadVector = this.aim.clone().multiplyScalar(leadAmount);

    const desiredLook = new THREE.Vector3(
      THREE.MathUtils.clamp(this.playerMesh.position.x * 0.45 + leadVector.x, -7.5, 7.5),
      0,
      THREE.MathUtils.clamp(this.playerMesh.position.z * 0.45 + leadVector.z, -6.8, 6.8),
    );

    this.cameraLook.lerp(desiredLook, 1 - Math.exp(-dt * 6.5));

    // Decay camera recoil
    this.cameraRecoil.lerp(new THREE.Vector3(), 1 - Math.exp(-dt * 16));

    const shake = this.profile.settings.reducedMotion ? 0 : this.cameraShake;
    const offsetX = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;
    const offsetZ = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;

    const posX = this.cameraLook.x + this.cameraRecoil.x + offsetX;
    const posZ = this.cameraLook.z + 17 + this.cameraRecoil.z + offsetZ;
    this.camera.position.set(posX, 20, posZ);

    const targetX = this.cameraLook.x + this.cameraRecoil.x * 0.5;
    const targetZ = this.cameraLook.z + this.cameraRecoil.z * 0.5;
    this.camera.lookAt(targetX, 0.42, targetZ);

    this.cameraShake = Math.max(0, this.cameraShake - dt * 3.2);

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
      const maximum = Math.min(window.devicePixelRatio, 1.5);
      const nextRatio =
        this.frameTimeAverage > 0.021
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
    this.camera.left = (-view * aspect) / 2;
    this.camera.right = (view * aspect) / 2;
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
    const code = event.code;
    const key = event.key ? event.key.toLowerCase() : "";

    if (code === "Escape") {
      if (!event.repeat) this.callbacks.onPauseToggle();
      return;
    }
    if (this.paused) return;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(code)) event.preventDefault();
    this.keys.add(code);
    if (event.repeat) return;

    if (code === "KeyR" || key === "r") {
      this.reload();
    }
    if (code === "KeyQ" || key === "q" || code === "KeyE" || key === "e") {
      event.preventDefault();
      this.switchWeapon();
      return;
    }
    if (code === "Digit1" || key === "1") {
      this.selectWeaponByIndex(0);
      return;
    }
    if (code === "Digit2" || key === "2") {
      this.selectWeaponByIndex(1);
      return;
    }
    if (code === "Digit3" || key === "3") {
      this.selectWeaponByIndex(2);
      return;
    }
    if (code === "Digit4" || key === "4") {
      this.selectWeaponByIndex(3);
      return;
    }

    if ((code === "ShiftLeft" || code === "ShiftRight" || code === "Space") && this.dashCooldown <= 0) {
      const inputDir = new THREE.Vector3(
        (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
        0,
        (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0),
      );
      this.dashDirection = inputDir.lengthSq() > 0 ? inputDir.normalize() : this.aim.clone();
      this.dashRemaining = this.dashTotal;
      this.dashCooldown = 2.8;
      this.audio.playDash();
    }
    if (code === "KeyK" && this.qaMode) {
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

  private onWheel = (event: WheelEvent) => {
    if (this.paused || this.destroyed) return;
    if (Math.abs(event.deltaY) > 3) {
      this.switchWeapon(event.deltaY > 0 ? 1 : -1);
    }
  };

  private clearInputState() {
    this.keys.clear();
    this.firing = false;
    this.playerVelocity.set(0, 0, 0);
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
    window.addEventListener("wheel", this.onWheel, { passive: true });
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
    window.removeEventListener("wheel", this.onWheel);
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
