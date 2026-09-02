import * as THREE from "three";
import {
  BEHAVIOURS,
  CAMPAIGN_WAVES,
  ENEMIES,
  getWaveDefinition,
  getWaveScaling,
  getEnemySpeed,
  getFrenzySpeed,
  HIT_STOP_COOLDOWN,
  HIT_STOP_DURATION,
  getProfilePower,
  getWeaponStats,
  PICKUPS,
  rollWaveModifier,
  WEAPONS,
  type WaveModifier,
} from "./config";
import { CRATE_BASE_HP, getArenaForWave, type ArenaDefinition, type ArenaId, type ArenaProp } from "./arenas";
import { GameAudio } from "./audio";
import { COMIC } from "./comic";
import { selectTouchAimTarget } from "./mobile";
import { ComicPostProcess, type ComicPostOptions } from "./postfx";
import { createRunStats, type RunStats } from "./stats";
import { markTransient, VisualFactory, type CharacterRig } from "./visuals";
import type {
  EliteAffix,
  EnemyDefinition,
  EnemyId,
  HudState,
  GraphicsMode,
  InputMode,
  PerkId,
  PickupId,
  ProfileV1,
  SynergyCardId,
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

export interface GameRuntimeConfig {
  inputMode: InputMode;
  mobileRendering: boolean;
  graphicsMode: GraphicsMode;
}

interface EnemyEntity {
  type: EnemyId;
  /** Shared, immutable archetype stats. Never mutate. */
  definition: EnemyDefinition;
  /** Wave-scaled copies of the stats that vary per spawn. */
  speed: number;
  damage: number;
  reward: number;
  /** Counts down through a telegraphed swing; damage lands at zero. */
  windupTimer: number;
  /** Bearing this enemy circles to before closing, in radians. */
  flankAngle: number;
  /** Seconds spent trying to move without actually moving. */
  stuckTimer: number;
  /** Seconds left of an active sidestep manoeuvre. */
  unstickTimer: number;
  /** Which way this enemy sidesteps when wedged; fixed so it commits. */
  unstickSign: number;
  /** Telegraph ring shown during a wind-up. */
  telegraph?: THREE.Object3D;
  /** Floating health bar, revealed on first damage. */
  healthBar?: THREE.Group;
  mesh: THREE.Group;
  rig: CharacterRig;
  health: number;
  maxHealth: number;
  attackCooldown: number;
  specialCooldown: number;
  chargeRemaining: number;
  hitFlash: number;
  knockback: THREE.Vector3;
  affix?: EliteAffix;
  isElite?: boolean;
  shieldHp?: number;
  shieldMesh?: THREE.Mesh;
  burningTimer?: number;
  /** Burn damage per second, captured from the igniting card's rank. */
  burnDps?: number;
  chilledTimer?: number;
  /** Slow multiplier from the chilling card's rank; lower is slower. */
  chillMult?: number;
  bossPhase?: number;
}

interface ProjectileEntity {
  mesh: THREE.Mesh | THREE.Group;
  velocity: THREE.Vector3;
  direction: THREE.Vector3;
  damage: number;
  knockback: number;
  life: number;
  enemy: boolean;
  pierceCount?: number;
  maxPierces?: number;
  bouncesRemaining?: number;
  hitEnemies?: Set<EnemyEntity>;
  isShrapnel?: boolean;
}

/**
 * What dealt a hit. Shrapnel needles must not spawn more shrapnel, or one
 * lucky crit in a chilled crowd cascades into a needle storm; splash damage
 * from explosions and hazards counts for nothing on the accuracy tally.
 */
type DamageSource = "bullet" | "shrapnel" | "splash";

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

/** Lingering ground zone that damages enemies standing in it. */
interface HazardEntity {
  mesh: THREE.Object3D;
  x: number;
  z: number;
  radius: number;
  dps: number;
  life: number;
  maxLife: number;
  /** Damage accrues between ticks so DPS is frame-rate independent. */
  tickTimer: number;
}

/**
 * A constructed arena, held for reuse.
 *
 * The obstacle and barrel lists are templates: activation copies them so a
 * crate destroyed this wave is whole again next time the arena comes round,
 * without the copy having to walk the scene graph.
 */
interface BuiltArena {
  root: THREE.Group;
  obstacles: Obstacle[];
  barrels: BarrelEntity[];
}

/**
 * A telegraphed arena hazard mid-flight.
 *
 * The marker goes down first and the payload lands when `timer` expires, so
 * every arena hazard is something the player is given time to walk out of.
 */
interface ArenaEvent {
  kind: "debris" | "surge";
  x: number;
  z: number;
  radius: number;
  damage: number;
  timer: number;
  marker: THREE.Object3D;
  payload?: THREE.Object3D;
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
  /**
   * Destructible cover. Only crates carry these; every other obstacle is
   * permanent, and the absence of `health` is what marks it as such.
   */
  health?: number;
  maxHealth?: number;
  mesh?: THREE.Group;
}

const FIXED_STEP = 1 / 60;
const ARENA_LIMIT = 18.5;
const CAMERA_HEIGHT = 18.5;
const CAMERA_BACK = 15;
const MAX_ACTIVE_ENEMIES = 36;
/** Ceiling on knockback speed in world units/sec. Decay is ~1/14s, so this
 *  works out to roughly a two-metre shove at full force. */
const MAX_KNOCKBACK_SPEED = 26;
const CROWD_CELL_SIZE = 2.5;
/** Live damage-number popups. A shotgun into a crowd can spawn dozens a frame. */
const MAX_FLOATING_POPUPS = 48;

interface RenderTuning {
  initialPixelRatio: number;
  minPixelRatio: number;
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  post: Required<Pick<ComicPostOptions, "outlineStrength" | "halftoneStrength" | "grainStrength">>;
}

function getRenderTuning(mode: GraphicsMode, mobile: boolean): RenderTuning {
  if (mode === "performance") {
    return {
      initialPixelRatio: 1,
      minPixelRatio: 0.75,
      maxPixelRatio: mobile ? 1 : 1.1,
      shadows: false,
      shadowMapSize: 512,
      post: { outlineStrength: 0.82, halftoneStrength: 0.26, grainStrength: 0.014 },
    };
  }
  if (mode === "quality") {
    return {
      initialPixelRatio: mobile ? 1.5 : 1.75,
      minPixelRatio: mobile ? 1.1 : 1.25,
      maxPixelRatio: mobile ? 1.75 : 2,
      shadows: true,
      shadowMapSize: mobile ? 1024 : 2048,
      post: { outlineStrength: 0.95, halftoneStrength: 0.44, grainStrength: 0.026 },
    };
  }
  if (mobile) {
    return {
      initialPixelRatio: 1.25,
      minPixelRatio: 0.9,
      maxPixelRatio: 1.5,
      shadows: true,
      shadowMapSize: 1024,
      post: { outlineStrength: 0.9, halftoneStrength: 0.36, grainStrength: 0.02 },
    };
  }
  return {
    initialPixelRatio: 1.5,
    minPixelRatio: 1,
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    post: { outlineStrength: 1, halftoneStrength: 0.5, grainStrength: 0.045 },
  };
}


export class GameEngine {
  private container: HTMLElement;
  private floatingLayer: HTMLElement;
  private callbacks: EngineCallbacks;
  private profile: ProfileV1;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 110);
  private renderer: THREE.WebGLRenderer;
  private visuals: VisualFactory;
  private post: ComicPostProcess;
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
  /** Blocks hit-stop from re-arming; ticks down even while frozen. */
  private hitStopCooldown = 0;
  private waveCleared = false;
  private extractionTimer = 0;
  private readonly extractionRequiredTime = 3.2;
  private extractionZoneMesh!: THREE.Group;
  private pixelRatio = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 1.5);
  private minPixelRatio = 1;
  private maxPixelRatio = 1.5;
  private shadowMapSize = 2048;
  private frameTimeAverage = FIXED_STEP;
  private performanceSampleTime = 0;
  private qaFramesRendered = 0;

  private playerMesh = new THREE.Group();
  private playerRig: CharacterRig | null = null;
  private playerVelocity = new THREE.Vector3();
  private cameraLook = new THREE.Vector3();
  private cameraRecoil = new THREE.Vector3();
  private cameraShake = 0;
  private playerHealth = 100;
  /** False until the first applyPerks call has seeded health. */
  private perksInitialised = false;
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
  private virtualMove = new THREE.Vector2();
  private usingTouchControls = false;
  private inputMode: InputMode = "keyboard";
  private mobileRendering = false;
  private graphicsMode: GraphicsMode = "auto";
  private keyLight: THREE.DirectionalLight | null = null;
  private touchAimTarget: EnemyEntity | null = null;
  private touchAimIndicator: THREE.Group | null = null;
  private touchAimLockPulse = 0;
  /**
   * The current arena's own sky, and the danger wash blended over it.
   *
   * `skyCool` is reassigned per arena by activateArena rather than fixed: the
   * atmosphere pass runs every frame, so a hard-coded base silently overwrote
   * each arena's theme colour a frame after it was set.
   */
  private skyCool = new THREE.Color(COMIC.sky);
  private skyHot = new THREE.Color(0x7a1f3d);
  private qaMode =
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).has("qa");

  private enemies: EnemyEntity[] = [];
  private projectiles: ProjectileEntity[] = [];
  private pickups: PickupEntity[] = [];
  private barrels: BarrelEntity[] = [];
  private effects: EffectEntity[] = [];
  private hazards: HazardEntity[] = [];
  private activeSynergies = new Map<SynergyCardId, number>();
  private bulletCount = 0;
  private acidTrailTimer = 0;
  private obstacles: Obstacle[] = [];
  /**
   * Everything belonging to the current arena.
   *
   * Kept as one group purely so a rebuild is a single removal — walking the
   * scene graph looking for "props" is how you eventually orphan a mesh and
   * leak a whole layout per wave.
   */
  private arenaRoot = new THREE.Group();
  private currentArena: ArenaDefinition | null = null;
  /**
   * Arenas are built once and kept.
   *
   * `VisualFactory.disposeObject` only detaches — every geometry and texture it
   * hands out is owned centrally and released when the engine dies. Rebuilding
   * a layout from scratch each wave therefore allocates a fresh copy that is
   * never freed, which an endless run turns into an unbounded leak. Four cached
   * groups swapped in and out cost nothing and never grow.
   */
  private arenaCache = new Map<ArenaId, BuiltArena>();
  /** Countdown to the next arena hazard event. */
  private arenaHazardTimer = 0;
  /** Pending telegraphed hazard events waiting to resolve. */
  private arenaEvents: ArenaEvent[] = [];
  private weaponStates = new Map<WeaponId, WeaponInstance>();
  private loadout: WeaponId[];
  private activeWeaponIndex = 0;
  private stats: RunStats = createRunStats();

  private wave = 1;
  /** Once set, wave 10 no longer ends the run. */
  private endless = false;
  private spawnQueue: EnemyId[] = [];
  private spawnTimer = 0;
  private waveActive = false;
  private waveModifier: WaveModifier | null = null;
  private hazardBloomTimer = 0;
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
  /**
   * Tracer geometry and materials, cached by weapon and bullet scale.
   *
   * Every pellet used to build a fresh CylinderGeometry and MeshBasicMaterial
   * and dispose them on impact — ten allocations a second on the SMG, six at
   * once from the shotgun, each one a potential shader lookup. The variants are
   * fully determined by weapon id, high-caliber rank and tint, so a small cache
   * covers a whole run.
   */
  private tracerGeometries = new Map<string, THREE.CylinderGeometry>();
  private tracerMaterials = new Map<number, THREE.MeshBasicMaterial>();
  private needleGeometry = new THREE.CylinderGeometry(0.02, 0.035, 0.35, 6);
  private needleMaterial = new THREE.MeshBasicMaterial({ color: 0xffe600 });
  private deathBurstGeometry = new THREE.RingGeometry(0.18, 0.48, 16);
  private deathBurstMaterial = new THREE.MeshBasicMaterial({ color: 0x00f5d4, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  /**
   * Shared geometry for everything spawned in volume: pickups, hit sparks,
   * spit and blast shells. Each used to be a fresh allocation per event that
   * was detached on expiry but never disposed, so every kill and every hit
   * left a few GPU buffers behind for the rest of the run.
   */
  private coinGeometry = new THREE.CylinderGeometry(0.32, 0.32, 0.09, 14);
  private crateGeometry = new THREE.BoxGeometry(0.55, 0.38, 0.42);
  private crossGeometryA = new THREE.BoxGeometry(0.38, 0.06, 0.1);
  private crossGeometryB = new THREE.BoxGeometry(0.1, 0.06, 0.38);
  private crossMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private haloGeometry = new THREE.RingGeometry(0.42, 0.58, 20);
  private haloMaterials = new Map<PickupId, THREE.MeshBasicMaterial>();
  private hitSparkGeometries = [0, 1, 2, 3].map(
    (particle) => new THREE.SphereGeometry(0.045 + particle * 0.015, 6, 4),
  );
  private spitCoreGeometry = new THREE.SphereGeometry(0.22, 10, 6);
  private spitAuraGeometry = new THREE.SphereGeometry(0.32, 8, 6);
  private spitCoreMaterial = new THREE.MeshBasicMaterial({ color: 0x39ff14 });
  private spitAuraMaterial = new THREE.MeshBasicMaterial({ color: 0x76ff03, transparent: true, opacity: 0.45 });
  private boomerBlastGeometry = new THREE.SphereGeometry(1.6, 16, 12);
  private barrelBlastGeometry = new THREE.SphereGeometry(1.2, 14, 10);

  constructor(
    container: HTMLElement,
    profile: ProfileV1,
    callbacks: EngineCallbacks,
    runtime: GameRuntimeConfig = { inputMode: "keyboard", mobileRendering: false, graphicsMode: "auto" },
  ) {
    this.container = container;
    this.profile = profile;
    this.callbacks = callbacks;
    this.inputMode = runtime.inputMode;
    this.usingTouchControls = runtime.inputMode === "touch";
    this.mobileRendering = runtime.mobileRendering;
    this.graphicsMode = runtime.graphicsMode;
    const tuning = getRenderTuning(runtime.graphicsMode, runtime.mobileRendering);
    this.minPixelRatio = tuning.minPixelRatio;
    this.maxPixelRatio = tuning.maxPixelRatio;
    this.shadowMapSize = tuning.shadowMapSize;
    this.loadout = profile.equippedLoadout.length ? [...profile.equippedLoadout] : ["pistol"];

    this.renderer = new THREE.WebGLRenderer({ antialias: !runtime.mobileRendering, powerPreference: "high-performance" });
    this.pixelRatio = this.qaMode ? 0.5 : Math.min(window.devicePixelRatio, tuning.initialPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = !this.qaMode && tuning.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Flat sRGB with no tone curve: filmic roll-off desaturates the highlights
    // and reintroduces exactly the smooth gradients the cel look removes.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Deadwave evacuation depot combat arena");

    this.floatingLayer = document.createElement("div");
    this.floatingLayer.className = "floating-hud-layer";
    this.container.appendChild(this.floatingLayer);

    this.timer.connect(document);
    this.visuals = new VisualFactory(this.renderer);
    this.post = new ComicPostProcess(this.renderer, tuning.post);

    this.applyPerks(profile.perkRanks);
    this.setupScene();
    this.createPlayer();
    this.createWeaponStates();
    this.bindEvents();
    this.resize();
    this.container.insertBefore(this.renderer.domElement, this.floatingLayer);
  }

  start(wave = 1) {
    this.wave = wave;
    // Resuming a checkpoint past the campaign IS an endless run. Without this
    // the HUD reported "WAVE 12 / 10 · CAMPAIGN" and wave 10 would have tried
    // to trigger victory a second time.
    this.endless = wave > CAMPAIGN_WAVES;
    if (wave === 1) {
      this.activeSynergies.clear();
      this.stats = createRunStats();
    }
    this.audio.configure(this.profile.settings);
    this.audio.start();
    this.paused = false;
    this.startWave(wave);
    this.timer.reset();
    this.scheduleFrame();
    void this.visuals.ready();
  }

  addSynergy(id: SynergyCardId) {
    const current = this.activeSynergies.get(id) ?? 0;
    this.activeSynergies.set(id, current + 1);
    this.audio.playPerkSelect();
    this.announcement = `SYNERGY ACQUIRED: ${id.replace(/_/g, " ").toUpperCase()}`;
    this.announcementTimer = 2.4;
    this.emitHud(true);
  }

  getSynergies(): Partial<Record<SynergyCardId, number>> {
    return Object.fromEntries(this.activeSynergies);
  }

  resetSynergies() {
    this.activeSynergies.clear();
    this.emitHud(true);
  }

  /**
   * Re-apply a deck carried across a redeploy, without the per-card fanfare.
   * Replaying `addSynergy` for each stack fired five acquisition stingers at
   * once and left the announcement banner showing whichever card came last.
   */
  restoreSynergies(deck: Partial<Record<SynergyCardId, number>>) {
    this.activeSynergies.clear();
    for (const [id, stacks] of Object.entries(deck)) {
      if (stacks && stacks > 0) this.activeSynergies.set(id as SynergyCardId, stacks);
    }
    this.emitHud(true);
  }

  getRunStats(): RunStats {
    return { ...this.stats, missionTime: this.missionElapsed };
  }

  /** Continue a previous life's tallies after a redeploy rebuilt the engine. */
  restoreRunStats(stats: RunStats) {
    this.stats = { ...stats };
    this.missionElapsed = stats.missionTime;
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
    this.wave = this.endless ? this.wave + 1 : Math.min(CAMPAIGN_WAVES, this.wave + 1);
    this.startWave(this.wave);
    this.resume();
  }

  getWave() {
    return this.wave;
  }

  /** Continue past the campaign into scaling endless waves. */
  continueEndless() {
    this.endless = true;
    this.startNextWave();
  }

  isEndless() {
    return this.endless;
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
    // The weapons the swap key can actually reach, not just the loadout: with
    // one slot filled, every owned weapon is available and the second one was
    // being charged for and skipped.
    for (const id of new Set(this.getAvailableWeapons())) {
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

  setVirtualMove(x: number, z: number) {
    if (this.inputMode !== "touch") return;
    this.virtualMove.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(z, -1, 1));
  }

  setVirtualFire(active: boolean) {
    if (this.inputMode !== "touch") return;
    this.firing = active;
  }

  triggerVirtualAction(action: "dash" | "reload" | "swap") {
    if (this.inputMode !== "touch") return;
    if (action === "dash") this.startDash();
    else if (action === "reload") this.reload();
    else this.switchWeapon();
  }

  setInputMode(mode: InputMode) {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.usingTouchControls = mode === "touch";
    this.touchAimTarget = null;
    this.hideTouchAimIndicator();
    this.clearInputState();
  }

  setGraphicsMode(mode: GraphicsMode) {
    if (this.graphicsMode === mode) return;
    this.graphicsMode = mode;
    const tuning = getRenderTuning(mode, this.mobileRendering);
    this.minPixelRatio = tuning.minPixelRatio;
    this.maxPixelRatio = tuning.maxPixelRatio;
    this.shadowMapSize = tuning.shadowMapSize;

    if (!this.qaMode) {
      this.pixelRatio = Math.min(window.devicePixelRatio, tuning.initialPixelRatio);
      this.renderer.shadowMap.enabled = tuning.shadows;
      if (this.keyLight) {
        this.keyLight.shadow.mapSize.setScalar(tuning.shadowMapSize);
        this.keyLight.shadow.map?.dispose();
        this.keyLight.shadow.map = null;
        this.keyLight.shadow.needsUpdate = true;
      }
    }
    this.post.setUniform("uOutlineStrength", tuning.post.outlineStrength);
    this.post.setUniform("uHalftoneStrength", tuning.post.halftoneStrength);
    this.post.setUniform("uGrainStrength", tuning.post.grainStrength);
    this.resize();
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
    for (const geometry of this.tracerGeometries.values()) geometry.dispose();
    for (const material of this.tracerMaterials.values()) material.dispose();
    this.tracerGeometries.clear();
    this.tracerMaterials.clear();
    this.needleGeometry.dispose();
    this.needleMaterial.dispose();
    this.deathBurstGeometry.dispose();
    this.deathBurstMaterial.dispose();
    for (const geometry of [
      this.coinGeometry,
      this.crateGeometry,
      this.crossGeometryA,
      this.crossGeometryB,
      this.haloGeometry,
      this.spitCoreGeometry,
      this.spitAuraGeometry,
      this.boomerBlastGeometry,
      this.barrelBlastGeometry,
      ...this.hitSparkGeometries,
    ]) geometry.dispose();
    for (const material of [
      this.coinMaterial,
      this.ammoMaterial,
      this.healthMaterial,
      this.crossMaterial,
      this.spitCoreMaterial,
      this.spitAuraMaterial,
      ...this.haloMaterials.values(),
    ]) material.dispose();
    this.haloMaterials.clear();
    this.visuals.dispose(this.scene);
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.floatingLayer.remove();
  }

  private setupScene() {
    // Comic panel, not a dark room: a saturated sky wash and no fog at all.
    // Depth comes from ink outlines and flat colour separation instead.
    // The wash itself is per-arena and set by activateArena.
    this.scene.background = new THREE.Color(COMIC.sky);
    this.scene.fog = null;

    // Cel shading needs the *total* irradiance to land near 1.0. With no tone
    // curve to roll off the top end, anything hotter clips every saturated
    // surface to flat white — the palette disappears just as badly as it did
    // in the dark. Ambient carries the shadow band, the key carries the step.
    const ambient = new THREE.HemisphereLight(0xdfe8ff, 0x6b7799, 0.5);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff6e2, 0.72);
    key.position.set(-14, 26, -10);
    key.castShadow = true;
    key.shadow.mapSize.setScalar(this.shadowMapSize);
    // Must enclose the 46-unit ground plus the perimeter walls. Ground outside
    // the shadow frustum samples as fully shadowed, which darkened the arena
    // corners and undid the flat lighting exactly where it was least expected.
    key.shadow.camera.left = -32;
    key.shadow.camera.right = 32;
    key.shadow.camera.top = 32;
    key.shadow.camera.bottom = -32;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.035;
    this.keyLight = key;
    this.scene.add(key);

    // Cool bounce keeps shadowed sides coloured rather than grey.
    const coolFill = new THREE.DirectionalLight(0x8ecbff, 0.16);
    coolFill.position.set(14, 12, 16);
    this.scene.add(coolFill);

    this.scene.add(this.arenaRoot);
    this.buildArena(getArenaForWave(this.wave));

    this.extractionZoneMesh = this.visuals.createExtractionZone();
    this.extractionZoneMesh.position.set(0, 0, 0);
    this.extractionZoneMesh.visible = false;
    this.scene.add(this.extractionZoneMesh);

    this.touchAimIndicator = this.visuals.createAutoAimIndicator();
    this.scene.add(this.touchAimIndicator);
  }

  /**
   * Make `arena` the active layout, constructing it the first time it is used.
   *
   * Ground, perimeter and props are all themed, so arenas cannot share a
   * built group — reusing the floor across layouts is what made the first pass
   * at this read as "the depot with different boxes in it".
   */
  private buildArena(arena: ArenaDefinition) {
    if (this.currentArena?.id === arena.id) {
      // Same layout two waves running: just make the cover whole again.
      this.activateArena(arena);
      return;
    }

    const previous = this.currentArena ? this.arenaCache.get(this.currentArena.id) : undefined;
    if (previous) this.arenaRoot.remove(previous.root);
    // Decals and acid pools sit in the scene, not the arena group, so they
    // would otherwise carry over and paint the last room's gore onto this one.
    this.visuals.clearDecals();
    this.clearHazards();

    if (!this.arenaCache.has(arena.id)) {
      const root = new THREE.Group();
      // The prop helpers append to arenaRoot, so point it at the new group for
      // the duration of construction rather than threading a target through
      // eleven call sites.
      const restore = this.arenaRoot;
      this.arenaRoot = root;
      this.obstacles = [];
      this.barrels = [];

      root.add(this.visuals.createGround(arena.theme));
      this.visuals.addPerimeter(root, arena.theme);
      this.visuals.addSetDressing(root, arena.theme);
      for (const prop of arena.props) this.addArenaProp(prop);

      this.arenaCache.set(arena.id, { root, obstacles: this.obstacles, barrels: this.barrels });
      this.arenaRoot = restore;
    }

    const built = this.arenaCache.get(arena.id)!;
    this.arenaRoot.add(built.root);
    this.activateArena(arena);
  }

  /**
   * Point the live collision and barrel lists at the cached arena, restored to
   * pristine condition: crates whole, barrels unspent.
   */
  private activateArena(arena: ArenaDefinition) {
    const built = this.arenaCache.get(arena.id);
    if (!built) return;
    this.currentArena = arena;
    this.skyCool.setHex(arena.theme.sky);
    this.scene.background = new THREE.Color(arena.theme.sky);

    // Copied, not aliased: destroying a crate splices the live list, and the
    // template has to survive that to rebuild the arena next time round.
    this.obstacles = built.obstacles.map((obstacle) => ({ ...obstacle }));
    for (const obstacle of this.obstacles) {
      if (!obstacle.mesh || obstacle.maxHealth === undefined) continue;
      obstacle.health = obstacle.maxHealth;
      obstacle.mesh.visible = true;
      this.visuals.damageCrate(obstacle.mesh, 1);
    }

    this.barrels = built.barrels.map((barrel) => ({ ...barrel, active: true }));
    for (const barrel of this.barrels) barrel.mesh.visible = true;

    this.arenaHazardTimer = arena.hazard.interval;
    this.clearArenaEvents();
  }

  private clearHazards() {
    for (const hazard of this.hazards) {
      this.scene.remove(hazard.mesh);
      this.visuals.disposeObject(hazard.mesh);
    }
    this.hazards = [];
  }

  private clearArenaEvents() {
    for (const event of this.arenaEvents) {
      this.scene.remove(event.marker);
      this.visuals.disposeObject(event.marker);
      if (event.payload) {
        this.scene.remove(event.payload);
        this.visuals.disposeObject(event.payload);
      }
    }
    this.arenaEvents = [];
  }

  private addArenaProp(prop: ArenaProp) {
    switch (prop.kind) {
      case "block":
        this.addObstacle(prop.x, prop.z, prop.width, prop.depth, prop.color);
        break;
      case "barricade":
        this.addBarricade(prop.x, prop.z, prop.width, prop.depth, prop.rotation);
        break;
      case "barrel":
        this.addBarrel(prop.x, prop.z);
        break;
      case "furnace":
        this.addFurnaceBeacon(prop.x, prop.z);
        break;
      case "trafficBarricade":
        this.addTrafficBarricade(prop.x, prop.z, prop.rotation ?? 0);
        break;
      case "cone":
        this.addTrafficCone(prop.x, prop.z);
        break;
      case "pallet":
        this.addPallet(prop.x, prop.z);
        break;
      case "slime":
        this.addSlimePool(prop.x, prop.z, prop.radius ?? 1.4);
        break;
      case "vat":
        this.addToxicVat(prop.x, prop.z);
        break;
      case "generator":
        this.addGenerator(prop.x, prop.z);
        break;
      case "floodlight":
        this.addFloodlight(prop.x, prop.z, prop.color);
        break;
      case "crate":
        this.addCrate(prop.x, prop.z, prop.hp ?? CRATE_BASE_HP, prop.rotation ?? 0);
        break;
    }
  }

  /**
   * Destructible cover.
   *
   * The obstacle keeps a reference to its own mesh, which nothing else in the
   * list does, because removing it needs both halves — the collider so enemies
   * stop pathing around a hole, and the mesh so the player can see that they
   * just spent a magazine opening a lane.
   */
  private addCrate(x: number, z: number, hp: number, rotation: number) {
    const crate = this.visuals.createSupplyCrate();
    crate.position.set(x, 0, z);
    crate.rotation.y = rotation;
    this.arenaRoot.add(crate);
    const half = 0.8;
    this.obstacles.push({ x, z, hx: half, hz: half, health: hp, maxHealth: hp, mesh: crate });
  }

  private addFurnaceBeacon(x: number, z: number) {
    const beacon = this.visuals.createFurnaceBeacon();
    beacon.position.set(x, 0, z);
    this.arenaRoot.add(beacon);
    const radius = 0.6;
    this.obstacles.push({ x, z, hx: radius, hz: radius, radius });
  }

  private addTrafficBarricade(x: number, z: number, rotation = 0) {
    const barricade = this.visuals.createTrafficBarricade(2.4);
    barricade.position.set(x, 0, z);
    barricade.rotation.y = rotation;
    this.arenaRoot.add(barricade);
    const hx = 1.2;
    const hz = 0.3;
    this.obstacles.push({ x, z, hx, hz });
  }

  private addTrafficCone(x: number, z: number) {
    const cone = this.visuals.createTrafficCone();
    cone.position.set(x, 0, z);
    this.arenaRoot.add(cone);
  }

  private addPallet(x: number, z: number) {
    const pallet = this.visuals.createPallet();
    pallet.position.set(x, 0, z);
    this.arenaRoot.add(pallet);
  }

  private addSlimePool(x: number, z: number, radius = 1.4) {
    const pool = this.visuals.createSlimePool(radius);
    pool.position.set(x, 0, z);
    this.arenaRoot.add(pool);
  }

  private addToxicVat(x: number, z: number) {
    const vat = this.visuals.createToxicVat();
    vat.position.set(x, 0, z);
    this.arenaRoot.add(vat);
    const radius = 1.35;
    this.obstacles.push({ x, z, hx: radius, hz: radius, radius });
  }

  private addGenerator(x: number, z: number) {
    const gen = this.visuals.createGenerator();
    gen.position.set(x, 0, z);
    this.arenaRoot.add(gen);
    const hx = 1.3;
    const hz = 0.85;
    this.obstacles.push({ x, z, hx, hz });
  }

  private addObstacle(x: number, z: number, width: number, depth: number, color: number) {
    const structure = this.visuals.createDepotStructure(width, depth, color);
    structure.position.set(x, 0, z);
    this.arenaRoot.add(structure);
    this.obstacles.push({ x, z, hx: width / 2, hz: depth / 2 });
  }

  private addBarricade(x: number, z: number, width: number, depth: number, rotation: number) {
    const barricade = this.visuals.createBarricade(width, depth);
    barricade.position.set(x, 0, z);
    barricade.rotation.y = rotation;
    this.arenaRoot.add(barricade);
    const hx = Math.abs(Math.cos(rotation) * width / 2) + Math.abs(Math.sin(rotation) * depth / 2);
    const hz = Math.abs(Math.sin(rotation) * width / 2) + Math.abs(Math.cos(rotation) * depth / 2);
    this.obstacles.push({ x, z, hx, hz });
  }

  private addFloodlight(x: number, z: number, color: number) {
    // Fixture only. A real spotlight would paint a soft gradient pool on the
    // floor, which fights the flat cel surfaces; the lens reads as lit on its own.
    const fixture = this.visuals.createFloodlight(color);
    fixture.position.set(x, 0, z);
    this.arenaRoot.add(fixture);
  }

  private addBarrel(x: number, z: number) {
    const group = this.visuals.createBarrel();
    group.position.set(x, 0, z);
    this.arenaRoot.add(group);
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

    if (this.playerHealth <= 0 && this.perksInitialised) {
      // Dead stays dead. This runs on every profile commit — including the one
      // that banks a checkpoint on death — and the old `!this.playerHealth`
      // guard treated 0 HP as "uninitialised" and silently healed the corpse
      // back to full, so the death screen reported 100% health.
      this.moveSpeed = 6.2 * (1 + perks.mobility * 0.06);
      this.pickupRadius = 2.2 + perks.magnet * 1.3;
      return;
    }

    if (!this.perksInitialised || this.playerHealth === previousMax) {
      this.playerHealth = this.maxHealth;
    } else {
      // A mid-run vitality purchase grants the new headroom immediately.
      this.playerHealth = Math.min(
        this.maxHealth,
        this.playerHealth + Math.max(0, this.maxHealth - previousMax),
      );
    }

    this.perksInitialised = true;
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
    // Rolled exactly once: it is random, so a second call would announce one
    // modifier and apply a different one.
    this.waveModifier = rollWaveModifier(wave);
    this.hazardBloomTimer = this.waveModifier?.hazardInterval ?? 0;

    // Swapping the arena also restores its cover, so this runs every wave and
    // not only when the layout actually changes.
    const arena = getArenaForWave(wave);
    const arenaChanged = this.currentArena?.id !== arena.id;
    this.buildArena(arena);

    const definition = getWaveDefinition(wave);
    // Relocating is the bigger news: when the arena changes it leads, and the
    // modifier rides along, because walking into an unfamiliar layout expecting
    // the old cover is how a run ends without the player knowing why.
    const modifierNote = this.waveModifier
      ? ` · ${this.waveModifier.icon} ${this.waveModifier.name.toUpperCase()}`
      : "";
    this.announcement = arenaChanged
      ? `Wave ${wave}: ${arena.name.toUpperCase()} — ${arena.blurb}${modifierNote}`
      : this.waveModifier
        ? `Wave ${wave}: ${this.waveModifier.icon} ${this.waveModifier.name.toUpperCase()} — ${this.waveModifier.blurb}`
        : `Wave ${wave}: ${definition.label}`;
    this.announcementTimer = arenaChanged ? 3.8 : this.waveModifier ? 3.4 : 2.6;
    this.callbacks.onWaveChange(wave);
    const countMult = this.waveModifier?.countMult ?? 1;
    for (const [id, count] of Object.entries(definition.enemies)) {
      // Bosses are never multiplied — a swarm wave should not spawn two titans.
      const total =
        id === "juggernaut" ? (count ?? 0) : Math.max(1, Math.round((count ?? 0) * countMult));
      for (let i = 0; i < total; i += 1) this.spawnQueue.push(id as EnemyId);
    }
    this.shuffle(this.spawnQueue);
    this.spawnTimer = 0.2;
    this.emitHud(true);
  }

  private spawnEnemy(type: EnemyId) {
    const definition = ENEMIES[type];
    const candidate = new THREE.Vector3();
    let valid = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const edge = Math.floor(Math.random() * 4);
      // Spawn along open arena corridors, keeping 3.5m clearance away from extreme corner pockets
      const span = THREE.MathUtils.randFloat(-13.5, 13.5);
      if (edge === 0) candidate.set(span, 0, -16.0);
      else if (edge === 1) candidate.set(span, 0, 16.0);
      else if (edge === 2) candidate.set(-16.0, 0, span);
      else candidate.set(16.0, 0, span);

      if (candidate.distanceTo(this.playerMesh.position) < 5.5) continue;
      if (this.pointInsideObstacle(candidate.x, candidate.z, definition.radius + 0.8)) continue;
      valid = true;
      break;
    }
    if (!valid) candidate.set(12, 0, 12);

    // Every archetype scales with wave depth; without this a wave-20 shambler
    // would be identical to a wave-1 one and endless mode would be a formality.
    // Recomputed per spawn so an armory purchase mid-run takes effect on the
    // very next wave rather than at the next restart.
    const scaling = getWaveScaling(this.wave, getProfilePower(this.profile));

    const eliteChance = this.waveModifier?.eliteChance ?? 0.22;
    const isElite = this.wave >= 4 && type !== "juggernaut" && Math.random() < eliteChance;
    let affix: EliteAffix | undefined;
    let shieldMesh: THREE.Mesh | undefined;
    let shieldHp: number | undefined;

    const rig = this.visuals.createEnemy(type, definition, isElite);
    const mesh = rig.root;
    mesh.position.copy(candidate);

    if (isElite) {
      const affixes: EliteAffix[] = ["shielded", "frenzy", "toxic"];
      affix = affixes[Math.floor(Math.random() * affixes.length)];
      if (affix === "shielded") {
        // Scaled like health. A flat 90 was a real wall at wave 4 and a single
        // rifle round by the time endless got going.
        shieldHp = Math.round(90 * scaling.health);
        shieldMesh = this.visuals.createEliteShieldMesh(definition.radius * 1.3);
        mesh.add(shieldMesh);
      }
    }

    const healthBar = this.visuals.createEnemyHealthBar(
      Math.max(0.9, definition.radius * 1.9),
    );
    healthBar.position.y = definition.radius * 2.4 + 1.1;
    mesh.add(healthBar);

    this.scene.add(mesh);

    const modHealth = this.waveModifier?.healthMult ?? 1;
    let health = definition.health * scaling.health * modHealth;
    if (type === "juggernaut") {
      if (this.wave <= 5) {
        health = 680 * scaling.health; // Wave 5 Prototype Juggernaut (Mk-I)
        this.announcement = "⚠️ PROTOTYPE JUGGERNAUT DETECTED!";
        this.announcementTimer = 3.5;
        this.audio.playBossPhaseShift();
      } else {
        health = 1850 * scaling.health; // Wave 10 Titan Dreadnought Prime
        this.announcement = "🔥 TITAN DREADNOUGHT PRIME HAS ARRIVED!";
        this.announcementTimer = 4.0;
        this.audio.playBossPhaseShift();
      }
    } else if (isElite) {
      health = Math.round(definition.health * scaling.health * modHealth * 1.4);
    }

    this.enemies.push({
      type,
      definition,
      healthBar,
      windupTimer: 0,
      // Fixed per spawn so an enemy commits to one approach lane instead of
      // oscillating between them frame to frame.
      flankAngle: THREE.MathUtils.randFloatSpread(2) * BEHAVIOURS[type].flankSpread,
      stuckTimer: 0,
      unstickTimer: 0,
      unstickSign: Math.random() < 0.5 ? -1 : 1,
      speed: getEnemySpeed(definition.speed, this.wave, this.waveModifier),
      damage: definition.damage * scaling.damage,
      reward: Math.round(definition.reward * scaling.reward),
      mesh,
      rig,
      health: Math.round(health),
      maxHealth: Math.round(health),
      attackCooldown: Math.random() * 0.5,
      specialCooldown: 2 + Math.random() * 2,
      chargeRemaining: 0,
      hitFlash: 0,
      knockback: new THREE.Vector3(),
      affix,
      isElite,
      shieldHp,
      shieldMesh,
      bossPhase: type === "juggernaut" ? 1 : undefined,
    });
  }

  private createPickup(type: PickupId, position: THREE.Vector3, value: number) {
    const definition = PICKUPS[type];
    const group = new THREE.Group();
    if (type === "coin") {
      const coin = new THREE.Mesh(this.coinGeometry, this.coinMaterial);
      coin.rotation.x = Math.PI / 2;
      group.add(coin);
    } else {
      const box = new THREE.Mesh(
        this.crateGeometry,
        type === "health" ? this.healthMaterial : this.ammoMaterial,
      );
      group.add(box);
      if (type === "health") {
        const crossA = new THREE.Mesh(this.crossGeometryA, this.crossMaterial);
        const crossB = new THREE.Mesh(this.crossGeometryB, this.crossMaterial);
        crossA.position.y = crossB.position.y = 0.22;
        group.add(crossA, crossB);
      }
    }

    let haloMaterial = this.haloMaterials.get(type);
    if (!haloMaterial) {
      haloMaterial = new THREE.MeshBasicMaterial({ color: definition.color, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
      this.haloMaterials.set(type, haloMaterial);
    }
    const halo = new THREE.Mesh(this.haloGeometry, haloMaterial);
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

  private tracerGeometry(id: WeaponId, scale: number): THREE.CylinderGeometry {
    const key = `${id}:${scale.toFixed(2)}`;
    const cached = this.tracerGeometries.get(key);
    if (cached) return cached;

    const length = (id === "rifle" ? 1.0 : id === "shotgun" ? 0.4 : 0.65) * scale;
    const geometry = new THREE.CylinderGeometry(
      (id === "shotgun" ? 0.035 : id === "rifle" ? 0.038 : 0.024) * scale,
      (id === "shotgun" ? 0.05 : id === "rifle" ? 0.048 : 0.032) * scale,
      length,
      8,
    );
    this.tracerGeometries.set(key, geometry);
    return geometry;
  }

  private tracerMaterial(color: number): THREE.MeshBasicMaterial {
    const cached = this.tracerMaterials.get(color);
    if (cached) return cached;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.tracerMaterials.set(color, material);
    return material;
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

    this.bulletCount += 1;
    this.stats.shotsFired += stats.pellets;

    // Adrenaline Surge synergy: +40% fire rate when below 45% HP
    const adrenalineRank = this.adrenalineRank();
    const fireRateMult = 1 + 0.3 * adrenalineRank;
    state.cooldown = 1 / (stats.fireRate * fireRateMult);

    // Multi-layered audio gunshot
    this.audio.playShoot(id);

    // Subtle, clean weapon model recoil kickback
    const recoilWeight = id === "shotgun" ? 0.35 : id === "rifle" ? 0.2 : id === "pistol" ? 0.12 : 0.08;
    if (this.playerRig) {
      this.visuals.applyWeaponRecoil(this.playerRig, recoilWeight);
    }

    // Gentle camera recoil
    this.cameraRecoil.addScaledVector(this.aim, -0.025 * recoilWeight);

    const origin = this.playerRig
      ? this.playerRig.muzzle.getWorldPosition(new THREE.Vector3())
      : this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.8, 1.25, this.aim.z * 0.8));

    const baseKnockback = id === "shotgun" ? 14 : id === "rifle" ? 9 : id === "pistol" ? 5.5 : 3.2;

    // High Caliber & Synergy modifiers
    const highCaliberRank = this.activeSynergies.get("high_caliber") ?? 0;
    const damageMult = 1 + 0.25 * highCaliberRank;
    const bulletScale = 1 + 0.25 * highCaliberRank;
    const knockbackMult = 1 + 0.5 * highCaliberRank;

    const piercingRank = this.activeSynergies.get("piercing") ?? 0;
    const ricochetRank = this.activeSynergies.get("ricochet") ?? 0;

    // Dynamic Element Bullet Tint
    let bulletColor = stats.color;
    if (this.activeSynergies.has("cryo_frost")) {
      bulletColor = 0x00f0ff; // Bright icy frost cyan
    } else if (this.activeSynergies.has("incendiary")) {
      bulletColor = 0xff3d00; // Blazing flame orange
    } else if (this.activeSynergies.has("tesla_arcs")) {
      bulletColor = 0x00f5d4; // Electric lightning cyan
    }

    for (let pellet = 0; pellet < stats.pellets; pellet += 1) {
      const angle = Math.atan2(this.aim.z, this.aim.x) + THREE.MathUtils.randFloatSpread(stats.spread * 2);
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));

      const bullet = new THREE.Mesh(
        this.tracerGeometry(id, bulletScale),
        this.tracerMaterial(bulletColor),
      );
      bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      bullet.position.copy(origin);
      this.scene.add(bullet);
      this.projectiles.push({
        mesh: bullet,
        velocity: direction.clone().multiplyScalar(id === "shotgun" ? 34 : id === "rifle" ? 45 : 38),
        direction: direction.clone(),
        damage: stats.damage * damageMult,
        knockback: baseKnockback * knockbackMult,
        life: 1.35,
        enemy: false,
        maxPierces: piercingRank,
        pierceCount: 0,
        bouncesRemaining: ricochetRank,
        hitEnemies: new Set(),
      });
    }

    const flash = this.visuals.createMuzzleFlashMesh(bulletColor);
    flash.position.copy(origin).addScaledVector(this.aim, 0.14);
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.aim);
    this.scene.add(flash);
    this.effects.push({ mesh: flash, life: 0.032, maxLife: 0.032 });

    // Smooth subtle camera feedback
    this.cameraShake = Math.max(this.cameraShake, id === "shotgun" ? 0.06 : id === "rifle" ? 0.03 : 0.012);
    if (state.magazine === 0 && state.reserve > 0) this.reloadWeapon(id);
  }

  /** Adrenaline Surge rank, or 0 while above the health threshold. */
  private adrenalineRank() {
    if (this.playerHealth / this.maxHealth > 0.45) return 0;
    return this.activeSynergies.get("adrenaline_surge") ?? 0;
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
    const reloadMult = Math.max(0.4, 1 - 0.2 * this.adrenalineRank());
    state.reloading = stats.reload * reloadMult;
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
      (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) + this.virtualMove.x,
      0,
      (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0) + this.virtualMove.y,
    );
    const hasInput = inputDir.lengthSq() > 0;
    if (hasInput) inputDir.normalize();

    // Natural responsive acceleration & deceleration friction
    // +12% move speed per Adrenaline stack while wounded, as advertised.
    const adrenalineSpeed = 1 + 0.12 * this.adrenalineRank();
    const targetSpeed = this.dashRemaining > 0 ? 18.5 : this.moveSpeed * adrenalineSpeed;
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
      // Dynamic roll/lean during turns and dash
      const strafeTilt = (this.playerVelocity.x * Math.cos(this.playerMesh.rotation.y) - this.playerVelocity.z * Math.sin(this.playerMesh.rotation.y)) * 0.024;
      this.playerRig.body.rotation.z = THREE.MathUtils.lerp(
        this.playerRig.body.rotation.z,
        strafeTilt + (this.dashRemaining > 0 ? -0.22 : 0),
        1 - Math.exp(-dt * 18),
      );
    }

    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.dashRemaining > 0) {
      const wasDashing = this.dashRemaining;
      this.dashRemaining = Math.max(0, this.dashRemaining - dt);

      // Caustic Jet: lay a damaging trail along the dash path.
      const acidRank = this.activeSynergies.get("acid_dash") ?? 0;
      if (acidRank > 0) {
        this.acidTrailTimer -= dt;
        if (this.acidTrailTimer <= 0) {
          this.acidTrailTimer = 0.05;
          this.spawnHazard(this.playerMesh.position, 1.15, 40 * acidRank, 3.2);
        }
      }

      // Seismic Surge: the blast fires as the dash ends, not as it begins.
      const kineticRank = this.activeSynergies.get("kinetic_impact") ?? 0;
      if (kineticRank > 0 && wasDashing > 0 && this.dashRemaining === 0) {
        this.detonateSeismicSurge(kineticRank);
      }
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
    if (this.usingTouchControls) {
      if (this.enemies.length === 0) {
        this.touchAimTarget = null;
        this.hideTouchAimIndicator();
        if (this.virtualMove.lengthSq() > 0.01) {
          this.aim.set(this.virtualMove.x, 0, this.virtualMove.y).normalize();
        }
        return;
      }

      const previousTarget = this.touchAimTarget;
      const target = selectTouchAimTarget(
        this.enemies,
        (enemy) => enemy.mesh.position.distanceToSquared(this.playerMesh.position),
        previousTarget,
      );
      if (!target) return;
      this.touchAimTarget = target;
      if (target !== previousTarget) this.touchAimLockPulse = 1;
      this.updateTouchAimIndicator(target);
      this.mouseWorldPos.copy(target.mesh.position);
      const dir = target.mesh.position.clone().sub(this.playerMesh.position).setY(0);
      if (dir.lengthSq() > 0.0001) {
        this.aim.copy(dir.normalize());
      }
      return;
    }
    this.hideTouchAimIndicator();
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.mouseWorldPos.copy(hit);
      this.aim.copy(hit.clone().sub(this.playerMesh.position)).setY(0);
      if (this.aim.lengthSq() > 0.01) this.aim.normalize();
    }
  }

  private updateTouchAimIndicator(target: EnemyEntity) {
    const indicator = this.touchAimIndicator;
    if (!indicator) return;

    indicator.visible = true;
    indicator.position.copy(target.mesh.position).setY(0.085);
    indicator.rotation.y = this.missionElapsed * 1.7;

    this.touchAimLockPulse = Math.max(0, this.touchAimLockPulse - FIXED_STEP * 4.5);
    const breathe = this.profile.settings.reducedMotion
      ? 0
      : Math.sin(this.missionElapsed * 7) * 0.035;
    const targetRadius = Math.max(0.92, target.definition.radius * 1.12);
    const lockScale = targetRadius * (1 + breathe + this.touchAimLockPulse * 0.18);
    indicator.scale.setScalar(lockScale);
    this.renderer.domElement.dataset.autoAimTarget = target.type;
  }

  private hideTouchAimIndicator() {
    if (this.touchAimIndicator) this.touchAimIndicator.visible = false;
    delete this.renderer.domElement.dataset.autoAimTarget;
  }

  private updateWave(dt: number) {
    if (!this.waveActive) return;

    // Toxic Bloom seeds hazards away from the player, so the arena itself
    // shrinks over the wave rather than punishing you where you already stand.
    const bloom = this.waveModifier?.hazardInterval;
    if (bloom) {
      this.hazardBloomTimer -= dt;
      if (this.hazardBloomTimer <= 0) {
        this.hazardBloomTimer = bloom;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const x = THREE.MathUtils.randFloatSpread(30);
          const z = THREE.MathUtils.randFloatSpread(30);
          if (Math.hypot(x - this.playerMesh.position.x, z - this.playerMesh.position.z) < 5) continue;
          if (this.pointInsideObstacle(x, z, 1.4)) continue;
          this.spawnHazard(new THREE.Vector3(x, 0, z), 1.9, 26, 9);
          break;
        }
      }
    }
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemies.length < MAX_ACTIVE_ENEMIES) {
        const type = this.spawnQueue.shift();
        if (type) this.spawnEnemy(type);
        this.spawnTimer = getWaveDefinition(this.wave).spawnInterval;
      }
    } else if (this.enemies.length === 0) {
      if (this.wave >= CAMPAIGN_WAVES && !this.endless) {
        this.waveActive = false;
        this.stats.wavesCleared += 1;
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
            this.stats.wavesCleared += 1;
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

    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      // Burn damage below can kill a boomer, whose detonation removes several
      // more enemies, leaving this index past the end of a now-shorter array.
      const enemy = this.enemies[index];
      if (!enemy) continue;

      // Burning Damage-over-time
      if (enemy.burningTimer && enemy.burningTimer > 0) {
        enemy.burningTimer -= dt;
        const burnDamage = (enemy.burnDps ?? 22) * dt;
        enemy.health -= burnDamage;
        this.stats.damageDealt += burnDamage;
        enemy.hitFlash = Math.max(enemy.hitFlash, 0.06);
        if (enemy.health <= 0) {
          this.killEnemy(enemy);
          continue;
        }
      }

      // Cryo Chilled timer
      if (enemy.chilledTimer && enemy.chilledTimer > 0) {
        enemy.chilledTimer -= dt;
      }

      // Toxic Elite slime dropping
      if (enemy.affix === "toxic" && Math.random() < 0.035) {
        this.visuals.addAcidDecal(this.scene, enemy.mesh.position, 0.55);
      }

      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      enemy.specialCooldown = Math.max(0, enemy.specialCooldown - dt);
      enemy.chargeRemaining = Math.max(0, enemy.chargeRemaining - dt);
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);

      // Juggernaut Multi-Phase Transition & Logic
      if (enemy.type === "juggernaut") {
        const hpRatio = enemy.health / enemy.maxHealth;
        if (this.wave <= 5) {
          // Wave 5 Prototype Juggernaut: 2 Phases
          if (hpRatio <= 0.5 && (enemy.bossPhase ?? 1) < 2) {
            enemy.bossPhase = 2;
            this.audio.playBossPhaseShift();
            this.announcement = "⚠️ PROTOTYPE JUGGERNAUT PHASE 2: GROUND SLAM!";
            this.announcementTimer = 3.2;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "PHASE 2! 💥", "comic-slam");
            this.spawnReinforcements("runner", 2);
          }
        } else {
          // Wave 10 Titan Dreadnought Prime: 3 Phases
          if (hpRatio <= 0.33 && (enemy.bossPhase ?? 1) < 3) {
            enemy.bossPhase = 3;
            this.audio.playBossPhaseShift();
            this.announcement = "🔥 TITAN ENRAGED: BERSERK STRIKES!";
            this.announcementTimer = 3.5;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "BERSERK! 😡", "comic-rage");
            this.spawnReinforcements("runner", 4);
          } else if (hpRatio <= 0.66 && hpRatio > 0.33 && (enemy.bossPhase ?? 1) < 2) {
            enemy.bossPhase = 2;
            this.audio.playBossPhaseShift();
            this.announcement = "⚠️ TITAN PHASE 2: GROUND SLAM & SHOCKWAVES!";
            this.announcementTimer = 3.2;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "PHASE 2! 💥", "comic-slam");
            this.spawnReinforcements("runner", 3);
          }
        }
      }

      // Apply and decay physical bullet knockback.
      //
      // Routed through resolveEnemyPosition like ordinary movement: applying it
      // straight to the position let shoved enemies pass through obstacles and
      // leave the arena entirely, which then read as them teleporting when the
      // chase step clamped them back in.
      if (enemy.knockback.lengthSq() > 0.001) {
        this.enemyCandidate.set(
          enemy.mesh.position.x + enemy.knockback.x * dt,
          0,
          enemy.mesh.position.z + enemy.knockback.z * dt,
        );
        this.resolveEnemyPosition(this.enemyCandidate, enemy.definition.radius);
        enemy.mesh.position.x = this.enemyCandidate.x;
        enemy.mesh.position.z = this.enemyCandidate.z;
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
      // What the locomotion clip should be told. A retreating spitter used to
      // report zero and slid backwards in its idle pose.
      let animSpeed = 0;

      const standoff = BEHAVIOURS[enemy.type].standoff;
      // Ranged types hold their range and retreat when crowded, so ignoring a
      // spitter costs you rather than letting you walk it down at leisure.
      if (standoff !== undefined && distance < standoff * 0.62 && enemy.windupTimer <= 0) {
        const retreat = enemy.speed * ((enemy.chilledTimer ?? 0) > 0 ? 0.5 : 1) * 0.85;
        animSpeed = retreat;
        this.enemyCandidate.set(
          enemy.mesh.position.x - towardX * retreat * dt,
          0,
          enemy.mesh.position.z - towardZ * retreat * dt,
        );
        this.resolveEnemyPosition(this.enemyCandidate, enemy.definition.radius);
        enemy.mesh.position.x = this.enemyCandidate.x;
        enemy.mesh.position.z = this.enemyCandidate.z;
        if (enemy.attackCooldown <= 0) {
          this.enemyCandidate.set(towardX, 0, towardZ);
          this.spawnEnemyProjectile(enemy, this.enemyCandidate);
          enemy.attackCooldown = enemy.definition.attackCooldown;
        }
      } else if (enemy.type === "spitter" && distance < enemy.definition.attackRange && distance > 3.8) {
        if (enemy.attackCooldown <= 0) {
          this.enemyCandidate.set(towardX, 0, towardZ);
          this.spawnEnemyProjectile(enemy, this.enemyCandidate);
          enemy.attackCooldown = enemy.definition.attackCooldown;
        }
      } else {
        if (enemy.type === "juggernaut") {
          const phase = enemy.bossPhase ?? 1;
          if (phase === 2 && enemy.specialCooldown <= 0 && distance < 8.2) {
            enemy.specialCooldown = 5.2;
            const shock = this.visuals.createShockwaveMesh(6.2, 0xff0044);
            shock.position.copy(enemy.mesh.position);
            this.scene.add(shock);
            this.effects.push({ mesh: shock, life: 0.5, maxLife: 0.5 });
            this.audio.playGroundSlam();
            this.cameraShake = Math.max(this.cameraShake, 0.75);
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.2), "GROUND SLAM! 💥", "comic-slam");
            if (distance < 6.2 && this.dashRemaining <= 0) {
              this.damagePlayer(36);
            }
          } else if (phase !== 2 && enemy.specialCooldown <= 0 && distance > 4.2) {
            enemy.chargeRemaining = phase === 3 ? 1.4 : 1.1;
            enemy.specialCooldown = phase === 3 ? 3.6 : 5.4;
            this.announcement = phase === 3 ? "🔥 RELENTLESS BERSERK CHARGE!" : "⚠️ Juggernaut charge incoming!";
            this.announcementTimer = 1.3;
            if (phase === 3) {
              this.visuals.addAcidDecal(this.scene, enemy.mesh.position, 0.8);
            }
          }
        }

        const behaviour = BEHAVIOURS[enemy.type];

        if (enemy.windupTimer > 0) {
          // Committed to a swing: hold position and resolve when it lands.
          enemy.windupTimer -= dt;
          if (enemy.windupTimer <= 0) {
            this.clearTelegraph(enemy);
            // The swing can be dodged — stepping or dashing out of range
            // between the tell and the landing makes it whiff.
            if (distance <= enemy.definition.attackRange + 0.35) {
              this.damagePlayer(Math.round(enemy.damage));
            } else {
              this.spawnFloatingText(
                enemy.mesh.position.clone().setY(1.6 * enemy.rig.scale),
                "MISS!",
                "ammo",
              );
            }
            enemy.attackCooldown = enemy.definition.attackCooldown;
          }
        } else if (distance <= enemy.definition.attackRange) {
          if (enemy.attackCooldown <= 0) {
            enemy.windupTimer = behaviour.windup;
            this.showTelegraph(enemy);
          }
        } else {
          const isChilled = (enemy.chilledTimer ?? 0) > 0;
          const baseSpeed = enemy.affix === "frenzy" ? getFrenzySpeed(enemy.speed) : enemy.speed;
          const chilledMult = isChilled ? (enemy.chillMult ?? 0.7) : 1.0;
          const chargeMult = enemy.chargeRemaining > 0 ? (enemy.bossPhase === 3 ? 3.8 : 3.3) : 1;
          const speed = baseSpeed * chilledMult * chargeMult;
          animSpeed = baseSpeed * (enemy.chargeRemaining > 0 ? 2.2 : 1);

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

          // Obstacle avoidance steering
          let obstacleAvoidX = 0;
          let obstacleAvoidZ = 0;
          for (const obstacle of this.obstacles) {
            const odx = enemy.mesh.position.x - obstacle.x;
            const odz = enemy.mesh.position.z - obstacle.z;
            const distSq = odx * odx + odz * odz;
            const detectRadius = (obstacle.radius ?? Math.max(obstacle.hx, obstacle.hz)) + enemy.definition.radius + 1.4;
            if (distSq < detectRadius * detectRadius && distSq > 0.001) {
              const d = Math.sqrt(distSq);
              const push = (detectRadius - d) / detectRadius;
              obstacleAvoidX += (odx / d) * push * 1.6;
              obstacleAvoidZ += (odz / d) * push * 1.6;
            }
          }

          // Corner unclamping / arena center attraction if close to arena corners
          let cornerNudgeX = 0;
          let cornerNudgeZ = 0;
          const absX = Math.abs(enemy.mesh.position.x);
          const absZ = Math.abs(enemy.mesh.position.z);
          if (absX > 14.5 && absZ > 14.5) {
            const centerDist = Math.hypot(enemy.mesh.position.x, enemy.mesh.position.z) || 1;
            cornerNudgeX = (-enemy.mesh.position.x / centerDist) * 1.2;
            cornerNudgeZ = (-enemy.mesh.position.z / centerDist) * 1.2;
          } else if (absX > 16.2) {
            cornerNudgeX = -Math.sign(enemy.mesh.position.x) * 0.9;
          } else if (absZ > 16.2) {
            cornerNudgeZ = -Math.sign(enemy.mesh.position.z) * 0.9;
          }

          // Flanking: approach along a rotated bearing rather than straight at
          // the player, converging only once close. Without this every enemy
          // steered at the same point and the horde arrived as one clump from
          // a single direction, trivially kited in a circle.
          let approachX = towardX;
          let approachZ = towardZ;
          if (enemy.flankAngle !== 0) {
            // Blend the offset out as they close, so the final commit is direct.
            const closing = THREE.MathUtils.clamp((distance - 2.2) / 7, 0, 1);
            const angle = enemy.flankAngle * closing;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            approachX = towardX * cos - towardZ * sin;
            approachZ = towardX * sin + towardZ * cos;
          }

          // Sidestep while wedged: steer across the blockage instead of into
          // it, and stop fighting the obstacle-avoidance push so the enemy can
          // slide along a surface rather than being held against it.
          if (enemy.unstickTimer > 0) {
            enemy.unstickTimer -= dt;
            const across = enemy.unstickSign * 1.35;
            const cos = Math.cos(across);
            const sin = Math.sin(across);
            const sx = approachX * cos - approachZ * sin;
            const sz = approachX * sin + approachZ * cos;
            approachX = sx;
            approachZ = sz;
            obstacleAvoidX *= 0.25;
            obstacleAvoidZ *= 0.25;
          }

          let directionX = approachX + separationX * 0.78 + obstacleAvoidX * 0.85 + cornerNudgeX;
          let directionZ = approachZ + separationZ * 0.78 + obstacleAvoidZ * 0.85 + cornerNudgeZ;
          const directionLength = Math.hypot(directionX, directionZ) || 1;
          directionX /= directionLength;
          directionZ /= directionLength;
          facingX = directionX;
          facingZ = directionZ;

          const beforeX = enemy.mesh.position.x;
          const beforeZ = enemy.mesh.position.z;
          const intended = speed * dt;
          this.enemyCandidate.set(
            beforeX + directionX * intended,
            0,
            beforeZ + directionZ * intended,
          );
          this.resolveEnemyPosition(this.enemyCandidate, enemy.definition.radius);
          enemy.mesh.position.x = this.enemyCandidate.x;
          enemy.mesh.position.z = this.enemyCandidate.z;

          // Wedge detection. Collision resolution can pin a body at a fixed
          // point between two obstacles: every step is pushed straight back, so
          // the enemy "walks" forever without moving. It bites the juggernaut
          // in particular because its 1.55 radius is the largest, so it fits
          // gaps the smaller archetypes pass straight through. Rather than
          // enumerate problem geometry, detect the symptom — trying to move and
          // not moving — and sidestep out.
          const movedX = enemy.mesh.position.x - beforeX;
          const movedZ = enemy.mesh.position.z - beforeZ;
          const moved = Math.hypot(movedX, movedZ);
          if (intended > 0.0001 && moved < intended * 0.3) {
            enemy.stuckTimer += dt;
            if (enemy.stuckTimer > 0.45 && enemy.unstickTimer <= 0) {
              enemy.unstickTimer = 1.1;
              enemy.stuckTimer = 0;
            }
          } else if (enemy.unstickTimer <= 0) {
            enemy.stuckTimer = 0;
          }
        }
      }

      if (enemy.healthBar) {
        const ratio = Math.max(0, Math.min(1, enemy.health / enemy.maxHealth));
        // The mobile lock target keeps its bar at full health: together with
        // the ring, this answers both "what am I aiming at?" and "how close is
        // it to dying?" without filling the whole crowd with UI.
        enemy.healthBar.visible = ratio < 0.999 || (this.usingTouchControls && enemy === this.touchAimTarget);
        if (enemy.healthBar.visible) {
          const fill = enemy.healthBar.getObjectByName("hp-fill");
          if (fill) {
            fill.scale.x = Math.max(0.001, ratio);
            // Scaling a centred quad shrinks both ends; shift it back to left-align.
            fill.position.x = -((1 - ratio) * (Math.max(0.9, enemy.definition.radius * 1.9) - 0.06)) / 2;
          }
          // Billboard: cancel the parent's yaw so the bar always faces camera.
          enemy.healthBar.rotation.set(-0.62, -enemy.mesh.rotation.y, 0);
        }
      }

      if (enemy.telegraph) {
        enemy.telegraph.position.copy(enemy.mesh.position).setY(0.05);
        // Shrink toward the strike so the timing is readable at a glance.
        const behaviour = BEHAVIOURS[enemy.type];
        const progress = 1 - enemy.windupTimer / Math.max(0.0001, behaviour.windup);
        enemy.telegraph.scale.setScalar(1 - progress * 0.45);
      }

      const isChilled = (enemy.chilledTimer ?? 0) > 0;
      const isBurning = (enemy.burningTimer ?? 0) > 0;
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
        animSpeed,
        // Swing animation runs during the wind-up, not on mere proximity —
        // the animation IS the tell the player reads.
        enemy.windupTimer > 0,
        enemy.hitFlash,
        isChilled,
        isBurning,
      );
    }
  }

  /**
   * Boss phase adds. Spawned directly while there is room, otherwise pushed to
   * the front of the queue so the active-enemy cap holds during a titan fight.
   */
  private spawnReinforcements(type: EnemyId, count: number) {
    for (let i = 0; i < count; i += 1) {
      if (this.enemies.length < MAX_ACTIVE_ENEMIES) this.spawnEnemy(type);
      else this.spawnQueue.unshift(type);
    }
  }

  private spawnEnemyProjectile(enemy: EnemyEntity, direction: THREE.Vector3) {
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.spitCoreGeometry, this.spitCoreMaterial);
    const aura = new THREE.Mesh(this.spitAuraGeometry, this.spitAuraMaterial);
    group.add(core, aura);
    group.position.copy(enemy.mesh.position).add(new THREE.Vector3(0, 1.25, 0));
    this.scene.add(group);
    this.projectiles.push({
      mesh: group,
      velocity: direction.clone().multiplyScalar(9.0),
      direction: direction.clone(),
      damage: Math.round(enemy.damage),
      knockback: 4,
      life: 2.2,
      enemy: true,
    });
    this.audio.tone(155, 0.16, 0.04, "sine");
  }

  private explodeBoomer(enemy: EnemyEntity) {
    const position = enemy.mesh.position.clone();
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const other = this.enemies[index];
      if (!other || other === enemy) continue;
      const distance = other.mesh.position.distanceTo(position);
      if (distance < 5.8) {
        const pushDir = other.mesh.position.clone().sub(position).setY(0).normalize();
        this.damageEnemy(other, 180 * (1 - distance / 7.0), 16, pushDir, "splash");
      }
    }
    if (this.playerMesh.position.distanceTo(position) < 5.8) {
      this.damagePlayer(28);
    }

    const blastMaterial = new THREE.MeshBasicMaterial({ color: 0x39ff14, transparent: true, opacity: 0.78, wireframe: true });
    const blast = new THREE.Mesh(this.boomerBlastGeometry, blastMaterial);
    markTransient(blast, { materials: [blastMaterial] });
    blast.position.copy(position).setY(1.0);
    this.scene.add(blast);
    this.effects.push({ mesh: blast, life: 0.45, maxLife: 0.45 });

    this.visuals.addAcidDecal(this.scene, position, 1.6);
    this.cameraShake = Math.max(this.cameraShake, 0.75);
    this.audio.playBoomerDetonation();
    this.spawnFloatingText(position.clone().setY(1.6), "BOOM! 💥", "comic-boom");
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
      const struck = this.obstacleAt(projectile.mesh.position.x, projectile.mesh.position.z);
      if (struck) {
        // Player fire opens lanes; enemy spit does not, so the layout only ever
        // changes as a result of a decision the player made.
        if (!projectile.enemy && struck.health !== undefined) {
          this.damageObstacle(struck, projectile.damage, projectile.mesh.position);
          this.removeProjectile(index);
          continue;
        }
        if (projectile.bouncesRemaining && projectile.bouncesRemaining > 0) {
          projectile.bouncesRemaining -= 1;
          projectile.velocity.x *= -1;
          projectile.velocity.z *= -1;
          // Steer towards nearest enemy if available
          let closestDist = 12.0;
          let closestEnemy: EnemyEntity | null = null;
          for (const enemy of this.enemies) {
            const d = enemy.mesh.position.distanceTo(projectile.mesh.position);
            if (d < closestDist) {
              closestDist = d;
              closestEnemy = enemy;
            }
          }
          if (closestEnemy) {
            const steer = closestEnemy.mesh.position.clone().sub(projectile.mesh.position).setY(0).normalize();
            projectile.velocity.copy(steer.multiplyScalar(38));
            projectile.direction.copy(steer);
          }
          this.audio.tone(420, 0.03, 0.04, "triangle");
          continue;
        }
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
        // One hit can detonate a boomer, whose blast kills several more, so the
        // array can be shorter than when this loop captured its start index.
        const enemy = this.enemies[enemyIndex];
        if (!enemy) continue;
        if (projectile.hitEnemies?.has(enemy)) continue;
        const dx = projectile.mesh.position.x - enemy.mesh.position.x;
        const dz = projectile.mesh.position.z - enemy.mesh.position.z;
        if (dx * dx + dz * dz <= (enemy.definition.radius + 0.2) ** 2) {
          if (!projectile.hitEnemies) projectile.hitEnemies = new Set();
          projectile.hitEnemies.add(enemy);

          this.damageEnemy(
            enemy,
            projectile.damage,
            projectile.knockback,
            projectile.direction,
            projectile.isShrapnel ? "shrapnel" : "bullet",
          );
          projectile.pierceCount = (projectile.pierceCount ?? 0) + 1;

          if (projectile.pierceCount > (projectile.maxPierces ?? 0)) {
            this.removeProjectile(index);
            hit = true;
            break;
          }
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
    source: DamageSource = "splash",
  ) {
    if (source === "bullet") this.stats.shotsHit += 1;

    // Frontal Armor check on Juggernaut Phase 1
    if (enemy.type === "juggernaut" && (enemy.bossPhase ?? 1) === 1) {
      const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), enemy.mesh.rotation.y);
      if (bulletDir.dot(forward) < -0.28) {
        damage = Math.max(1, Math.round(damage * 0.45));
        this.spawnFloatingText(enemy.mesh.position.clone().setY(2.2), "ARMORED! 🛡️", "damage");
        this.audio.tone(160, 0.04, 0.06, "square");
      }
    }

    // Elite Shield check
    if (enemy.shieldHp && enemy.shieldHp > 0) {
      enemy.shieldHp -= damage;
      this.stats.damageDealt += damage;
      enemy.hitFlash = 0.08;
      if (enemy.shieldHp <= 0) {
        enemy.shieldHp = 0;
        if (enemy.shieldMesh) {
          enemy.mesh.remove(enemy.shieldMesh);
          this.visuals.disposeObject(enemy.shieldMesh);
          enemy.shieldMesh = undefined;
        }
        this.audio.playShieldBreak();
        this.spawnFloatingText(enemy.mesh.position.clone().setY(1.6), "SHIELD BROKEN!", "comic-shield");
      } else {
        this.spawnFloatingText(enemy.mesh.position.clone().setY(1.4), `${damage} 🛡️`, "ammo");
      }
      this.audio.playHit(false);
      return;
    }

    const isChilled = (enemy.chilledTimer ?? 0) > 0;
    const critChance = 0.2 + (isChilled ? 0.15 : 0);
    const isCrit = Math.random() < critChance;
    const finalDamage = isCrit ? Math.round(damage * 1.55) : Math.round(damage);

    enemy.health -= finalDamage;
    enemy.hitFlash = 0.12;
    this.stats.damageDealt += finalDamage;

    const hitPos = enemy.mesh.position.clone().setY(1.05 * enemy.rig.scale);

    // Status synergies
    const incendiaryRank = this.activeSynergies.get("incendiary") ?? 0;
    if (incendiaryRank > 0) {
      const wasBurning = (enemy.burningTimer ?? 0) > 0;
      enemy.burningTimer = 3.8;
      enemy.burnDps = 22 * incendiaryRank;
      if (!wasBurning || isCrit) {
        this.spawnFloatingText(hitPos.clone().add(new THREE.Vector3(0, 0.3, 0)), "IGNITE! 🔥", "comic-boom");
      }
    }
    const cryoRank = this.activeSynergies.get("cryo_frost") ?? 0;
    if (cryoRank > 0) {
      const wasChilled = (enemy.chilledTimer ?? 0) > 0;
      enemy.chilledTimer = 4.2;
      // -30% speed per stack, floored so a chilled enemy never fully freezes.
      enemy.chillMult = Math.max(0.25, 1 - 0.3 * cryoRank);
      if (!wasChilled || isCrit) {
        this.spawnFloatingText(hitPos.clone().add(new THREE.Vector3(0, 0.3, 0)), "FREEZE! ❄️", "comic-zap");
        this.audio.playFreeze();
      }
    }

    // Vampiric Leech heal on crit
    if (this.activeSynergies.has("vampiric_leech") && isCrit) {
      const heal = 4 * (this.activeSynergies.get("vampiric_leech") ?? 1);
      this.playerHealth = Math.min(this.maxHealth, this.playerHealth + heal);
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.3), `+${heal} HP 🩸`, "comic-leech");
    }

    // Phantom Reflex reset on elite/boss hit
    const phantomRank = this.activeSynergies.get("phantom_reflex") ?? 0;
    if (phantomRank > 0 && (enemy.isElite || enemy.type === "juggernaut")) {
      this.dashCooldown = Math.max(0, this.dashCooldown - 0.7 * phantomRank);
    }

    // Tesla Arcs Chain Lightning. The every-fourth-bullet trigger is a bullet
    // trigger: a shrapnel needle or a barrel blast landing on the right count
    // is not what the card promised.
    if (this.activeSynergies.has("tesla_arcs") && (isCrit || (source === "bullet" && this.bulletCount % 4 === 0))) {
      const teslaRank = this.activeSynergies.get("tesla_arcs") ?? 1;
      const zapDamage = 35 * teslaRank;
      const nearby = this.enemies
        .filter((e) => e !== enemy && e.mesh.position.distanceTo(enemy.mesh.position) < 7.2)
        .slice(0, 3);
      if (nearby.length > 0) {
        const points = [hitPos];
        for (const target of nearby) {
          points.push(target.mesh.position.clone().setY(1.0));
          target.health -= zapDamage;
          target.hitFlash = 0.12;
          this.stats.damageDealt += zapDamage;
          this.spawnFloatingText(target.mesh.position.clone().setY(1.3), `${zapDamage} ⚡`, "comic-zap");
        }
        const lightning = this.visuals.createChainLightningMesh(points);
        this.scene.add(lightning);
        this.effects.push({ mesh: lightning, life: 0.14, maxLife: 0.14 });
        this.audio.playChainLightning();
        this.spawnFloatingText(hitPos, "ZAP! ⚡", "comic-zap");
      }
    }

    // Shrapnel burst on crit.
    //
    // Needles spawn at the victim's centre, so without excluding it they all
    // struck the same body on the next frame — the card was a flat crit bonus
    // rather than a spray. And each of those needle hits could itself crit and
    // spawn four more; with Cryo Core's +15% crit that branching went past 1
    // and a single lucky shot into a chilled crowd became a self-sustaining
    // needle storm. Shrapnel comes from bullets only.
    if (this.activeSynergies.has("shrapnel") && isCrit && source === "bullet") {
      const shrapnelRank = this.activeSynergies.get("shrapnel") ?? 1;
      for (let s = 0; s < 4; s += 1) {
        const sAngle = Math.random() * Math.PI * 2;
        const sDir = new THREE.Vector3(Math.cos(sAngle), 0, Math.sin(sAngle));
        const needle = new THREE.Mesh(this.needleGeometry, this.needleMaterial);
        needle.position.copy(enemy.mesh.position).setY(1.0);
        needle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sDir);
        this.scene.add(needle);
        this.projectiles.push({
          mesh: needle,
          velocity: sDir.clone().multiplyScalar(28),
          direction: sDir,
          damage: Math.round(damage * 0.4 * shrapnelRank),
          knockback: 3,
          life: 0.45,
          enemy: false,
          isShrapnel: true,
          maxPierces: 0,
          pierceCount: 0,
          hitEnemies: new Set([enemy]),
        });
      }
    }

    // Impart physical bullet knockback
    const effectiveKnockback =
      enemy.type === "juggernaut"
        ? knockbackForce * 0.15
        : enemy.type === "brute"
          ? knockbackForce * 0.45
          : knockbackForce;
    enemy.knockback.addScaledVector(bulletDir, effectiveKnockback);
    // Knockback accumulated without limit, so a single shotgun blast — six
    // pellets, each up to 2.5x from Magnum Overpressure — stacked into a
    // several-hundred-unit impulse and launched the target across the arena.
    // Cap the resulting speed so a hit always reads as a shove, never a punt.
    if (enemy.knockback.lengthSq() > MAX_KNOCKBACK_SPEED * MAX_KNOCKBACK_SPEED) {
      enemy.knockback.setLength(MAX_KNOCKBACK_SPEED);
    }

    this.createDirectionalHitBurst(hitPos, bulletDir, enemy.type === "spitter" || enemy.type === "boomer");

    // Tactile micro hit-stop on crits or heavy kills, rate limited so that
    // holding the trigger can never hold the simulation still.
    if ((isCrit || finalDamage >= 60) && this.hitStopCooldown <= 0) {
      this.hitStopTimer = HIT_STOP_DURATION;
      this.hitStopCooldown = HIT_STOP_COOLDOWN;
    }

    this.spawnFloatingText(hitPos, isCrit ? `CRIT ${finalDamage}!` : `${finalDamage}`, isCrit ? "crit" : "damage");
    this.audio.playHit(isCrit);

    if (enemy.health <= 0) this.killEnemy(enemy);
  }

  /**
   * Kill anything sitting at or below zero health.
   *
   * Chain lightning and the burning-corpse splash subtract health directly
   * without a death check, because they hit enemies other than the one being
   * processed and cannot safely splice the array mid-iteration. That left
   * enemies walking around on negative health until some later bullet happened
   * to touch them — at which point they died instantly to a single shot, which
   * looked like they were randomly vanishing. Sweeping once per frame keeps
   * those indirect damage sources honest without any mid-loop mutation.
   */
  private reapDead() {
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      // A reaped boomer detonates and can splice several entries out from
      // under this loop, so the array may be shorter than when we started.
      // Anything skipped by the shift is simply caught on the next frame.
      const enemy = this.enemies[index];
      if (enemy && enemy.health <= 0) this.killEnemy(enemy);
    }
  }

  /** Ring under an enemy that is mid-swing — the cue the player reads. */
  private showTelegraph(enemy: EnemyEntity) {
    if (enemy.telegraph) return;
    const ring = this.visuals.createTelegraphCircle(enemy.definition.attackRange + 0.35);
    ring.position.copy(enemy.mesh.position).setY(0.05);
    this.scene.add(ring);
    enemy.telegraph = ring;
    this.audio.tone(190, 0.07, 0.03, "square");
  }

  private clearTelegraph(enemy: EnemyEntity) {
    if (!enemy.telegraph) return;
    this.scene.remove(enemy.telegraph);
    this.visuals.disposeObject(enemy.telegraph);
    enemy.telegraph = undefined;
  }

  private killEnemy(enemy: EnemyEntity) {
    // Look the index up rather than trusting a caller's. Cascading deaths — a
    // boomer chain, a barrel chain — splice the array between the moment an
    // index is captured and the moment it is used, so a stale index removes a
    // live enemy and leaves the dead one walking around.
    const index = this.enemies.indexOf(enemy);
    if (index < 0) return;
    this.stats.kills += 1;
    if (enemy.isElite) this.stats.eliteKills += 1;
    if (enemy.type === "juggernaut") this.stats.bossKills += 1;
    if (this.touchAimTarget === enemy) {
      this.touchAimTarget = null;
      this.hideTouchAimIndicator();
    }
    this.clearTelegraph(enemy);
    const position = enemy.mesh.position.clone();
    this.visuals.disposeCharacter(enemy.rig);
    this.scene.remove(enemy.mesh);
    this.enemies.splice(index, 1);

    if (enemy.type === "boomer") {
      this.explodeBoomer(enemy);
    } else if (enemy.type === "spitter") {
      this.visuals.addAcidDecal(this.scene, position, 1.1);
    } else {
      this.visuals.addBloodDecal(
        this.scene,
        position,
        enemy.type === "juggernaut" ? 1.8 : enemy.type === "brute" ? 1.3 : 0.85,
      );
    }

    // Burning enemy death flame burst
    if (enemy.burningTimer && enemy.burningTimer > 0) {
      const burstDamage = 35;
      for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
        const other = this.enemies[i];
        if (other.mesh.position.distanceTo(position) < 3.2) {
          other.health -= burstDamage;
          this.stats.damageDealt += burstDamage;
          other.burningTimer = 2.5;
        }
      }
    }

    this.comboCount += 1;
    this.comboTimer = 2.8;
    this.stats.peakCombo = Math.max(this.stats.peakCombo, this.comboCount);

    // Spider-Verse Pop-Art Comic Sound Word Bubbles on Kill
    const comicKillWords = ["BAM! 💥", "POW! 💥", "KRAAKOOM! ⚡", "SMASH! 💫", "K.O.! 🥊", "WHAM! 💫"];
    if (enemy.isElite || enemy.type === "juggernaut" || Math.random() < 0.32) {
      const word = enemy.type === "juggernaut"
        ? "KRAAKOOM! 💥"
        : comicKillWords[Math.floor(Math.random() * comicKillWords.length)];
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.4, 0)), word, "comic-boom");
    }

    let milestone = false;
    if (this.comboCount === 3) {
      milestone = true;
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.8, 0)), "3x COMBO!", "combo");
    } else if (this.comboCount === 5) {
      milestone = true;
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.8, 0)), "5x MULTI-KILL!", "combo");
    } else if (this.comboCount === 8) {
      milestone = true;
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.8, 0)), "8x RAMPAGE!", "combo");
    } else if (this.comboCount >= 10 && this.comboCount % 5 === 0) {
      milestone = true;
      this.spawnFloatingText(position.clone().add(new THREE.Vector3(0, 1.8, 0)), `${this.comboCount}x UNSTOPPABLE!`, "combo");
    }

    // Vampiric Leech advertises a heal on multi-kill combos as well as crits;
    // only the crit half had ever been wired up.
    const leechRank = this.activeSynergies.get("vampiric_leech") ?? 0;
    if (milestone && leechRank > 0 && this.playerHealth > 0) {
      const heal = 4 * leechRank;
      this.playerHealth = Math.min(this.maxHealth, this.playerHealth + heal);
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.3), `+${heal} HP 🩸`, "comic-leech");
    }

    this.createPickup("coin", position, enemy.reward);
    if (Math.random() < 0.18 || (this.activeAmmoTotal() < 5 && Math.random() < 0.75)) {
      this.createPickup("ammo", position.clone().add(new THREE.Vector3(0.55, 0, 0)), 1);
    }
    if (Math.random() < 0.08) {
      this.createPickup("health", position.clone().add(new THREE.Vector3(-0.55, 0, 0)), 25);
    }

    // Cloned: the fade animates opacity, and one shared material had every
    // simultaneous death ring fading at whichever effect updated last.
    const burstMaterial = this.deathBurstMaterial.clone();
    const burst = new THREE.Mesh(this.deathBurstGeometry, burstMaterial);
    markTransient(burst, { materials: [burstMaterial] });
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
      if (!enemy) continue;
      const distance = enemy.mesh.position.distanceTo(position);
      if (distance < 5.6) {
        const pushDir = enemy.mesh.position.clone().sub(position).setY(0).normalize();
        this.damageEnemy(enemy, 200 * (1 - distance / 6.5), 18, pushDir, "splash");
      }
    }

    const blastMaterial = new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.75, wireframe: true });
    const blast = new THREE.Mesh(this.barrelBlastGeometry, blastMaterial);
    markTransient(blast, { materials: [blastMaterial] });
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
      const material = new THREE.MeshBasicMaterial({ color: colors[particle % colors.length], transparent: true, opacity: 0.9 });
      const burst = new THREE.Mesh(this.hitSparkGeometries[particle], material);
      markTransient(burst, { materials: [material] });
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

  /** Drop a lingering damage zone on the ground. */
  private spawnHazard(position: THREE.Vector3, radius: number, dps: number, life: number) {
    const pool = this.visuals.createSlimePool(radius);
    pool.position.set(position.x, 0.03, position.z);
    this.scene.add(pool);
    this.hazards.push({
      mesh: pool,
      x: position.x,
      z: position.z,
      radius,
      dps,
      life,
      maxLife: life,
      tickTimer: 0,
    });
    // Cap the trail so a long dash-heavy run cannot accumulate unbounded zones.
    while (this.hazards.length > 40) {
      const oldest = this.hazards.shift();
      if (oldest) {
        this.scene.remove(oldest.mesh);
        this.visuals.disposeObject(oldest.mesh);
      }
    }
  }

  /** Seismic Surge: a 360 degree shove-and-damage burst around the player. */
  private detonateSeismicSurge(rank: number) {
    const radius = 5.4;
    const origin = this.playerMesh.position.clone();

    const shock = this.visuals.createShockwaveMesh(radius, COMIC.electric);
    shock.position.copy(origin).setY(0.08);
    this.scene.add(shock);
    this.effects.push({ mesh: shock, life: 0.42, maxLife: 0.42 });
    this.audio.playGroundSlam();
    this.cameraShake = Math.max(this.cameraShake, 0.4);
    this.spawnFloatingText(origin.clone().setY(1.5), "SEISMIC SURGE! 💫", "comic-slam");

    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const dx = enemy.mesh.position.x - origin.x;
      const dz = enemy.mesh.position.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance > radius) continue;
      const push = new THREE.Vector3(dx, 0, dz).normalize();
      this.damageEnemy(enemy, 85 * rank, 15, push, "splash");
      // Stagger: interrupt any wind-up so the burst buys real breathing room.
      enemy.windupTimer = 0;
      this.clearTelegraph(enemy);
    }
  }

  /**
   * The arena's own standing rule.
   *
   * Every hazard here hurts the player as well as the infected. An arena that
   * only ever damages the enemy is scenery — the player learns nothing from it
   * and never has to move. The cost of that is that all of them telegraph, and
   * all of them are escapable by walking.
   */
  private updateArenaHazards(dt: number) {
    const hazard = this.currentArena?.hazard;
    if (!hazard || hazard.id === "none") return;

    if (this.waveActive || this.arenaEvents.length > 0) {
      this.arenaHazardTimer -= dt;
      if (this.arenaHazardTimer <= 0 && this.waveActive) {
        this.arenaHazardTimer = hazard.interval;
        this.spawnArenaEvent(hazard.id, hazard);
      }
    }

    for (let index = this.arenaEvents.length - 1; index >= 0; index -= 1) {
      const event = this.arenaEvents[index];
      event.timer -= dt;

      if (event.kind === "surge" && event.payload) {
        // Expands through the telegraph so the ring you see is the ring that
        // will hit you, just smaller.
        const progress = 1 - Math.max(0, event.timer) / Math.max(0.001, event.radius / 9);
        event.payload.scale.setScalar(0.4 + progress * event.radius);
      }
      if (event.kind === "debris" && event.payload) {
        // Freefall onto the marker.
        event.payload.position.y = Math.max(0.35, event.payload.position.y - 26 * dt);
        event.payload.rotation.y += dt * 1.4;
      }

      if (event.timer > 0) continue;
      this.resolveArenaEvent(event);
      this.scene.remove(event.marker);
      this.visuals.disposeObject(event.marker);
      if (event.payload) {
        this.scene.remove(event.payload);
        this.visuals.disposeObject(event.payload);
      }
      this.arenaEvents.splice(index, 1);
    }
  }

  private spawnArenaEvent(kind: "debris" | "surge", hazard: { telegraph: number; damage: number; radius: number }) {
    if (kind === "surge") {
      // One ring from the beacon outward. Every direction is an escape, so the
      // answer is always "keep moving" and never "memorise the safe tile".
      const ring = this.visuals.createSurgeRing();
      ring.position.set(0, 0.05, 0);
      ring.scale.setScalar(0.4);
      this.scene.add(ring);
      const marker = this.visuals.createTelegraphCircle(2.0);
      marker.position.set(0, 0.03, 0);
      this.scene.add(marker);
      this.arenaEvents.push({
        kind,
        x: 0,
        z: 0,
        // The ring sweeps out to the arena edge; radius here is the band width
        // checked against at resolve time.
        radius: hazard.radius,
        damage: hazard.damage,
        timer: ARENA_LIMIT / 9,
        marker,
        payload: ring,
      });
      this.audio.tone(120, 0.5, 0.06, "sawtooth");
      return;
    }

    // Debris drops near the player but never exactly on them — landing on the
    // player's current tile is unreactable, and reactable is the whole point.
    const angle = Math.random() * Math.PI * 2;
    const distance = 3.5 + Math.random() * 5;
    const x = THREE.MathUtils.clamp(this.playerMesh.position.x + Math.cos(angle) * distance, -16, 16);
    const z = THREE.MathUtils.clamp(this.playerMesh.position.z + Math.sin(angle) * distance, -16, 16);

    const marker = this.visuals.createTelegraphCircle(hazard.radius);
    marker.position.set(x, 0.03, z);
    this.scene.add(marker);

    const slab = this.visuals.createDebrisSlab();
    slab.position.set(x, 16, z);
    this.scene.add(slab);

    this.arenaEvents.push({
      kind,
      x,
      z,
      radius: hazard.radius,
      damage: hazard.damage,
      timer: hazard.telegraph,
      marker,
      payload: slab,
    });
    this.audio.tone(90, 0.18, 0.05, "sawtooth");
  }

  private resolveArenaEvent(event: ArenaEvent) {
    if (event.kind === "debris") {
      const impact = new THREE.Vector3(event.x, 0, event.z);
      for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
        const enemy = this.enemies[index];
        if (!enemy) continue;
        if (enemy.mesh.position.distanceTo(impact) > event.radius + enemy.definition.radius) continue;
        const push = enemy.mesh.position.clone().sub(impact).setY(0).normalize();
        this.damageEnemy(enemy, event.damage * 3, 9, push, "splash");
      }
      if (this.playerMesh.position.distanceTo(impact) <= event.radius + 0.5) {
        this.damagePlayer(event.damage);
      }
      this.visuals.addBloodDecal(this.scene, impact, 0.9);
      this.cameraShake = Math.max(this.cameraShake, 0.55);
      this.audio.playGroundSlam();
      return;
    }

    // Surge: the ring has reached the wall, so anything still outside the
    // beacon pad takes the hit.
    const inner = ARENA_LIMIT - event.radius;
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const distance = Math.hypot(enemy.mesh.position.x, enemy.mesh.position.z);
      if (distance < inner) continue;
      const push = enemy.mesh.position.clone().setY(0).normalize().multiplyScalar(-1);
      this.damageEnemy(enemy, event.damage * 2.5, 6, push, "splash");
    }
    const playerDistance = Math.hypot(this.playerMesh.position.x, this.playerMesh.position.z);
    if (playerDistance >= inner) {
      this.damagePlayer(event.damage);
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.8), "ZAP!", "comic-zap");
    }
    this.cameraShake = Math.max(this.cameraShake, 0.4);
    this.audio.playChainLightning();
  }

  private updateHazards(dt: number) {
    for (let index = this.hazards.length - 1; index >= 0; index -= 1) {
      const hazard = this.hazards[index];
      hazard.life -= dt;
      hazard.tickTimer -= dt;

      const fade = Math.max(0, hazard.life / hazard.maxLife);
      hazard.mesh.scale.setScalar(0.6 + fade * 0.4);

      // Tick at 5Hz rather than per frame: cheaper, and damage numbers stay
      // readable instead of spraying sixty popups a second.
      if (hazard.tickTimer <= 0) {
        hazard.tickTimer = 0.2;
        for (let e = this.enemies.length - 1; e >= 0; e -= 1) {
          const enemy = this.enemies[e];
          if (!enemy) continue;
          const dx = enemy.mesh.position.x - hazard.x;
          const dz = enemy.mesh.position.z - hazard.z;
          if (dx * dx + dz * dz > (hazard.radius + enemy.definition.radius) ** 2) continue;
          enemy.health -= hazard.dps * 0.2;
          this.stats.damageDealt += hazard.dps * 0.2;
          enemy.hitFlash = Math.max(enemy.hitFlash, 0.05);
        }
      }

      if (hazard.life <= 0) {
        this.scene.remove(hazard.mesh);
        this.visuals.disposeObject(hazard.mesh);
        this.hazards.splice(index, 1);
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
          const mat = child.material as THREE.Material;
          // Opaque materials are shared and cached; only per-instance
          // transparent ones are safe to animate.
          if (mat.transparent) mat.opacity = Math.max(0, 1 - progress);
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
    const dealt = Math.min(this.playerHealth, amount);
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.stats.damageTaken += dealt;
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
    type:
      | "damage"
      | "crit"
      | "coin"
      | "health"
      | "ammo"
      | "player-damage"
      | "combo"
      | "comic-zap"
      | "comic-boom"
      | "comic-slam"
      | "comic-shield"
      | "comic-leech"
      | "comic-rage"
      | "comic-freeze"
      | "comic-speed",
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

    // Oldest out first. Without a ceiling a shotgun into a crowd stacked
    // hundreds of animating DOM nodes and the layout thread paid for it.
    while (this.floatingLayer.childElementCount >= MAX_FLOATING_POPUPS) {
      this.floatingLayer.firstElementChild?.remove();
    }
    this.floatingLayer.appendChild(span);
    setTimeout(() => {
      span.remove();
    }, 680);
  }

  private activeAmmoTotal() {
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    return state ? state.magazine + state.reserve : 0;
  }

  private resolveEnemyPosition(position: THREE.Vector3, radius: number) {
    const boundary = ARENA_LIMIT - radius - 0.25;
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
        // Continuous smooth rounded AABB capsule sliding
        const clampedX = THREE.MathUtils.clamp(position.x, obstacle.x - obstacle.hx, obstacle.x + obstacle.hx);
        const clampedZ = THREE.MathUtils.clamp(position.z, obstacle.z - obstacle.hz, obstacle.z + obstacle.hz);
        const dx = position.x - clampedX;
        const dz = position.z - clampedZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < radius * radius) {
          const dist = Math.sqrt(distSq) || 0.001;
          const nx = dx / dist;
          const nz = dz / dist;
          position.x = clampedX + nx * radius;
          position.z = clampedZ + nz * radius;
        }
      }
    }
    // Hard clamp within playable arena perimeter to prevent corner wedging
    position.x = THREE.MathUtils.clamp(position.x, -boundary, boundary);
    position.z = THREE.MathUtils.clamp(position.z, -boundary, boundary);
    return position;
  }

  private obstacleAt(x: number, z: number, padding = 0): Obstacle | null {
    for (const obstacle of this.obstacles) {
      if (obstacle.radius) {
        const dx = x - obstacle.x;
        const dz = z - obstacle.z;
        const r = obstacle.radius + padding;
        if (dx * dx + dz * dz <= r * r) return obstacle;
      } else if (
        Math.abs(x - obstacle.x) <= obstacle.hx + padding &&
        Math.abs(z - obstacle.z) <= obstacle.hz + padding
      ) {
        return obstacle;
      }
    }
    return null;
  }

  private pointInsideObstacle(x: number, z: number, padding = 0) {
    return this.obstacleAt(x, z, padding) !== null;
  }

  /**
   * Chip a destructible crate, removing it once it gives out.
   *
   * Returns true if the shot was absorbed. Crates are the one piece of cover
   * the player can edit, so the feedback has to be immediate: the tint steps
   * down on every hit rather than only at the moment it breaks.
   */
  private damageObstacle(obstacle: Obstacle, damage: number, at: THREE.Vector3): boolean {
    if (obstacle.health === undefined || obstacle.maxHealth === undefined) return false;
    obstacle.health -= damage;

    if (obstacle.health > 0) {
      if (obstacle.mesh) this.visuals.damageCrate(obstacle.mesh, obstacle.health / obstacle.maxHealth);
      this.audio.tone(180, 0.05, 0.05, "square");
      this.spawnFloatingText(at.clone().setY(1.1), "CRACK!", "comic-slam");
      return true;
    }

    if (obstacle.mesh) {
      obstacle.mesh.visible = false;
      const burst = this.visuals.createRadialSpeedLinesMesh(COMIC.rust);
      burst.position.set(obstacle.x, 0.6, obstacle.z);
      this.scene.add(burst);
      this.effects.push({ mesh: burst, life: 0.32, maxLife: 0.32 });
    }
    const index = this.obstacles.indexOf(obstacle);
    if (index >= 0) this.obstacles.splice(index, 1);
    this.spawnFloatingText(at.clone().setY(1.3), "SMASH!", "comic-boom");
    this.audio.playExplosion();
    this.cameraShake = Math.max(this.cameraShake, 0.24);
    return true;
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
    // Kept on the render surface for browser/device diagnostics. This lets the
    // mobile regression suite prove that a joystick gesture moves the actual
    // simulation rather than merely animating the on-screen knob.
    this.renderer.domElement.dataset.playerX = this.playerMesh.position.x.toFixed(3);
    this.renderer.domElement.dataset.playerZ = this.playerMesh.position.z.toFixed(3);
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    const boss = this.enemies.find((enemy) => enemy.type === "juggernaut");
    const bossName = boss
      ? this.wave <= 5
        ? "PROTOTYPE TITAN // MK-I"
        : "TITAN DREADNOUGHT // PRIME"
      : undefined;
    const bossMaxPhases = boss ? (this.wave <= 5 ? 2 : 3) : undefined;
    this.callbacks.onHud({
      health: this.playerHealth,
      maxHealth: this.maxHealth,
      wave: this.wave,
      endless: this.endless,
      modifier: this.waveModifier
        ? { name: this.waveModifier.name, icon: this.waveModifier.icon }
        : undefined,
      enemies: this.enemies.length + this.spawnQueue.length,
      weapon: id,
      weaponName: WEAPONS[id].name,
      magazine: state?.magazine ?? 0,
      reserve: state?.reserve ?? 0,
      reloading: state?.reloading ?? 0,
      dash: 1 - Math.min(1, this.dashCooldown / 2.8),
      bossHealth: boss?.health,
      bossMaxHealth: boss?.maxHealth,
      bossPhase: boss?.bossPhase ?? (boss ? 1 : undefined),
      bossMaxPhases,
      bossName,
      activeSynergies: Object.fromEntries(this.activeSynergies),
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

    // Ticked before the early return, so a freeze cannot extend its own gate.
    this.hitStopCooldown = Math.max(0, this.hitStopCooldown - dt);

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
    this.updateHazards(dt);
    this.updateArenaHazards(dt);
    // After projectiles, so indirect damage (chain lightning, burn splash,
    // explosions) resolves into deaths on the same frame it was dealt.
    this.reapDead();
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.updateAtmosphere();
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
    const posZ = this.cameraLook.z + CAMERA_BACK + this.cameraRecoil.z + offsetZ;
    this.camera.position.set(posX, CAMERA_HEIGHT, posZ);

    const targetX = this.cameraLook.x + this.cameraRecoil.x * 0.5;
    const targetZ = this.cameraLook.z + this.cameraRecoil.z * 0.5;
    this.camera.lookAt(targetX, 0.42, targetZ);

    this.cameraShake = Math.max(0, this.cameraShake - dt * 3.2);

    const dust = this.scene.getObjectByName("ambient-dust");
    if (dust) dust.rotation.y += dt * 0.012;
  }

  /**
   * Wave pressure shifts the backdrop from cool blue toward an angry red sky.
   * Tinting the background beats dimming the scene: the arena stays readable
   * while the panel still gets visibly hotter as the run goes on.
   */
  private updateAtmosphere() {
    const pressure = Math.min(1, (this.wave - 1) / 9);
    // Endless keeps climbing past the campaign, so the score keeps tightening.
    this.audio.setIntensity(this.endless ? 1 : pressure);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.skyCool).lerp(this.skyHot, pressure);
    }
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
      const maximum = Math.min(window.devicePixelRatio, this.maxPixelRatio);
      const minimum = this.qaMode ? 0.5 : this.minPixelRatio;
      const nextRatio =
        this.frameTimeAverage > 0.021
          ? Math.max(minimum, this.pixelRatio - 0.15)
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
      this.post.render(this.scene, this.camera);
      this.qaFramesRendered += 1;
    }
    this.scheduleFrame();
  };

  private resize = () => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.fov = width / height < 0.8 ? 56 : 42;
    this.camera.near = 0.1;
    this.camera.far = 110;
    this.camera.updateProjectionMatrix();
    // Re-place from the live look target rather than snapping back to the
    // origin: while paused this is the frame that gets drawn, and the old
    // reset made the view jump to the arena centre on every resize.
    this.updateCamera(0);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.post?.setSize(width, height);
    if (this.paused && !this.destroyed) this.post?.render(this.scene, this.camera);
  };

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  private onPointerDown = (event: PointerEvent) => {
    // Touch aiming owns the trigger through the on-screen FIRE button. Without
    // this guard any finger that landed on the play field — including the first
    // frame of a drag — opened up, and auto-aim sent the shot wherever it was
    // already pointing.
    if (this.inputMode === "touch") return;
    if (!this.paused && event.button === 0) this.firing = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.firing = false;
  };

  /**
   * A cancelled pointer never reports an "up", so the trigger it opened has to
   * be released here or the weapon fires until the tab loses focus.
   *
   * Touch mode is deliberately exempt: there the trigger belongs to the FIRE
   * button, which tracks native Touch Events precisely because iOS cancels the
   * synthesized pointer while the finger is still down. Honouring that cancel
   * would drop a hold the player is still making.
   */
  private onPointerCancel = () => {
    if (this.inputMode === "touch") return;
    this.firing = false;
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

    if (code === "ShiftLeft" || code === "ShiftRight" || code === "Space") this.startDash();
    if (code === "KeyJ" && this.qaMode) {
      this.damagePlayer(this.playerHealth);
      return;
    }
    if (code === "KeyL" && this.qaMode) {
      // Clear combat pressure but leave the wave active so browser tests can
      // inspect the real extraction-beacon flow before it completes. Start
      // outside the ring so the short hold timer cannot race the assertion.
      for (const enemy of this.enemies) {
        this.clearTelegraph(enemy);
        this.visuals.disposeCharacter(enemy.rig);
        this.scene.remove(enemy.mesh);
      }
      this.enemies = [];
      this.spawnQueue = [];
      this.playerMesh.position.set(6, 0, 0);
      return;
    }
    if (code === "KeyM" && this.qaMode) {
      this.playerMesh.position.set(0, 0, 0);
      return;
    }
    if (code === "KeyK" && this.qaMode) {
      for (const enemy of this.enemies) {
        // Telegraph rings live in the scene, not on the rig, so clearing the
        // enemy list without this leaves them orphaned on the floor.
        this.clearTelegraph(enemy);
        this.visuals.disposeCharacter(enemy.rig);
        this.scene.remove(enemy.mesh);
      }
      this.enemies = [];
      this.spawnQueue = [];
      this.waveActive = false;
      this.pause();
      this.emitHud(true);
      if (this.wave >= CAMPAIGN_WAVES && !this.endless) this.callbacks.onVictory();
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
    this.virtualMove.set(0, 0);
    this.firing = false;
    this.playerVelocity.set(0, 0, 0);
  }

  private startDash() {
    if (this.paused || this.dashCooldown > 0) return;
    const inputDir = new THREE.Vector3(
      (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) + this.virtualMove.x,
      0,
      (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0) + this.virtualMove.y,
    );
    this.dashDirection = inputDir.lengthSq() > 0 ? inputDir.normalize() : this.aim.clone();
    this.dashRemaining = this.dashTotal;
    // Phantom Reflex shortens the cooldown itself — the card advertised this
    // and only the elite-hit refund was ever implemented.
    const phantomRank = this.activeSynergies.get("phantom_reflex") ?? 0;
    this.dashCooldown = 2.8 * Math.max(0.4, 1 - 0.18 * phantomRank);
    this.cameraShake = Math.max(this.cameraShake, 0.18);
    this.audio.playDash();

    // Spider-Verse Dynamic Comic Radial Speed-Lines on Dash
    const speedLines = this.visuals.createRadialSpeedLinesMesh(0x00f0ff);
    speedLines.position.copy(this.playerMesh.position);
    this.scene.add(speedLines);
    this.effects.push({ mesh: speedLines, life: 0.28, maxLife: 0.28 });
    this.spawnFloatingText(this.playerMesh.position.clone().setY(1.4), "SWOOSH! 💨", "comic-speed");
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
    window.addEventListener("orientationchange", this.resize);
    window.visualViewport?.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("blur", this.onFocusLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
  }

  private unbindEvents() {
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("orientationchange", this.resize);
    window.visualViewport?.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
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
