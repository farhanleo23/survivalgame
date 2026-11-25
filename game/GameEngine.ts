import { DamageFeedback, normalizedReloadProgress } from "./presentation";
import {
  ACTIVE_RELOAD_JAM_PENALTY,
  BARREL_CHAIN_DELAY,
  BARREL_CHAIN_RADIUS,
  evaluateActiveReload,
  getActiveFusions,
  getComboSalvageMultiplier,
  OVERCHARGE_CRIT_BONUS,
  OVERCHARGE_DAMAGE_MULT,
  OVERDRIVE_BASE_DURATION,
  OVERDRIVE_DASH_COOLDOWN_MULT,
  OVERDRIVE_FIRE_RATE_MULT,
  OVERDRIVE_KILL_EXTENSION,
  OVERDRIVE_MAX_CHARGE,
  OVERDRIVE_MAX_EXTENSION,
  OVERDRIVE_SHOCKWAVE_RADIUS,
  OVERDRIVE_SPEED_MULT,
  PERFECT_DODGE_DASH_REFUND,
  PERFECT_DODGE_OVERDRIVE_GAIN,
  PERFECT_DODGE_SHOT_BONUS,
  PERFECT_DODGE_SLOWMO_DURATION,
  PERFECT_DODGE_SLOWMO_SCALE,
  rotatedBoxHalfExtents,
  SYNERGY_FUSIONS,
} from "./combat-systems";
import {
  BLADE_COOLDOWN,
  BLADE_DEFLECT_RADIUS,
  BLADE_EXECUTE_HEAL,
  BLADE_EXECUTE_RANGE,
  BLADE_SLASH_DAMAGE,
  BLADE_SLASH_RANGE,
  isEnemyExecutable,
  ORBITAL_POD_FALL_TIME,
  ORBITAL_POD_FIRST_DELAY,
  ORBITAL_POD_IMPACT_RADIUS,
  ORBITAL_POD_INTERVAL,
  pickRandomSuperWeapon,
  pointToSegmentDistanceSq,
  PYLON_COST,
  PYLON_FENCE_DPS,
  PYLON_FENCE_MAX_DIST,
  PYLON_HEALTH,
  PYLON_MAX_ACTIVE,
  PYLON_PULSE_DAMAGE,
  PYLON_PULSE_INTERVAL,
  PYLON_PULSE_RADIUS,
  SUPER_WEAPONS,
  TECH_ENERGY_EXECUTE_GAIN,
  TECH_ENERGY_KILL_GAIN,
  TECH_ENERGY_MAX,
  TECH_ENERGY_REGEN_PER_SEC,
  TECH_ENERGY_START,
  TURRET_COST,
  TURRET_DAMAGE,
  TURRET_FIRE_INTERVAL,
  TURRET_HEALTH,
  TURRET_MAX_ACTIVE,
  TURRET_RANGE,
} from "./tactical-overhaul";
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
import { resolveCircleObstacle, segmentCircleHit, segmentObstacleHit } from "./collision";
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
  SynergyFusionId,
  SuperWeaponId,
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
  specialTelegraph?: THREE.Object3D;
  /** Floating health bar, revealed on first damage. */
  healthBar?: THREE.Group;
  /** Pulsing golden execution marker shown when wounded enough for Cyber-Blade Teleport Execute. */
  executeMarker?: THREE.Group;
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
  /** Guaranteed critical hit (Overdrive or Perfect Dodge shot). */
  forceCrit?: boolean;
  /** Active-reload overcharged round (+15% crit chance). */
  overcharged?: boolean;
  /** Spinning Ripper Sawblade super-weapon projectile. */
  isSawblade?: boolean;
  /** Ignites target on hit (Hellfire Minigun). */
  ignites?: boolean;
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
  /** Countdown until a chain-reaction detonation fires. */
  chainTimer?: number;
}

/** Lingering ground zone that damages enemies (and optionally the player if hostile). */
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
  /** True for environmental/wave-modifier pools (Toxic Bloom) that threaten the operator. */
  hostile?: boolean;
  /** True for Napalm Wake pools that ignite enemies on contact. */
  ignites?: boolean;
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
  weather?: THREE.Points;
  accentLights?: THREE.PointLight[];
}

interface ShellCasingEntity {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

interface FragGrenadeEntity {
  mesh: THREE.Group;
  marker: THREE.Object3D;
  velocity: THREE.Vector3;
  fuse: number;
  maxFuse: number;
  bounced: boolean;
}

interface DeployableEntity {
  kind: "turret" | "pylon";
  mesh: THREE.Group;
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  life: number;
  cooldown: number;
}

interface LaserFenceEntity {
  a: DeployableEntity;
  b: DeployableEntity;
  mesh: THREE.Group;
  tickTimer: number;
}

interface OrbitalPodEntity {
  weaponId: SuperWeaponId;
  x: number;
  z: number;
  state: "falling" | "landed";
  timer: number;
  podMesh: THREE.Group;
  beamMesh?: THREE.Group;
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
// Keep 60 Hz collision steps through ordinary slow frames without allowing an
// unbounded catch-up loop after a stall. Eight steps cover frames down to 7.5 Hz.
const MAX_CATCH_UP_STEPS = 8;
const ARENA_LIMIT = 18.5;
const CAMERA_HEIGHT = 16.2;
const CAMERA_BACK = 13.6;
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
      post: { outlineStrength: 0.58, halftoneStrength: 0.04, grainStrength: 0.003 },
    };
  }
  if (mode === "quality") {
    return {
      initialPixelRatio: mobile ? 1.5 : 1.75,
      minPixelRatio: mobile ? 1.1 : 1.25,
      maxPixelRatio: mobile ? 1.75 : 2,
      shadows: true,
      shadowMapSize: mobile ? 1024 : 2048,
      post: { outlineStrength: 0.58, halftoneStrength: 0.04, grainStrength: 0.003 },
    };
  }
  if (mobile) {
    return {
      initialPixelRatio: 1.25,
      minPixelRatio: 0.9,
      maxPixelRatio: 1.5,
      shadows: true,
      shadowMapSize: 1024,
      post: { outlineStrength: 0.58, halftoneStrength: 0.04, grainStrength: 0.003 },
    };
  }
  return {
    initialPixelRatio: 1.5,
    minPixelRatio: 1,
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    post: { outlineStrength: 0.58, halftoneStrength: 0.04, grainStrength: 0.003 },
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
  private viewportWidth = 1;
  private viewportHeight = 1;
  private playerHealth = 100;
  /** False until the first applyPerks call has seeded health. */
  private perksInitialised = false;
  private maxHealth = 100;
  private missionElapsed = 0;
  private moveSpeed = 6.2;
  private pickupRadius = 2.2;
  private dashCooldown = 0;
  private dashCooldownTotal = 2.8;
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
  private corpses: { rig: CharacterRig; life: number }[] = [];
  private damageFeedback = new DamageFeedback<EnemyEntity>();
  private footstepTravel = 0;
  private effects: EffectEntity[] = [];
  private hazards: HazardEntity[] = [];
  private activeSynergies = new Map<SynergyCardId, number>();
  private unlockedFusions = new Set<SynergyFusionId>();
  private overdriveCharge = 0;
  private overdriveRemaining = 0;
  private overdriveDuration = OVERDRIVE_BASE_DURATION;
  private overdriveExtensionUsed = 0;
  private overdriveAura: THREE.Group | null = null;
  private bulletTimeTimer = 0;
  private bulletTimeScale = 1;
  private dashPerfectUsed = false;
  private perfectDodgeShotBuff = false;
  private baseCameraFov = 42;
  private grenadeCooldown = 0;
  private readonly grenadeCooldownTotal = 8.0;
  private grenades: FragGrenadeEntity[] = [];
  private bladeCooldown = 0;
  private techEnergy = TECH_ENERGY_START;
  private deployables: DeployableEntity[] = [];
  private laserFences: LaserFenceEntity[] = [];
  private orbitalPods: OrbitalPodEntity[] = [];
  private orbitalPodTimer = ORBITAL_POD_FIRST_DELAY;
  private activeSuperWeapon: { id: SuperWeaponId; ammo: number; maxAmmo: number } | null = null;
  private superWeaponCooldown = 0;
  private shellCasings: ShellCasingEntity[] = [];
  private operatorLight: THREE.PointLight | null = null;
  private muzzleLight: THREE.PointLight | null = null;
  private blastLight: THREE.PointLight | null = null;
  private muzzleLightTimer = 0;
  private blastLightTimer = 0;
  private postChromatic = 0;
  private postHitFlash = 0;
  private postOverdrive = 0;
  private activeWeather: THREE.Points | null = null;
  private activeAccentLights: THREE.PointLight[] = [];
  private laserSight: {
    group: THREE.Group;
    beam: THREE.Mesh;
    dot: THREE.Mesh;
    beamMaterial: THREE.MeshBasicMaterial;
    dotMaterial: THREE.MeshBasicMaterial;
  } | null = null;
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
  private projectileStart = new THREE.Vector3();
  private projectileEnd = new THREE.Vector3();
  private projectileNormal = new THREE.Vector3();
  private projectileUp = new THREE.Vector3(0, 1, 0);

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
      this.unlockedFusions.clear();
      this.overdriveCharge = 0;
      this.overdriveRemaining = 0;
      this.overdriveDuration = OVERDRIVE_BASE_DURATION;
      this.overdriveExtensionUsed = 0;
      this.bulletTimeTimer = 0;
      this.perfectDodgeShotBuff = false;
      this.techEnergy = TECH_ENERGY_START;
      this.activeSuperWeapon = null;
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
    const activeFusions = getActiveFusions(this.activeSynergies);
    const newlyUnlocked = activeFusions.find((fusionId) => !this.unlockedFusions.has(fusionId));
    for (const fusionId of activeFusions) this.unlockedFusions.add(fusionId);

    if (newlyUnlocked) {
      const fusion = SYNERGY_FUSIONS[newlyUnlocked];
      this.audio.playFusionUnlock?.();
      this.announcement = `FUSION UNLOCKED: ${fusion.name.toUpperCase()} — ${fusion.description}`;
      this.announcementTimer = 3.8;
    } else {
      this.audio.playPerkSelect();
      this.announcement = `SYNERGY ACQUIRED: ${id.replace(/_/g, " ").toUpperCase()}`;
      this.announcementTimer = 2.4;
    }
    this.emitHud(true);
  }

  getSynergies(): Partial<Record<SynergyCardId, number>> {
    return Object.fromEntries(this.activeSynergies);
  }

  resetSynergies() {
    this.activeSynergies.clear();
    this.unlockedFusions.clear();
    this.emitHud(true);
  }

  /**
   * Re-apply a deck carried across a redeploy, without the per-card fanfare.
   * Replaying `addSynergy` for each stack fired five acquisition stingers at
   * once and left the announcement banner showing whichever card came last.
   */
  restoreSynergies(deck: Partial<Record<SynergyCardId, number>>) {
    this.activeSynergies.clear();
    this.unlockedFusions.clear();
    for (const [id, stacks] of Object.entries(deck)) {
      if (stacks && stacks > 0) this.activeSynergies.set(id as SynergyCardId, stacks);
    }
    for (const fusionId of getActiveFusions(this.activeSynergies)) {
      this.unlockedFusions.add(fusionId);
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
    const previous = this.profile;
    const previousWeapon = this.getActiveWeaponId();
    this.profile = profile;
    if (
      previous.settings === profile.settings && previous.perkRanks === profile.perkRanks &&
      previous.ownedWeapons === profile.ownedWeapons && previous.weaponRanks === profile.weaponRanks &&
      previous.equippedLoadout === profile.equippedLoadout
    ) return;
    if (previous.settings !== profile.settings) this.audio.configure(profile.settings);
    if (previous.perkRanks !== profile.perkRanks) this.applyPerks(profile.perkRanks);
    for (const id of profile.ownedWeapons) {
      this.ensureWeaponState(id);
      const state = this.weaponStates.get(id);
      const nextRank = profile.weaponRanks[id];
      if (state && nextRank > state.rank) {
        const previousStats = getWeaponStats(id, state.rank);
        const nextStats = getWeaponStats(id, nextRank);
        const magGain = Math.max(0, nextStats.magazine - previousStats.magazine);
        state.rank = nextRank;
        state.magazine = Math.min(nextStats.magazine, state.magazine + magGain);
      }
    }
    if (profile.equippedLoadout && profile.equippedLoadout.length) {
      this.loadout = [...profile.equippedLoadout];
    } else if (profile.ownedWeapons && profile.ownedWeapons.length) {
      this.loadout = [...profile.ownedWeapons];
    }
    if (this.playerRig && previousWeapon !== this.getActiveWeaponId()) {
      this.visuals.setPlayerWeapon(this.playerRig, this.getActiveWeaponId());
    }
    this.emitHud(true);
  }

  equipLoadout(ids: WeaponId[]) {
    this.loadout = ids.slice(0, 2);
    if (!this.loadout.length) this.loadout = this.profile.ownedWeapons.length ? [...this.profile.ownedWeapons] : ["pistol"];
    this.activeWeaponIndex = 0;
    for (const id of this.loadout) this.ensureWeaponState(id);
    if (this.playerRig) this.visuals.setPlayerWeapon(this.playerRig, this.getActiveWeaponId());
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

  triggerVirtualAction(action: "dash" | "reload" | "swap" | "overdrive" | "grenade" | "blade" | "turret" | "pylon") {
    if (this.inputMode !== "touch") return;
    if (action === "dash") this.startDash();
    else if (action === "reload") this.reload();
    else if (action === "overdrive") this.triggerOverdrive();
    else if (action === "grenade") this.throwGrenade();
    else if (action === "blade") this.performBladeSlash();
    else if (action === "turret") this.deployTurret();
    else if (action === "pylon") this.deployPylon();
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
    this.clearPresentation();
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
    // Neon-noir tactical atmosphere: deep twilight sky, subtle depth fog,
    // dramatic moonlight key + electric cyan rim light, plus live dynamic lights
    // for Kai's headlamp, muzzle flashes, and explosive fireballs.
    this.scene.background = new THREE.Color(COMIC.sky);
    this.scene.fog = new THREE.FogExp2(COMIC.sky, 0.0145);

    const ambient = new THREE.HemisphereLight(0x5b8fb8, 0x101824, 0.62);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffcb94, 1.38);
    key.position.set(-14, 26, -10);
    key.castShadow = true;
    key.shadow.mapSize.setScalar(this.shadowMapSize);
    key.shadow.camera.left = -32;
    key.shadow.camera.right = 32;
    key.shadow.camera.top = 32;
    key.shadow.camera.bottom = -32;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.035;
    this.keyLight = key;
    this.scene.add(key);

    // Vivid electric cyan rim fill keeps silhouettes razor-sharp in the dark.
    const coolFill = new THREE.DirectionalLight(0x3ad8ff, 0.52);
    coolFill.position.set(16, 12, 16);
    this.scene.add(coolFill);

    // Dynamic tactical point lights (budgeted to 3 reusable lights for 60fps!)
    this.operatorLight = new THREE.PointLight(0x66e8ff, 2.8, 12.5, 1.65);
    this.operatorLight.position.set(0, 2.3, 0);
    this.scene.add(this.operatorLight);

    this.muzzleLight = new THREE.PointLight(0xffcb66, 0, 11, 1.8);
    this.muzzleLight.position.set(0, 1.5, 0);
    this.scene.add(this.muzzleLight);

    this.blastLight = new THREE.PointLight(0xff6b24, 0, 18, 1.45);
    this.blastLight.position.set(0, 2.0, 0);
    this.scene.add(this.blastLight);

    this.laserSight = this.visuals.createLaserSight();
    this.scene.add(this.laserSight.group);

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

      const weather = this.visuals.createWeatherField(arena.theme.identity);
      root.add(weather);

      // Two subtle colored atmospheric accent lights per arena so furnaces/vats/lamps
      // cast rich warm-amber or electric-cyan pools onto nearby wet concrete!
      const accentLights: THREE.PointLight[] = [];
      const accentColorA = arena.theme.identity === "floodbay" ? 0x26e6ff : 0xff7b29;
      const accentColorB = arena.theme.identity === "garage" ? 0xffb845 : 0x35e6ff;
      const lightA = new THREE.PointLight(accentColorA, 4.2, 22, 1.5);
      lightA.position.set(-11, 3.8, 5.5);
      root.add(lightA);
      accentLights.push(lightA);

      const lightB = new THREE.PointLight(accentColorB, 3.8, 22, 1.5);
      lightB.position.set(11.5, 3.8, -5.5);
      root.add(lightB);
      accentLights.push(lightB);

      this.arenaCache.set(arena.id, { root, obstacles: this.obstacles, barrels: this.barrels, weather, accentLights });
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
    this.activeWeather = built.weather ?? null;
    this.activeAccentLights = built.accentLights ?? [];
    const darkSky = new THREE.Color(arena.theme.sky).multiplyScalar(0.55);
    this.skyCool.copy(darkSky);
    this.scene.background = darkSky.clone();
    this.scene.fog = new THREE.FogExp2(darkSky.getHex(), 0.0145);

    // Copied, not aliased: destroying a crate splices the live list, and the
    // template has to survive that to rebuild the arena next time round.
    this.obstacles = built.obstacles.map((obstacle) => ({ ...obstacle }));
    for (const obstacle of this.obstacles) {
      if (!obstacle.mesh || obstacle.maxHealth === undefined) continue;
      obstacle.health = obstacle.maxHealth;
      obstacle.mesh.visible = true;
      this.visuals.damageCrate(obstacle.mesh, 1);
    }

    this.barrels = built.barrels.map((barrel) => ({ ...barrel, active: true, chainTimer: undefined }));
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
    const { hx, hz } = rotatedBoxHalfExtents(2.4, 0.6, rotation);
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
    this.overdriveAura = this.visuals.createOverdriveAura();
    this.playerMesh.add(this.overdriveAura);
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
    this.clearPresentation();
    // A new wave starts with fresh combat space, including when reusing an arena.
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) this.removeProjectile(index);
    this.clearHazards();
    for (const effect of this.effects) {
      this.scene.remove(effect.mesh);
      this.visuals.disposeObject(effect.mesh);
    }
    this.effects = [];
    for (const casing of this.shellCasings ?? []) {
      this.scene.remove(casing.mesh);
    }
    if (this.shellCasings) this.shellCasings.length = 0;
    for (const frag of this.grenades ?? []) {
      this.scene.remove(frag.mesh);
      this.scene.remove(frag.marker);
      this.visuals.disposeObject(frag.marker);
    }
    if (this.grenades) this.grenades.length = 0;
    this.grenadeCooldown = 0;
    this.bladeCooldown = 0;
    this.techEnergy = Math.max(this.techEnergy ?? 0, TECH_ENERGY_START);
    this.clearDeployablesAndPods();
    this.orbitalPodTimer = ORBITAL_POD_FIRST_DELAY;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.hitStopTimer = 0;
    for (const pickup of this.pickups) {
      this.scene.remove(pickup.mesh);
      this.visuals.disposeObject(pickup.mesh);
    }
    this.pickups = [];
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
      ? ` · ${this.waveModifier.name.toUpperCase()}`
      : "";
    this.announcement = arenaChanged
      ? `Wave ${wave}: ${arena.name.toUpperCase()} — ${arena.blurb}${modifierNote}`
      : this.waveModifier
        ? `Wave ${wave}: ${this.waveModifier.name.toUpperCase()} — ${this.waveModifier.blurb}`
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
        this.announcement = " PROTOTYPE JUGGERNAUT DETECTED!";
        this.announcementTimer = 3.5;
        this.audio.playBossPhaseShift();
      } else {
        health = 1850 * scaling.health; // Wave 10 Titan Dreadnought Prime
        this.announcement = " TITAN DREADNOUGHT PRIME HAS ARRIVED!";
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
    if (this.activeSuperWeapon && this.activeSuperWeapon.ammo > 0) {
      this.fireSuperWeapon();
      return;
    }
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.cooldown > 0) return;
    const isOverdrive = (this.overdriveRemaining ?? 0) > 0;
    if (!isOverdrive && state.magazine <= 0) {
      this.reloadWeapon(id);
      return;
    }

    const isOverchargedRound = (state.overchargedRounds ?? 0) > 0;
    const isDodgeEmpowered = this.perfectDodgeShotBuff === true;
    if (isDodgeEmpowered) this.perfectDodgeShotBuff = false;

    if (!isOverdrive) {
      state.magazine -= 1;
      if (isOverchargedRound) state.overchargedRounds = Math.max(0, (state.overchargedRounds ?? 0) - 1);
    }

    this.bulletCount += 1;
    this.stats.shotsFired += stats.pellets;

    // Adrenaline Surge synergy + Overdrive Surge fire-rate multipliers
    const adrenalineRank = this.adrenalineRank();
    const fireRateMult = (1 + 0.3 * adrenalineRank) * (isOverdrive ? OVERDRIVE_FIRE_RATE_MULT : 1);
    state.cooldown = 1 / (stats.fireRate * fireRateMult);

    // Multi-layered audio gunshot
    this.audio.playShoot(id);

    // Subtle, clean weapon model recoil kickback
    const recoilWeight = id === "shotgun" ? 0.35 : id === "rifle" ? 0.2 : id === "pistol" ? 0.12 : 0.08;
    if (this.playerRig) {
      this.visuals.applyWeaponRecoil(this.playerRig, recoilWeight);
    }

    // Gentle camera recoil
    if (!this.profile.settings.reducedMotion) this.cameraRecoil.addScaledVector(this.aim, -0.025 * recoilWeight);

    const origin = this.playerRig
      ? this.playerRig.muzzle.getWorldPosition(new THREE.Vector3())
      : this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.8, 1.25, this.aim.z * 0.8));

    const baseKnockback = id === "shotgun" ? 14 : id === "rifle" ? 9 : id === "pistol" ? 5.5 : 3.2;

    // High Caliber, Overcharge, and Perfect Dodge modifiers
    const highCaliberRank = this.activeSynergies.get("high_caliber") ?? 0;
    const damageMult =
      (1 + 0.25 * highCaliberRank) *
      (isOverchargedRound ? OVERCHARGE_DAMAGE_MULT : 1) *
      (isDodgeEmpowered ? PERFECT_DODGE_SHOT_BONUS : 1);
    const bulletScale = 1 + 0.25 * highCaliberRank + (isOverdrive || isOverchargedRound ? 0.18 : 0);
    const knockbackMult = (1 + 0.5 * highCaliberRank) * (isOverdrive ? 1.25 : 1);

    const piercingRank = this.activeSynergies.get("piercing") ?? 0;
    const ricochetRank = this.activeSynergies.get("ricochet") ?? 0;

    // Dynamic Element / Overdrive / Overcharge Bullet Tint
    let bulletColor = stats.color;
    if (isOverdrive) {
      bulletColor = 0xffd740; // Blazing Overdrive gold
    } else if (isOverchargedRound || isDodgeEmpowered) {
      bulletColor = 0xfff3a1; // Superheated active-reload / phantom-slip tracer
    } else if (this.activeSynergies.has("cryo_frost")) {
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
        forceCrit: isOverdrive || isDodgeEmpowered,
        overcharged: isOverchargedRound,
      });
    }

    const flash = this.visuals.createMuzzleFlashMesh(isOverdrive ? COMIC.gold : 0xffdaa0);
    flash.userData.baseScale = id === "shotgun" ? 1.4 : id === "rifle" ? 1.1 : id === "smg" ? 0.55 : 0.8;
    flash.userData.muzzle = true;
    flash.position.copy(origin).addScaledVector(this.aim, 0.14);
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.aim);
    this.scene.add(flash);
    const flashLife = id === "shotgun" ? 0.065 : id === "smg" ? 0.025 : 0.045;
    this.effects.push({ mesh: flash, life: flashLife, maxLife: flashLife });

    // Dynamic muzzle flash light & ejected brass shell casing
    if (this.muzzleLight) {
      this.muzzleLight.position.copy(origin).setY(1.4);
      this.muzzleLight.color.setHex(isOverdrive ? COMIC.gold : 0xffcb66);
      this.muzzleLight.intensity = id === "shotgun" ? 9.5 : id === "rifle" ? 7.5 : 5.5;
      this.muzzleLightTimer = id === "shotgun" ? 0.085 : 0.055;
    }
    this.spawnShellCasing(origin);

    // Smooth subtle camera feedback
    this.cameraShake = Math.max(this.cameraShake, id === "shotgun" ? 0.06 : id === "rifle" ? 0.03 : 0.012);
    if (!isOverdrive && state.magazine === 0 && state.reserve > 0) this.reloadWeapon(id);
  }

  private spawnShellCasing(origin: THREE.Vector3) {
    if (this.profile.settings.reducedMotion || !this.visuals.createShellCasing) return;
    const casing = this.visuals.createShellCasing();
    casing.position.copy(origin);
    this.scene.add(casing);
    // Eject to Kai's right + slightly up with random spread
    const rightX = -this.aim.z;
    const rightZ = this.aim.x;
    const velocity = new THREE.Vector3(
      rightX * (2.6 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9,
      2.4 + Math.random() * 1.2,
      rightZ * (2.6 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9,
    );
    const spin = new THREE.Vector3(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
    );
    this.shellCasings.push({ mesh: casing, velocity, spin, life: 0.95 });
    while (this.shellCasings.length > 28) {
      const oldest = this.shellCasings.shift();
      if (oldest) this.scene.remove(oldest.mesh);
    }
  }

  throwGrenade() {
    if (this.paused || (this.grenadeCooldown ?? 0) > 0) return;
    this.grenadeCooldown = this.grenadeCooldownTotal ?? 8.0;

    const origin = this.playerMesh.position.clone().setY(1.25);
    const target = this.mouseWorldPos.clone().setY(0);
    if (this.usingTouchControls && this.touchAimTarget) {
      target.copy(this.touchAimTarget.mesh.position).setY(0);
    } else if (target.distanceTo(this.playerMesh.position) < 0.4) {
      target.copy(this.playerMesh.position).addScaledVector(this.aim, 7.5);
    }
    const delta = target.sub(this.playerMesh.position).setY(0);
    const dist = Math.min(12.5, Math.max(2.2, delta.length()));
    const dir = delta.lengthSq() > 0.001 ? delta.normalize() : this.aim.clone();
    const landX = THREE.MathUtils.clamp(this.playerMesh.position.x + dir.x * dist, -ARENA_LIMIT + 0.8, ARENA_LIMIT - 0.8);
    const landZ = THREE.MathUtils.clamp(this.playerMesh.position.z + dir.z * dist, -ARENA_LIMIT + 0.8, ARENA_LIMIT - 0.8);

    const fuse = 0.72;
    const mesh = this.visuals.createFragGrenade?.() ?? new THREE.Group();
    mesh.position.copy(origin);
    this.scene.add(mesh);

    const marker = this.visuals.createTelegraphCircle?.(4.8) ?? new THREE.Group();
    marker.position.set(landX, 0.05, landZ);
    this.scene.add(marker);

    const velocity = new THREE.Vector3(
      (landX - origin.x) / (fuse * 0.82),
      5.2,
      (landZ - origin.z) / (fuse * 0.82),
    );
    this.grenades.push({ mesh, marker, velocity, fuse, maxFuse: fuse, bounced: false });
    this.audio.playGrenadeThrow?.();
    this.emitHud(true);
  }

  private updateGrenades(dt: number) {
    if ((this.grenadeCooldown ?? 0) > 0) {
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
    }
    for (let i = (this.grenades?.length ?? 0) - 1; i >= 0; i -= 1) {
      const frag = this.grenades[i];
      frag.fuse -= dt;
      frag.velocity.y -= 18 * dt;
      frag.mesh.position.addScaledVector(frag.velocity, dt);
      frag.mesh.rotation.x += dt * 11;
      frag.mesh.rotation.z += dt * 8;
      if (frag.mesh.position.y <= 0.2) {
        frag.mesh.position.y = 0.2;
        frag.velocity.y = Math.abs(frag.velocity.y) * 0.35;
        frag.velocity.x *= 0.45;
        frag.velocity.z *= 0.45;
        if (!frag.bounced) {
          frag.bounced = true;
          this.audio.playSurfaceImpact?.("metal");
        }
      }
      frag.marker.position.set(frag.mesh.position.x, 0.05, frag.mesh.position.z);
      const progress = 1 - Math.max(0, frag.fuse) / frag.maxFuse;
      frag.marker.getObjectByName("telegraph-fill")?.scale.setScalar(Math.max(0.08, progress));

      if (frag.fuse <= 0) {
        this.detonateGrenade(frag);
        this.scene.remove(frag.mesh);
        this.scene.remove(frag.marker);
        this.visuals.disposeObject(frag.marker);
        this.grenades.splice(i, 1);
      }
    }
  }

  private detonateGrenade(frag: FragGrenadeEntity) {
    const position = frag.mesh.position.clone().setY(0);
    const radius = 5.2;
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const dist = enemy.mesh.position.distanceTo(position);
      if (dist <= radius + enemy.definition.radius) {
        const push = enemy.mesh.position.clone().sub(position).setY(0).normalize();
        this.damageEnemy(enemy, 165 * (1 - dist / (radius * 1.45)), 18, push, "splash");
        enemy.windupTimer = 0;
        this.clearTelegraph(enemy);
      }
    }
    for (const barrel of this.barrels) {
      if (!barrel.active || barrel.chainTimer !== undefined) continue;
      if (barrel.mesh.position.distanceTo(position) <= radius + 0.8) {
        barrel.chainTimer = 0.06;
      }
    }
    const fireball = this.visuals.createFireballExplosion?.(radius * 0.72, COMIC.fire);
    if (fireball) {
      fireball.position.copy(position);
      this.scene.add(fireball);
      this.effects.push({ mesh: fireball, life: 0.48, maxLife: 0.48 });
    }
    this.visuals.addScorchDecal?.(this.scene, position, 1.15);
    this.flashBlastLight(position, COMIC.fire, 14);
    this.postChromatic = Math.max(this.postChromatic ?? 0, 0.85);
    this.cameraShake = Math.max(this.cameraShake, 0.75);
    this.audio.playExplosion();
    this.spawnFloatingText(position.clone().setY(1.8), "FRAG OUT!", "combo");
  }

  private flashBlastLight(position: THREE.Vector3, color: number, intensity = 12) {
    if (!this.blastLight) return;
    this.blastLight.position.set(position.x, 2.2, position.z);
    this.blastLight.color.setHex(color);
    this.blastLight.intensity = intensity;
    this.blastLightTimer = 0.24;
  }

  // ── SUPER-WEAPONS (Orbital Drop Pod Overrides) ────────────────────────────
  private fireSuperWeapon() {
    const active = this.activeSuperWeapon;
    if (!active || (this.superWeaponCooldown ?? 0) > 0) return;
    const def = SUPER_WEAPONS[active.id];
    const isOverdrive = (this.overdriveRemaining ?? 0) > 0;
    const fireRateMult = isOverdrive ? OVERDRIVE_FIRE_RATE_MULT : 1;
    this.superWeaponCooldown = 1 / (def.fireRate * fireRateMult);
    if (!isOverdrive) active.ammo -= 1;

    const origin = this.playerRig
      ? this.playerRig.muzzle.getWorldPosition(new THREE.Vector3())
      : this.playerMesh.position.clone().add(new THREE.Vector3(this.aim.x * 0.85, 1.2, this.aim.z * 0.85));

    if (active.id === "railcannon") {
      // Hyper-velocity screen-splitting piercing beam!
      const end = origin.clone().addScaledVector(this.aim, 28);
      for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
        const enemy = this.enemies[i];
        if (!enemy || enemy.health <= 0) continue;
        const t = segmentCircleHit(origin, end, enemy.mesh.position, enemy.definition.radius + 0.65);
        if (t !== null) {
          this.damageEnemy(enemy, def.damage, 16, this.aim, "bullet", { forceCrit: true });
        }
      }
      for (const barrel of this.barrels) {
        if (!barrel.active) continue;
        if (segmentCircleHit(origin, end, barrel.mesh.position, 0.9) !== null) {
          this.explodeBarrel(barrel);
        }
      }
      const beam = this.visuals.createRailgunBeam?.(origin, end, def.color);
      if (beam) {
        this.scene.add(beam);
        this.effects.push({ mesh: beam, life: 0.28, maxLife: 0.28 });
      }
      this.flashBlastLight(origin, def.color, 13);
      this.postChromatic = Math.max(this.postChromatic ?? 0, 0.85);
      this.cameraShake = Math.max(this.cameraShake, 0.65);
      this.audio.playRailcannon?.();
      this.stats.shotsFired += 1;
    } else if (active.id === "minigun") {
      // Blistering explosive rotary firestorm!
      const angle = Math.atan2(this.aim.z, this.aim.x) + THREE.MathUtils.randFloatSpread(0.16);
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const bullet = new THREE.Mesh(this.tracerGeometry("rifle", 1.15), this.tracerMaterial(def.color));
      bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      bullet.position.copy(origin);
      this.scene.add(bullet);
      this.projectiles.push({
        mesh: bullet,
        velocity: dir.clone().multiplyScalar(44),
        direction: dir,
        damage: def.damage,
        knockback: 6,
        life: 1.25,
        enemy: false,
        maxPierces: 1,
        pierceCount: 0,
        hitEnemies: new Set(),
        ignites: true,
        forceCrit: isOverdrive,
      });
      this.audio.playShoot("smg");
      this.spawnShellCasing(origin);
      if (this.muzzleLight) {
        this.muzzleLight.position.copy(origin).setY(1.4);
        this.muzzleLight.color.setHex(def.color);
        this.muzzleLight.intensity = 7.5;
        this.muzzleLightTimer = 0.05;
      }
      this.cameraShake = Math.max(this.cameraShake, 0.04);
      this.stats.shotsFired += 1;
    } else if (active.id === "sawblade") {
      // Giant spinning golden buzzsaws that pierce AND ricochet 5 times!
      const dir = this.aim.clone().normalize();
      const saw = this.visuals.createSawbladeProjectile?.() ?? new THREE.Mesh(this.tracerGeometry("shotgun", 1.5), this.tracerMaterial(def.color));
      saw.position.copy(origin).setY(1.0);
      this.scene.add(saw);
      this.projectiles.push({
        mesh: saw,
        velocity: dir.clone().multiplyScalar(25),
        direction: dir,
        damage: def.damage,
        knockback: 12,
        life: 3.2,
        enemy: false,
        maxPierces: 8,
        pierceCount: 0,
        bouncesRemaining: 5,
        hitEnemies: new Set(),
        isSawblade: true,
        forceCrit: isOverdrive,
      });
      this.audio.playSawblade?.();
      this.cameraShake = Math.max(this.cameraShake, 0.14);
      this.stats.shotsFired += 1;
    }

    if (active.ammo <= 0) {
      this.activeSuperWeapon = null;
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.7), "SUPER-WEAPON DEPLETED", "ammo");
      this.emitHud(true);
    }
  }

  // ── CYBER-BLADE SLASH, DEFLECT & TELEPORT-EXECUTION CHAINS ────────────────
  performBladeSlash() {
    if (this.paused || this.playerHealth <= 0 || (this.bladeCooldown ?? 0) > 0) return;

    const playerPos = this.playerMesh.position;

    // 1. Deflect nearby enemy projectiles right back at them for 4x damage!
    let deflected = 0;
    for (const proj of this.projectiles) {
      if (!proj.enemy) continue;
      if (proj.mesh.position.distanceTo(playerPos) <= BLADE_DEFLECT_RADIUS) {
        proj.enemy = false;
        proj.direction.copy(this.aim).normalize();
        proj.velocity.copy(proj.direction).multiplyScalar(32);
        proj.damage = Math.max(85, proj.damage * 4);
        proj.life = 1.6;
        proj.forceCrit = true;
        deflected += 1;
      }
    }
    if (deflected > 0) {
      this.addOverdriveCharge(14 * deflected);
      this.spawnFloatingText(playerPos.clone().setY(1.9), "DEFLECT!", "combo");
    }

    // 2. Find nearest executable target within Blink-Execute range!
    let execTarget: EnemyEntity | null = null;
    let bestDistSq = BLADE_EXECUTE_RANGE * BLADE_EXECUTE_RANGE;
    for (const enemy of this.enemies) {
      if (!isEnemyExecutable(enemy.health, enemy.maxHealth, enemy.type === "juggernaut")) continue;
      const distSq = enemy.mesh.position.distanceToSquared(playerPos);
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        execTarget = enemy;
      }
    }

    if (execTarget) {
      // TELEPORT-BLINK EXECUTION CHAIN!
      if (!this.profile.settings.reducedMotion) {
        const ghost = this.visuals.createDashGhost?.(this.playerMesh);
        if (ghost) {
          this.scene.add(ghost);
          this.effects.push({ mesh: ghost, life: 0.28, maxLife: 0.28, fade: true });
        }
      }
      const targetPos = execTarget.mesh.position.clone();
      const approach = targetPos.clone().sub(playerPos).setY(0);
      const dir = approach.lengthSq() > 0.001 ? approach.normalize() : this.aim.clone();
      this.aim.copy(dir);
      const blinkPos = targetPos.clone().addScaledVector(dir, 1.15);
      for (const obs of this.obstacles) resolveCircleObstacle(blinkPos, 0.48, obs);
      blinkPos.x = THREE.MathUtils.clamp(blinkPos.x, -ARENA_LIMIT + 0.5, ARENA_LIMIT - 0.5);
      blinkPos.z = THREE.MathUtils.clamp(blinkPos.z, -ARENA_LIMIT + 0.5, ARENA_LIMIT - 0.5);
      this.playerMesh.position.set(blinkPos.x, 0, blinkPos.z);
      this.playerMesh.rotation.y = Math.atan2(dir.x, dir.z);

      const arc = this.visuals.createBladeSlashArc?.(true);
      if (arc) {
        arc.position.copy(targetPos);
        arc.rotation.y = Math.atan2(dir.x, dir.z);
        this.scene.add(arc);
        this.effects.push({ mesh: arc, life: 0.26, maxLife: 0.26 });
      }

      // Instant execution + AoE cleave around the executed target!
      this.damageEnemy(execTarget, execTarget.health + 500, 18, dir, "splash", { forceCrit: true });
      for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
        const other = this.enemies[i];
        if (!other || other === execTarget) continue;
        if (other.mesh.position.distanceTo(targetPos) <= 3.3) {
          const push = other.mesh.position.clone().sub(targetPos).setY(0).normalize();
          this.damageEnemy(other, BLADE_SLASH_DAMAGE, 14, push, "splash");
          other.windupTimer = 0;
          this.clearTelegraph(other);
        }
      }

      // Execution payoffs: Heal, instant mag refill, Tech Energy, Overdrive, AND instant cooldown reset!
      const healed = Math.min(BLADE_EXECUTE_HEAL, this.maxHealth - this.playerHealth);
      if (healed > 0) this.playerHealth += healed;
      const activeId = this.getActiveWeaponId();
      const activeState = this.weaponStates.get(activeId);
      if (activeState) {
        const stats = getWeaponStats(activeId, this.profile.weaponRanks[activeId]);
        activeState.magazine = stats.magazine;
        activeState.reloading = 0;
      }
      this.techEnergy = Math.min(TECH_ENERGY_MAX, (this.techEnergy ?? 0) + TECH_ENERGY_EXECUTE_GAIN);
      this.addOverdriveCharge(18);
      this.bladeCooldown = 0.08; // Ready to chain-execute immediately!
      this.bulletTimeTimer = Math.max(this.bulletTimeTimer ?? 0, 0.16);
      this.bulletTimeScale = 0.35;
      this.flashBlastLight(targetPos, COMIC.gold, 11);
      this.postChromatic = Math.max(this.postChromatic ?? 0, 0.72);
      this.cameraShake = Math.max(this.cameraShake, 0.45);
      this.audio.playBladeSlash?.(true);
      this.spawnFloatingText(targetPos.clone().setY(2.1), "EXECUTE!", "combo");
      this.emitHud(true);
      return;
    }

    // 3. Standard 180° Plasma Blade Cleave
    this.bladeCooldown = BLADE_COOLDOWN;
    const arc = this.visuals.createBladeSlashArc?.(false);
    if (arc) {
      arc.position.copy(playerPos);
      arc.rotation.y = Math.atan2(this.aim.x, this.aim.z);
      this.scene.add(arc);
      this.effects.push({ mesh: arc, life: 0.2, maxLife: 0.2 });
    }
    for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
      const enemy = this.enemies[i];
      if (!enemy) continue;
      const toEnemy = enemy.mesh.position.clone().sub(playerPos).setY(0);
      const dist = toEnemy.length();
      if (dist > BLADE_SLASH_RANGE + enemy.definition.radius) continue;
      const dirToEnemy = dist > 0.01 ? toEnemy.divideScalar(dist) : this.aim.clone();
      if (dirToEnemy.dot(this.aim) < -0.25 && dist > 1.35) continue;
      this.damageEnemy(enemy, BLADE_SLASH_DAMAGE, 16, dirToEnemy, "splash");
      enemy.windupTimer = 0;
      this.clearTelegraph(enemy);
    }
    this.audio.playBladeSlash?.(false);
    this.cameraShake = Math.max(this.cameraShake, 0.16);
    this.emitHud(true);
  }

  // ── DEPLOYABLE AUTO-TURRETS & TESLA LASER-FENCE PYLONS ────────────────────
  deployTurret() {
    this.deployStructure("turret");
  }

  deployPylon() {
    this.deployStructure("pylon");
  }

  private deployStructure(kind: "turret" | "pylon") {
    if (this.paused || this.playerHealth <= 0) return;
    const cost = kind === "turret" ? TURRET_COST : PYLON_COST;
    if ((this.techEnergy ?? 0) < cost) {
      this.audio.tone(180, 0.06, 0.05, "square");
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.6), `NEED ${cost} TECH`, "ammo");
      return;
    }

    const pos = this.playerMesh.position.clone().addScaledVector(this.aim, 2.2);
    pos.x = THREE.MathUtils.clamp(pos.x, -ARENA_LIMIT + 1.2, ARENA_LIMIT - 1.2);
    pos.z = THREE.MathUtils.clamp(pos.z, -ARENA_LIMIT + 1.2, ARENA_LIMIT - 1.2);
    for (const obs of this.obstacles) resolveCircleObstacle(pos, 0.85, obs);

    this.techEnergy = Math.max(0, (this.techEnergy ?? 0) - cost);

    // Enforce active cap by replacing the oldest of the same type
    const cap = kind === "turret" ? TURRET_MAX_ACTIVE : PYLON_MAX_ACTIVE;
    const existingOfKind = this.deployables.filter((d) => d.kind === kind);
    if (existingOfKind.length >= cap) {
      const oldest = existingOfKind[0];
      this.removeDeployable(oldest);
    }

    const mesh = kind === "turret" ? (this.visuals.createAutoTurret?.() ?? new THREE.Group()) : (this.visuals.createTeslaPylon?.() ?? new THREE.Group());
    mesh.position.set(pos.x, 0, pos.z);
    this.scene.add(mesh);

    const maxHealth = kind === "turret" ? TURRET_HEALTH : PYLON_HEALTH;
    this.deployables.push({
      kind,
      mesh,
      x: pos.x,
      z: pos.z,
      health: maxHealth,
      maxHealth,
      life: 40,
      cooldown: 0.25,
    });

    const shock = this.visuals.createShockwaveMesh?.(2.6, COMIC.electric);
    if (shock) {
      shock.position.set(pos.x, 0.06, pos.z);
      this.scene.add(shock);
      this.effects.push({ mesh: shock, life: 0.35, maxLife: 0.35 });
    }
    this.flashBlastLight(pos, COMIC.electric, 9);
    this.cameraShake = Math.max(this.cameraShake, 0.22);
    this.audio.playDeployStructure?.();
    this.spawnFloatingText(pos.clone().setY(1.8), kind === "turret" ? "TURRET ONLINE!" : "TESLA PYLON!", "combo");

    if (kind === "pylon") this.rebuildLaserFences();
    this.emitHud(true);
  }

  private removeDeployable(target: DeployableEntity) {
    const idx = this.deployables.indexOf(target);
    if (idx < 0) return;
    this.scene.remove(target.mesh);
    this.visuals.disposeObject(target.mesh);
    this.deployables.splice(idx, 1);
    if (target.kind === "pylon") this.rebuildLaserFences();
  }

  private rebuildLaserFences() {
    for (const fence of this.laserFences) {
      this.scene.remove(fence.mesh);
      this.visuals.disposeObject(fence.mesh);
    }
    this.laserFences = [];
    const pylons = this.deployables.filter((d) => d.kind === "pylon");
    const maxDistSq = PYLON_FENCE_MAX_DIST * PYLON_FENCE_MAX_DIST;
    for (let i = 0; i < pylons.length; i += 1) {
      for (let j = i + 1; j < pylons.length; j += 1) {
        const a = pylons[i];
        const b = pylons[j];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        if (dx * dx + dz * dz <= maxDistSq) {
          const mesh = this.visuals.createLaserFenceBeam?.(new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(b.x, 0, b.z));
          if (mesh) {
            this.scene.add(mesh);
            this.laserFences.push({ a, b, mesh, tickTimer: 0 });
          }
        }
      }
    }
  }

  private updateDeployables(dt: number) {
    if (this.waveActive && this.playerHealth > 0) {
      this.techEnergy = Math.min(TECH_ENERGY_MAX, (this.techEnergy ?? 0) + TECH_ENERGY_REGEN_PER_SEC * dt);
    }
    if ((this.bladeCooldown ?? 0) > 0) this.bladeCooldown = Math.max(0, this.bladeCooldown - dt);
    if ((this.superWeaponCooldown ?? 0) > 0) this.superWeaponCooldown = Math.max(0, this.superWeaponCooldown - dt);

    for (let i = (this.deployables?.length ?? 0) - 1; i >= 0; i -= 1) {
      const dep = this.deployables[i];
      dep.life -= dt;
      dep.cooldown -= dt;

      if (dep.kind === "turret") {
        // Aim at nearest enemy and fire rapid cyan tracer rounds
        let target: EnemyEntity | null = null;
        let bestSq = TURRET_RANGE * TURRET_RANGE;
        for (const enemy of this.enemies) {
          if (enemy.health <= 0) continue;
          const dx = enemy.mesh.position.x - dep.x;
          const dz = enemy.mesh.position.z - dep.z;
          const dSq = dx * dx + dz * dz;
          if (dSq < bestSq) {
            bestSq = dSq;
            target = enemy;
          }
        }
        if (target) {
          const dx = target.mesh.position.x - dep.x;
          const dz = target.mesh.position.z - dep.z;
          const head = dep.mesh.getObjectByName("turret-head");
          if (head) head.rotation.y = Math.atan2(dx, dz);
          if (dep.cooldown <= 0) {
            dep.cooldown = TURRET_FIRE_INTERVAL;
            const dir = new THREE.Vector3(dx, 0, dz).normalize();
            const origin = new THREE.Vector3(dep.x + dir.x * 0.65, 0.85, dep.z + dir.z * 0.65);
            const bullet = new THREE.Mesh(this.tracerGeometry("smg", 1.05), this.tracerMaterial(COMIC.electric));
            bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            bullet.position.copy(origin);
            this.scene.add(bullet);
            this.projectiles.push({
              mesh: bullet,
              velocity: dir.clone().multiplyScalar(38),
              direction: dir,
              damage: TURRET_DAMAGE,
              knockback: 3.2,
              life: 1.0,
              enemy: false,
              hitEnemies: new Set(),
            });
            this.audio.tone(720, 0.03, 0.035, "triangle");
          }
        }
      } else {
        // Tesla Pylon spins orb & discharges pulsing electric shockwaves
        const orb = dep.mesh.getObjectByName("pylon-orb");
        if (orb) orb.rotation.y += dt * 3.2;
        if (dep.cooldown <= 0) {
          const nearby = this.enemies
            .filter((e) => e.health > 0 && Math.hypot(e.mesh.position.x - dep.x, e.mesh.position.z - dep.z) <= PYLON_PULSE_RADIUS)
            .slice(0, 4);
          if (nearby.length > 0) {
            dep.cooldown = PYLON_PULSE_INTERVAL;
            const points = [new THREE.Vector3(dep.x, 2.2, dep.z)];
            for (const target of nearby) {
              points.push(target.mesh.position.clone().setY(1.0));
              target.health -= PYLON_PULSE_DAMAGE;
              target.hitFlash = 0.12;
              target.chilledTimer = Math.max(target.chilledTimer ?? 0, 2.2);
              target.chillMult = Math.min(target.chillMult ?? 1, 0.65);
              this.stats.damageDealt += PYLON_PULSE_DAMAGE;
              this.damageFeedback.add(target, PYLON_PULSE_DAMAGE);
            }
            const lightning = this.visuals.createChainLightningMesh?.(points, COMIC.electric);
            if (lightning) {
              this.scene.add(lightning);
              this.effects.push({ mesh: lightning, life: 0.18, maxLife: 0.18 });
            }
            this.audio.playChainLightning?.();
          }
        }
      }

      if (dep.life <= 0 || dep.health <= 0) {
        this.removeDeployable(dep);
      }
    }

    // Electric Laser Fences slice any enemy crossing between two linked Tesla Pylons!
    for (const fence of this.laserFences ?? []) {
      fence.tickTimer -= dt;
      if (fence.tickTimer > 0) continue;
      fence.tickTimer = 0.18;
      for (const enemy of this.enemies) {
        if (enemy.health <= 0) continue;
        const hitRadius = enemy.definition.radius + 0.32;
        const distSq = pointToSegmentDistanceSq(
          enemy.mesh.position.x,
          enemy.mesh.position.z,
          fence.a.x,
          fence.a.z,
          fence.b.x,
          fence.b.z,
        );
        if (distSq <= hitRadius * hitRadius) {
          const dmg = Math.round(PYLON_FENCE_DPS * 0.18);
          enemy.health -= dmg;
          enemy.hitFlash = 0.12;
          enemy.chilledTimer = Math.max(enemy.chilledTimer ?? 0, 1.4);
          enemy.chillMult = Math.min(enemy.chillMult ?? 1, 0.55);
          this.stats.damageDealt += dmg;
          this.damageFeedback.add(enemy, dmg);
        }
      }
    }
  }

  private clearDeployablesAndPods() {
    for (const dep of this.deployables ?? []) {
      this.scene.remove(dep.mesh);
      this.visuals.disposeObject(dep.mesh);
    }
    if (this.deployables) this.deployables.length = 0;
    for (const fence of this.laserFences ?? []) {
      this.scene.remove(fence.mesh);
      this.visuals.disposeObject(fence.mesh);
    }
    if (this.laserFences) this.laserFences.length = 0;
    for (const pod of this.orbitalPods ?? []) {
      this.scene.remove(pod.podMesh);
      this.visuals.disposeObject(pod.podMesh);
      if (pod.beamMesh) {
        this.scene.remove(pod.beamMesh);
        this.visuals.disposeObject(pod.beamMesh);
      }
    }
    if (this.orbitalPods) this.orbitalPods.length = 0;
  }

  // ── ORBITAL SUPPLY DROP PODS (Super-Weapon Events) ────────────────────────
  private spawnOrbitalPod() {
    if ((this.orbitalPods?.length ?? 0) >= 2) return;
    const weapon = pickRandomSuperWeapon();
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const cx = THREE.MathUtils.randFloatSpread(24);
      const cz = THREE.MathUtils.randFloatSpread(24);
      if (Math.hypot(cx, cz) < 4.0) continue;
      if (this.pointInsideObstacle(cx, cz, 1.6)) continue;
      x = cx;
      z = cz;
      break;
    }

    const beamMesh = this.visuals.createOrbitalSkyBeam?.(weapon.color);
    if (beamMesh) {
      beamMesh.position.set(x, 0, z);
      this.scene.add(beamMesh);
    }
    const podMesh = this.visuals.createOrbitalDropPod?.(weapon.color) ?? new THREE.Group();
    podMesh.position.set(x, 26, z);
    this.scene.add(podMesh);

    this.orbitalPods.push({
      weaponId: weapon.id,
      x,
      z,
      state: "falling",
      timer: ORBITAL_POD_FALL_TIME,
      podMesh,
      beamMesh,
    });
    this.announcement = `ORBITAL DROP INBOUND: ${weapon.name}!`;
    this.announcementTimer = 2.6;
    this.audio.tone(440, 0.25, 0.08, "triangle");
  }

  private updateOrbitalPods(dt: number) {
    if (this.waveActive && !this.waveCleared && (this.enemies.length > 0 || this.spawnQueue.length > 0)) {
      this.orbitalPodTimer -= dt;
      if (this.orbitalPodTimer <= 0) {
        this.orbitalPodTimer = ORBITAL_POD_INTERVAL;
        this.spawnOrbitalPod();
      }
    }

    for (let i = (this.orbitalPods?.length ?? 0) - 1; i >= 0; i -= 1) {
      const pod = this.orbitalPods[i];
      if (pod.state === "falling") {
        pod.timer -= dt;
        const progress = 1 - Math.max(0, pod.timer) / ORBITAL_POD_FALL_TIME;
        pod.podMesh.position.y = Math.max(0, (1 - progress * progress) * 26);
        if (pod.timer <= 0) {
          pod.state = "landed";
          pod.timer = 22; // stays pickable for 22s
          pod.podMesh.position.y = 0;
          if (pod.beamMesh) {
            this.scene.remove(pod.beamMesh);
            this.visuals.disposeObject(pod.beamMesh);
            pod.beamMesh = undefined;
          }
          // Meteor impact crushes zombies underneath!
          const impactPos = new THREE.Vector3(pod.x, 0, pod.z);
          for (let e = this.enemies.length - 1; e >= 0; e -= 1) {
            const enemy = this.enemies[e];
            if (!enemy) continue;
            if (enemy.mesh.position.distanceTo(impactPos) <= ORBITAL_POD_IMPACT_RADIUS + enemy.definition.radius) {
              const push = enemy.mesh.position.clone().sub(impactPos).setY(0).normalize();
              this.damageEnemy(enemy, 240, 20, push, "splash");
            }
          }
          const blast = this.visuals.createFireballExplosion?.(3.0, SUPER_WEAPONS[pod.weaponId].color);
          if (blast) {
            blast.position.copy(impactPos);
            this.scene.add(blast);
            this.effects.push({ mesh: blast, life: 0.45, maxLife: 0.45 });
          }
          this.visuals.addScorchDecal?.(this.scene, impactPos, 1.0);
          this.flashBlastLight(impactPos, SUPER_WEAPONS[pod.weaponId].color, 13);
          this.cameraShake = Math.max(this.cameraShake, 0.6);
          this.audio.playPodImpact?.();
        }
      } else {
        pod.timer -= dt;
        const beacon = pod.podMesh.getObjectByName("pod-beacon");
        if (beacon) {
          beacon.rotation.y += dt * 3.0;
          beacon.position.y = 1.95 + Math.sin(this.missionElapsed * 4.5) * 0.16;
        }
        // Check operator pickup!
        const dist = Math.hypot(this.playerMesh.position.x - pod.x, this.playerMesh.position.z - pod.z);
        if (dist <= 1.95 && this.playerHealth > 0) {
          const def = SUPER_WEAPONS[pod.weaponId];
          this.activeSuperWeapon = { id: def.id, ammo: def.ammo, maxAmmo: def.ammo };
          this.superWeaponCooldown = 0;
          this.audio.playFusionUnlock?.();
          this.announcement = `${def.name} EQUIPPED — ${def.tagline.toUpperCase()}!`;
          this.announcementTimer = 3.2;
          this.spawnFloatingText(this.playerMesh.position.clone().setY(2.0), def.name, "combo");
          this.scene.remove(pod.podMesh);
          this.visuals.disposeObject(pod.podMesh);
          this.orbitalPods.splice(i, 1);
          this.emitHud(true);
          continue;
        }
        if (pod.timer <= 0) {
          this.scene.remove(pod.podMesh);
          this.visuals.disposeObject(pod.podMesh);
          this.orbitalPods.splice(i, 1);
        }
      }
    }
  }

  /** Adrenaline Surge rank, or 0 while above the health threshold. */
  private adrenalineRank() {
    if (this.playerHealth / this.maxHealth > 0.45) return 0;
    return this.activeSynergies.get("adrenaline_surge") ?? 0;
  }

  private reload() {
    const id = this.getActiveWeaponId();
    const state = this.weaponStates.get(id);
    if (state && state.reloading > 0) {
      if (state.activeReloadAttempted) return;
      state.activeReloadAttempted = true;
      const progress = normalizedReloadProgress(state);
      if (evaluateActiveReload(progress) === "perfect") {
        const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
        const needed = stats.magazine - state.magazine;
        const transfer = Math.min(needed, state.reserve);
        state.magazine += transfer;
        state.reserve -= transfer;
        state.reloading = 0;
        state.overchargedRounds = state.magazine;
        this.addOverdriveCharge(15);
        this.audio.playActiveReloadSuccess?.();
        this.cameraShake = Math.max(this.cameraShake, 0.08);
        this.spawnFloatingText(this.playerMesh.position.clone().setY(1.65), "OVERCHARGED!", "combo");
        this.emitHud(true);
      } else {
        state.reloading += ACTIVE_RELOAD_JAM_PENALTY;
        state.reloadDuration = (state.reloadDuration ?? state.reloading) + ACTIVE_RELOAD_JAM_PENALTY;
        this.audio.playActiveReloadJam?.();
        this.spawnFloatingText(this.playerMesh.position.clone().setY(1.55), "JAM!", "player-damage");
        this.emitHud(true);
      }
      return;
    }
    this.reloadWeapon(id);
  }

  private reloadWeapon(id: WeaponId) {
    const state = this.weaponStates.get(id);
    if (!state) return;
    const stats = getWeaponStats(id, this.profile.weaponRanks[id]);
    if (state.reloading > 0 || state.magazine >= stats.magazine || state.reserve <= 0) return;
    const reloadMult = Math.max(0.4, 1 - 0.2 * this.adrenalineRank());
    state.reloading = stats.reload * reloadMult;
    state.reloadDuration = state.reloading;
    state.activeReloadAttempted = false;
    this.audio.playReload();
  }

  private addOverdriveCharge(amount: number) {
    if ((this.overdriveRemaining ?? 0) > 0 || amount <= 0) return;
    const before = this.overdriveCharge ?? 0;
    const next = Math.min(OVERDRIVE_MAX_CHARGE, before + amount);
    this.overdriveCharge = next;
    if (before < OVERDRIVE_MAX_CHARGE && next >= OVERDRIVE_MAX_CHARGE) {
      this.audio.playPerkSelect?.();
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.85), "OVERDRIVE READY!", "combo");
    }
  }

  triggerOverdrive() {
    if (this.paused || (this.overdriveRemaining ?? 0) > 0) return;
    if ((this.overdriveCharge ?? 0) < OVERDRIVE_MAX_CHARGE) return;

    this.overdriveCharge = 0;
    this.overdriveRemaining = OVERDRIVE_BASE_DURATION;
    this.overdriveDuration = OVERDRIVE_BASE_DURATION;
    this.overdriveExtensionUsed = 0;
    this.bulletTimeTimer = 0.28;
    this.bulletTimeScale = 0.28;

    // Instant magazine top-off on Overdrive entry
    const activeId = this.getActiveWeaponId();
    const activeState = this.weaponStates.get(activeId);
    if (activeState) {
      const stats = getWeaponStats(activeId, this.profile.weaponRanks[activeId]);
      activeState.magazine = stats.magazine;
      activeState.reloading = 0;
      activeState.activeReloadAttempted = false;
    }

    const origin = this.playerMesh.position.clone();
    const shock = this.visuals.createShockwaveMesh?.(OVERDRIVE_SHOCKWAVE_RADIUS, COMIC.gold);
    if (shock) {
      shock.position.copy(origin).setY(0.1);
      this.scene.add(shock);
      this.effects.push({ mesh: shock, life: 0.45, maxLife: 0.45 });
    }
    if (!this.profile.settings.reducedMotion) {
      const lines = this.visuals.createRadialSpeedLinesMesh?.(COMIC.gold);
      if (lines) {
        lines.position.copy(origin);
        this.scene.add(lines);
        this.effects.push({ mesh: lines, life: 0.24, maxLife: 0.24 });
      }
    }

    // Repulse and stagger close hostiles on activation
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const dx = enemy.mesh.position.x - origin.x;
      const dz = enemy.mesh.position.z - origin.z;
      const dist = Math.hypot(dx, dz);
      if (dist > OVERDRIVE_SHOCKWAVE_RADIUS) continue;
      const push = new THREE.Vector3(dx || 1, 0, dz).normalize();
      this.damageEnemy(enemy, 45, 18, push, "splash");
      enemy.windupTimer = 0;
      this.clearTelegraph(enemy);
    }

    this.audio.playOverdriveActivate?.();
    this.cameraShake = Math.max(this.cameraShake, 0.55);
    this.announcement = "OVERDRIVE SURGE! INFINITE MAG · 100% CRIT · +45% FIRE RATE";
    this.announcementTimer = 2.6;
    this.spawnFloatingText(origin.clone().setY(1.9), "OVERDRIVE!", "combo");
    this.emitHud(true);
  }

  private triggerPerfectDodge() {
    this.dashPerfectUsed = true;
    this.bulletTimeTimer = PERFECT_DODGE_SLOWMO_DURATION;
    this.bulletTimeScale = PERFECT_DODGE_SLOWMO_SCALE;
    this.dashCooldown = Math.max(0, this.dashCooldown * (1 - PERFECT_DODGE_DASH_REFUND));
    this.perfectDodgeShotBuff = true;
    this.addOverdriveCharge(PERFECT_DODGE_OVERDRIVE_GAIN);
    this.audio.playPerfectDodge?.();
    this.cameraShake = Math.max(this.cameraShake, 0.24);
    this.spawnFloatingText(this.playerMesh.position.clone().setY(1.85), "PERFECT DODGE!", "combo");
    if (!this.profile.settings.reducedMotion) {
      const lines = this.visuals.createRadialSpeedLinesMesh?.(COMIC.electric);
      if (lines) {
        lines.position.copy(this.playerMesh.position);
        this.scene.add(lines);
        this.effects.push({ mesh: lines, life: 0.2, maxLife: 0.2 });
      }
    }
    this.emitHud(true);
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
    // Preserve the stick's analog magnitude; only clamp combined/diagonal input.
    if (inputDir.lengthSq() > 1) inputDir.normalize();

    // Natural responsive acceleration & deceleration friction
    // +12% move speed per Adrenaline stack while wounded, +28% during Overdrive.
    const adrenalineSpeed = 1 + 0.12 * this.adrenalineRank();
    const overdriveSpeed = (this.overdriveRemaining ?? 0) > 0 ? OVERDRIVE_SPEED_MULT : 1;
    const targetSpeed = this.dashRemaining > 0 ? 18.5 : this.moveSpeed * adrenalineSpeed * overdriveSpeed;
    const targetVelocity = (this.dashRemaining > 0 ? this.dashDirection : inputDir).clone().multiplyScalar(targetSpeed);

    const accelRate = this.dashRemaining > 0 ? 90 : hasInput ? 54 : 18;
    this.playerVelocity.lerp(targetVelocity, 1 - Math.exp(-dt * accelRate));

    const currentSpeed = this.playerVelocity.length();

    // Smooth obstacle collision & tangential wall sliding
    const nextPos = this.playerMesh.position.clone().addScaledVector(this.playerVelocity, dt);
    const playerRadius = 0.48;

    for (const obstacle of this.obstacles) {
      resolveCircleObstacle(nextPos, playerRadius, obstacle, this.playerVelocity);
    }

    // Arena boundary clamp
    nextPos.x = THREE.MathUtils.clamp(nextPos.x, -ARENA_LIMIT, ARENA_LIMIT);
    nextPos.z = THREE.MathUtils.clamp(nextPos.z, -ARENA_LIMIT, ARENA_LIMIT);

    this.footstepTravel = (this.footstepTravel ?? 0) + this.playerMesh.position.distanceTo(nextPos);
    if (this.footstepTravel > 1.7 && this.dashRemaining <= 0) {
      this.footstepTravel = 0; this.audio.playFootstep?.(this.currentArena?.id === "rooftop");
    }
    this.playerMesh.position.set(nextPos.x, 0, nextPos.z);

    // Snappy smoothed aim rotation
    const targetFacing = Math.atan2(this.aim.x, this.aim.z);
    const facingDelta = Math.atan2(
      Math.sin(targetFacing - this.playerMesh.rotation.y),
      Math.cos(targetFacing - this.playerMesh.rotation.y),
    );
    this.playerMesh.rotation.y += facingDelta * (1 - Math.exp(-dt * 32));

    if (this.playerRig) {
      this.playerRig.reloadProgress = normalizedReloadProgress(this.weaponStates.get(this.getActiveWeaponId()));
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
    if ((this.overdriveRemaining ?? 0) > 0) {
      this.overdriveRemaining = Math.max(0, this.overdriveRemaining - dt);
      if (this.overdriveAura) {
        this.overdriveAura.visible = true;
        if (!this.profile.settings.reducedMotion) this.overdriveAura.rotation.y += dt * 4.2;
      }
    } else if (this.overdriveAura) {
      this.overdriveAura.visible = false;
    }

    if (this.dashRemaining > 0) {
      const wasDashing = this.dashRemaining;
      this.dashRemaining = Math.max(0, this.dashRemaining - dt);

      // Caustic Jet (and Napalm Wake fusion): lay a damaging trail along the dash path.
      const acidRank = this.activeSynergies.get("acid_dash") ?? 0;
      if (acidRank > 0) {
        this.acidTrailTimer -= dt;
        if (this.acidTrailTimer <= 0) {
          this.acidTrailTimer = 0.05;
          const napalmFusion = this.unlockedFusions?.has("napalm_wake") ?? false;
          this.spawnHazard(
            this.playerMesh.position,
            napalmFusion ? 1.45 : 1.15,
            40 * acidRank * (napalmFusion ? 1.6 : 1),
            napalmFusion ? 4.2 : 3.2,
            { variant: napalmFusion ? "napalm" : "acid", ignites: napalmFusion },
          );
        }
      }

      // Seismic Surge: the blast fires as the dash ends, not as it begins.
      const kineticRank = this.activeSynergies.get("kinetic_impact") ?? 0;
      if (kineticRank > 0 && wasDashing > 0 && this.dashRemaining === 0) {
        this.detonateSeismicSurge(kineticRank);
      }
      if (!this.profile.settings.reducedMotion && Math.random() < 0.25) {
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
          this.spawnHazard(new THREE.Vector3(x, 0, z), 1.9, 26, 9, { hostile: true, variant: "toxic" });
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
        this.completeWave();
        return;
      }

      if (!this.waveCleared) {
        this.waveCleared = true;
        this.extractionTimer = 0;
        if (this.extractionZoneMesh) this.extractionZoneMesh.visible = true;
        this.announcement = " WAVE CLEARED! Step into the Central Beacon to advance";
        this.announcementTimer = 4.0;
        this.audio.playPickup("coin");
      }

      if (this.waveCleared) {
        if (this.extractionZoneMesh) {
          this.extractionZoneMesh.visible = true;
          if (!this.profile.settings.reducedMotion) this.extractionZoneMesh.rotation.y += dt * 0.3;
        }

        const playerDist = Math.hypot(this.playerMesh.position.x, this.playerMesh.position.z);
        if (playerDist < 3.2) {
          this.extractionTimer += dt;
          if (this.extractionTimer >= this.extractionRequiredTime) {
            this.waveCleared = false;
            this.extractionTimer = 0;
            if (this.extractionZoneMesh) this.extractionZoneMesh.visible = false;
            this.completeWave();
          }
        } else {
          this.extractionTimer = Math.max(0, this.extractionTimer - dt * 2.0);
        }
      }
    }
  }

  private completeWave() {
    this.waveActive = false;
    this.stats.wavesCleared += 1;
    // Extraction banks the cleared arena's salvage, including the final boss
    // drop; the victory screen otherwise opens before it can be collected.
    let salvage = 0;
    for (let index = this.pickups.length - 1; index >= 0; index -= 1) {
      const pickup = this.pickups[index];
      if (pickup.type !== "coin") continue;
      salvage += pickup.value;
      this.scene.remove(pickup.mesh);
      this.visuals.disposeObject(pickup.mesh);
      this.pickups.splice(index, 1);
    }
    if (salvage > 0) this.callbacks.onCoins(salvage);
    this.pause();
    this.emitHud(true);
    if (this.wave >= CAMPAIGN_WAVES && !this.endless) this.callbacks.onVictory();
    else this.callbacks.onWaveComplete(this.wave);
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
            this.announcement = " PROTOTYPE JUGGERNAUT PHASE 2: GROUND SLAM!";
            this.announcementTimer = 3.2;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "PHASE 2! ", "comic-slam");
            this.spawnReinforcements("runner", 2);
          }
        } else {
          // Wave 10 Titan Dreadnought Prime: 3 Phases
          if (hpRatio <= 0.33 && (enemy.bossPhase ?? 1) < 3) {
            enemy.bossPhase = 3;
            this.audio.playBossPhaseShift();
            this.announcement = " TITAN ENRAGED: BERSERK STRIKES!";
            this.announcementTimer = 3.5;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "BERSERK! ", "comic-rage");
            this.spawnReinforcements("runner", 4);
          } else if (hpRatio <= 0.66 && hpRatio > 0.33 && (enemy.bossPhase ?? 1) < 2) {
            enemy.bossPhase = 2;
            this.audio.playBossPhaseShift();
            this.announcement = " TITAN PHASE 2: GROUND SLAM & SHOCKWAVES!";
            this.announcementTimer = 3.2;
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.4), "PHASE 2! ", "comic-slam");
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
          this.updateBossWarning(enemy);
          const phase = enemy.bossPhase ?? 1;
          if (phase === 2 && enemy.specialCooldown <= 0 && distance < 8.2) {
            enemy.specialCooldown = 5.2;
            const shock = this.visuals.createShockwaveMesh(6.2, 0xff0044);
            shock.position.copy(enemy.mesh.position);
            this.scene.add(shock);
            this.effects.push({ mesh: shock, life: 0.5, maxLife: 0.5 });
            this.audio.playGroundSlam();
            this.cameraShake = Math.max(this.cameraShake, 0.75);
            this.spawnFloatingText(enemy.mesh.position.clone().setY(2.2), "GROUND SLAM! ", "comic-slam");
            if (distance < 6.2) {
              this.damagePlayer(36);
            }
          } else if (phase !== 2 && enemy.specialCooldown <= 0 && distance > 4.2) {
            enemy.chargeRemaining = phase === 3 ? 1.4 : 1.1;
            enemy.specialCooldown = phase === 3 ? 3.6 : 5.4;
            this.announcement = phase === 3 ? " RELENTLESS BERSERK CHARGE!" : " Juggernaut charge incoming!";
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

      // Show pulsing golden execution marker when wounded enough for Cyber-Blade Teleport Execute!
      const executable = isEnemyExecutable(enemy.health, enemy.maxHealth, enemy.type === "juggernaut");
      if (executable && !enemy.executeMarker && this.visuals.createExecuteMarker) {
        enemy.executeMarker = this.visuals.createExecuteMarker(enemy.definition.radius + 0.25);
        enemy.mesh.add(enemy.executeMarker);
      }
      if (enemy.executeMarker) {
        enemy.executeMarker.visible = executable;
        if (executable) {
          const pip = enemy.executeMarker.getObjectByName("exec-pip");
          if (pip) {
            pip.rotation.y += dt * 4.5;
            pip.position.y = enemy.definition.radius * 2.1 + 1.45 + Math.sin(this.missionElapsed * 7) * 0.12;
          }
        }
      }

      if (enemy.telegraph) {
        enemy.telegraph.position.copy(enemy.mesh.position).setY(0.05);
        // The boundary stays at the real damage radius; only the inner timer fills.
        const behaviour = BEHAVIOURS[enemy.type];
        const progress = 1 - enemy.windupTimer / Math.max(0.0001, behaviour.windup);
        enemy.telegraph.getObjectByName("telegraph-fill")?.scale.setScalar(Math.max(0.05, progress));
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

    const fireball = this.visuals.createFireballExplosion?.(3.2, COMIC.acid);
    if (fireball) {
      fireball.position.copy(position);
      this.scene.add(fireball);
      this.effects.push({ mesh: fireball, life: 0.48, maxLife: 0.48 });
    }

    this.visuals.addAcidDecal(this.scene, position, 1.6);
    this.flashBlastLight(position, COMIC.acid, 11);
    this.postChromatic = Math.max(this.postChromatic ?? 0, 0.65);
    this.cameraShake = Math.max(this.cameraShake, 0.75);
    this.audio.playBoomerDetonation();
    this.spawnFloatingText(position.clone().setY(1.6), "BOOM! ", "comic-boom");
  }

  private updateProjectiles(dt: number) {
    const from = this.projectileStart;
    const to = this.projectileEnd;
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      from.copy(projectile.mesh.position);
      to.copy(from).addScaledVector(projectile.velocity, Math.min(dt, projectile.life));
      if (projectile.isSawblade) projectile.mesh.rotation.y += dt * 26;
      projectile.life -= dt;

      // Sweep the whole travelled segment, and resolve the nearest contact
      // first. Endpoint tests miss thin cover and grazing hits at rifle speed.
      let stopped = false;
      for (let contacts = this.enemies.length + 1; contacts > 0; contacts -= 1) {
        let hitTime = Infinity;
        let obstacle: Obstacle | null = null;
        let barrel: BarrelEntity | null = null;
        let target: EnemyEntity | null = null;
        let playerHit = false;
        for (const candidate of this.obstacles) {
          const t = segmentObstacleHit(from, to, candidate);
          if (t !== null && t < hitTime) { hitTime = t; obstacle = candidate; }
        }
        if (projectile.enemy) {
          const height = from.y - 1;
          const radiusSq = 0.9 ** 2 - height * height;
          const t = radiusSq > 0 ? segmentCircleHit(from, to, this.playerMesh.position, Math.sqrt(radiusSq)) : null;
          if (t !== null && t < hitTime) { hitTime = t; obstacle = null; playerHit = true; }
        } else {
          for (const candidate of this.barrels) {
            if (!candidate.active) continue;
            const t = segmentCircleHit(from, to, candidate.mesh.position, 0.72);
            if (t !== null && t < hitTime) { hitTime = t; obstacle = null; barrel = candidate; }
          }
          for (const candidate of this.enemies) {
            if (candidate.health <= 0 || projectile.hitEnemies?.has(candidate)) continue;
            const t = segmentCircleHit(from, to, candidate.mesh.position, candidate.definition.radius + 0.2);
            if (t !== null && t < hitTime) { hitTime = t; obstacle = null; barrel = null; target = candidate; }
          }
        }
        if (!Number.isFinite(hitTime)) break;
        projectile.mesh.position.lerpVectors(from, to, hitTime);
        if (target) {
          projectile.hitEnemies ??= new Set();
          projectile.hitEnemies.add(target);
          if (projectile.ignites) {
            target.burningTimer = Math.max(target.burningTimer ?? 0, 3.5);
            target.burnDps = Math.max(target.burnDps ?? 0, 26);
          }
          this.damageEnemy(
            target,
            projectile.damage,
            projectile.knockback,
            projectile.direction,
            projectile.isShrapnel ? "shrapnel" : "bullet",
            { forceCrit: projectile.forceCrit, overcharged: projectile.overcharged },
          );
          projectile.pierceCount = (projectile.pierceCount ?? 0) + 1;
          if (projectile.pierceCount <= (projectile.maxPierces ?? 0)) continue;
        } else if (obstacle) {
          if (!projectile.enemy && obstacle.health !== undefined) {
            this.damageObstacle(obstacle, projectile.damage, projectile.mesh.position);
          } else if ((projectile.bouncesRemaining ?? 0) > 0) {
            projectile.bouncesRemaining! -= 1;
            if (this.unlockedFusions?.has("rail_bounce")) {
              projectile.damage = Math.round(projectile.damage * 1.45);
              projectile.pierceCount = 0;
            }
            const normal = this.projectileNormal;
            if (obstacle.radius) {
              normal.set(projectile.mesh.position.x - obstacle.x, 0, projectile.mesh.position.z - obstacle.z).normalize();
            } else {
              const dx = projectile.mesh.position.x - obstacle.x;
              const dz = projectile.mesh.position.z - obstacle.z;
              if (Math.abs(Math.abs(dx) - obstacle.hx) <= Math.abs(Math.abs(dz) - obstacle.hz)) normal.set(Math.sign(dx) || 1, 0, 0);
              else normal.set(0, 0, Math.sign(dz) || 1);
            }
            const speed = projectile.velocity.length();
            projectile.direction.copy(projectile.velocity).normalize().reflect(normal);
            // Retain assisted ricochets, but only toward targets on this side
            // of cover. Direction stays unit length for consistent knockback.
            let nearest = 12 ** 2;
            for (const enemy of this.enemies) {
              if (enemy.health <= 0 || projectile.hitEnemies?.has(enemy)) continue;
              const dx = enemy.mesh.position.x - projectile.mesh.position.x;
              const dz = enemy.mesh.position.z - projectile.mesh.position.z;
              const distanceSq = dx * dx + dz * dz;
              if (distanceSq > 0 && distanceSq < nearest && dx * normal.x + dz * normal.z > 0) {
                nearest = distanceSq;
                projectile.direction.set(dx, 0, dz).normalize();
              }
            }
            projectile.velocity.copy(projectile.direction).multiplyScalar(speed);
            projectile.mesh.position.addScaledVector(normal, 0.002);
            projectile.mesh.quaternion.setFromUnitVectors(this.projectileUp, projectile.direction);
            this.audio.tone(420, 0.03, 0.04, "triangle");
            stopped = true;
            break;
          }
        } else if (barrel) this.explodeBarrel(barrel);
        else if (playerHit) this.damagePlayer(projectile.damage);

        this.removeProjectile(index);
        stopped = true;
        break;
      }
      if (this.paused) return;
      if (stopped) {
        if (this.projectiles[index] === projectile && projectile.life <= 0) this.removeProjectile(index);
        continue;
      }
      projectile.mesh.position.copy(to);
      // Spinning sawblades also bounce off the arena perimeter walls!
      if (projectile.isSawblade && (projectile.bouncesRemaining ?? 0) > 0 && (Math.abs(to.x) > ARENA_LIMIT || Math.abs(to.z) > ARENA_LIMIT)) {
        projectile.bouncesRemaining! -= 1;
        if (Math.abs(to.x) > ARENA_LIMIT) {
          projectile.velocity.x *= -1;
          projectile.direction.x *= -1;
          projectile.mesh.position.x = THREE.MathUtils.clamp(to.x, -ARENA_LIMIT, ARENA_LIMIT);
        }
        if (Math.abs(to.z) > ARENA_LIMIT) {
          projectile.velocity.z *= -1;
          projectile.direction.z *= -1;
          projectile.mesh.position.z = THREE.MathUtils.clamp(to.z, -ARENA_LIMIT, ARENA_LIMIT);
        }
        projectile.hitEnemies?.clear();
        this.audio.tone(540, 0.04, 0.05, "sawtooth");
        continue;
      }
      if (projectile.life <= 0 || Math.abs(to.x) > 21 || Math.abs(to.z) > 21) this.removeProjectile(index);
    }
  }

  private damageEnemy(
    enemy: EnemyEntity,
    damage: number,
    knockbackForce: number,
    bulletDir: THREE.Vector3,
    source: DamageSource = "splash",
    options?: { forceCrit?: boolean; overcharged?: boolean },
  ) {
    if (source === "bullet") this.stats.shotsHit += 1;

    // Frontal Armor check on Juggernaut Phase 1
    if (enemy.type === "juggernaut" && (enemy.bossPhase ?? 1) === 1) {
      const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), enemy.mesh.rotation.y);
      if (bulletDir.dot(forward) < -0.28) {
        damage = Math.max(1, Math.round(damage * 0.45));
        this.spawnFloatingText(enemy.mesh.position.clone().setY(2.2), "ARMORED! ", "damage");
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
        this.damageFeedback.add(enemy, damage);
      }
      this.audio.playHit(false);
      return;
    }

    const isChilled = (enemy.chilledTimer ?? 0) > 0;
    const critChance =
      0.2 +
      (isChilled ? 0.15 : 0) +
      (options?.overcharged ? OVERCHARGE_CRIT_BONUS : 0);
    const isCrit = options?.forceCrit === true || Math.random() < critChance;
    const finalDamage = isCrit ? Math.round(damage * 1.55) : Math.round(damage);
    if (isCrit && source === "bullet") this.addOverdriveCharge(1.5);

    enemy.health -= finalDamage;
    enemy.hitFlash = 0.12;
    this.stats.damageDealt += finalDamage;

    const hitPos = enemy.mesh.position.clone().setY(1.05 * enemy.rig.scale);

    // Status synergies
    const incendiaryRank = this.activeSynergies.get("incendiary") ?? 0;
    if (incendiaryRank > 0) {
      enemy.burningTimer = 3.8;
      enemy.burnDps = 22 * incendiaryRank;
    }
    const cryoRank = this.activeSynergies.get("cryo_frost") ?? 0;
    if (cryoRank > 0) {
      const wasChilled = (enemy.chilledTimer ?? 0) > 0;
      enemy.chilledTimer = 4.2;
      // -30% speed per stack, floored so a chilled enemy never fully freezes.
      enemy.chillMult = Math.max(0.25, 1 - 0.3 * cryoRank);
      if (!wasChilled || isCrit) {
        this.audio.playFreeze();
      }
    }

    // Vampiric Leech heal on crit
    if (this.activeSynergies.has("vampiric_leech") && isCrit) {
      const heal = 4 * (this.activeSynergies.get("vampiric_leech") ?? 1);
      this.playerHealth = Math.min(this.maxHealth, this.playerHealth + heal);
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.3), `+${heal} HP`, "comic-leech");
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
      const superconductor = this.unlockedFusions?.has("superconductor") ?? false;
      const baseZap = 35 * teslaRank;
      const maxTargets = superconductor ? 5 : 3;
      const nearby = this.enemies
        .filter((e) => e !== enemy && e.mesh.position.distanceTo(enemy.mesh.position) < (superconductor ? 8.5 : 7.2))
        .slice(0, maxTargets);
      if (nearby.length > 0) {
        const points = [hitPos];
        for (const target of nearby) {
          const targetChilled = (target.chilledTimer ?? 0) > 0;
          const zapDamage = Math.round(baseZap * (superconductor && targetChilled ? 1.8 : 1));
          points.push(target.mesh.position.clone().setY(1.0));
          target.health -= zapDamage;
          target.hitFlash = 0.12;
          if (superconductor) {
            target.chilledTimer = Math.max(target.chilledTimer ?? 0, 3.5);
            target.chillMult = Math.min(target.chillMult ?? 1, 0.6);
          }
          this.stats.damageDealt += zapDamage;
          this.damageFeedback.add(target, zapDamage, superconductor && targetChilled);
        }
        const lightning = this.visuals.createChainLightningMesh(points, superconductor ? COMIC.frost : COMIC.electric);
        this.scene.add(lightning);
        this.effects.push({ mesh: lightning, life: 0.14, maxLife: 0.14 });
        this.audio.playChainLightning();
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

    this.damageFeedback.add(enemy, finalDamage, isCrit);
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

  private updateBossWarning(enemy: EnemyEntity) {
    const slamSoon = enemy.bossPhase === 2 && enemy.specialCooldown <= 0.8;
    const chargeSoon = enemy.bossPhase !== 2 && (enemy.specialCooldown <= 0.65 || enemy.chargeRemaining > 0);
    if (slamSoon || chargeSoon) {
      const radius = slamSoon ? 6.2 : enemy.definition.attackRange + 0.35;
      if (enemy.specialTelegraph?.userData.radius !== radius) {
        if (enemy.specialTelegraph) { this.scene.remove(enemy.specialTelegraph); this.visuals.disposeObject(enemy.specialTelegraph); }
        enemy.specialTelegraph = this.visuals.createTelegraphCircle(radius);
        enemy.specialTelegraph.userData.radius = radius; this.scene.add(enemy.specialTelegraph);
      }
      enemy.specialTelegraph.position.copy(enemy.mesh.position).setY(0.06);
    } else if (enemy.specialTelegraph) {
      this.scene.remove(enemy.specialTelegraph); this.visuals.disposeObject(enemy.specialTelegraph); enemy.specialTelegraph = undefined;
    }
  }

  private clearTelegraph(enemy: EnemyEntity) {
    if (enemy.specialTelegraph) {
      this.scene.remove(enemy.specialTelegraph); this.visuals.disposeObject(enemy.specialTelegraph); enemy.specialTelegraph = undefined;
    }
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
    // Remove the simulation entity immediately. The corpse owns only its rig.
    this.enemies.splice(index, 1);
    enemy.healthBar?.removeFromParent(); enemy.shieldMesh?.removeFromParent(); enemy.executeMarker?.removeFromParent();
    this.visuals.beginDeath(enemy.rig);
    this.corpses.push({ rig: enemy.rig, life: 0.85 });
    while (this.corpses.length > 10) {
      const oldest = this.corpses.shift(); if (oldest) this.visuals.disposeCharacter(oldest.rig);
    }

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

    if (enemy.type === "juggernaut") {
      this.spawnFloatingText(position.clone().setY(2), "KRAKOOM!", "comic-boom");
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
      this.spawnFloatingText(this.playerMesh.position.clone().setY(1.3), `+${heal} HP`, "comic-leech");
    }

    // Charge Overdrive & Tech Energy on kill + refund frag cooldown
    if ((this.grenadeCooldown ?? 0) > 0) {
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - 0.5);
    }
    this.techEnergy = Math.min(TECH_ENERGY_MAX, (this.techEnergy ?? 0) + TECH_ENERGY_KILL_GAIN);
    if ((this.overdriveRemaining ?? 0) > 0) {
      const remainingExtensionBudget = Math.max(0, OVERDRIVE_MAX_EXTENSION - (this.overdriveExtensionUsed ?? 0));
      const ext = Math.min(OVERDRIVE_KILL_EXTENSION, remainingExtensionBudget);
      if (ext > 0) {
        this.overdriveRemaining += ext;
        this.overdriveDuration = Math.max(this.overdriveDuration, this.overdriveRemaining);
        this.overdriveExtensionUsed = (this.overdriveExtensionUsed ?? 0) + ext;
      }
    } else {
      const chargeGain = enemy.type === "juggernaut" ? 40 : enemy.isElite ? 20 : 12;
      this.addOverdriveCharge(chargeGain + (milestone ? 10 : 0));
    }

    // Combo salvage multiplier rewards aggressive streaks!
    const comboMult = getComboSalvageMultiplier(this.comboCount);
    this.createPickup("coin", position, Math.round(enemy.reward * comboMult));
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
    if (!barrel.active) return;
    barrel.active = false;
    barrel.chainTimer = undefined;
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

    // Chain-detonate nearby explosive barrels with a crisp staggered fuse!
    for (const other of this.barrels) {
      if (!other.active || other === barrel || other.chainTimer !== undefined) continue;
      if (other.mesh.position.distanceTo(position) <= BARREL_CHAIN_RADIUS) {
        other.chainTimer = BARREL_CHAIN_DELAY;
      }
    }

    const fireball = this.visuals.createFireballExplosion?.(3.8, COMIC.fire);
    if (fireball) {
      fireball.position.copy(position);
      this.scene.add(fireball);
      this.effects.push({ mesh: fireball, life: 0.5, maxLife: 0.5 });
    }

    this.visuals.addScorchDecal?.(this.scene, position, 1.3);
    this.flashBlastLight(position, COMIC.fire, 15);
    this.postChromatic = Math.max(this.postChromatic ?? 0, 0.9);
    this.cameraShake = 0.8;
    this.audio.playExplosion();
  }

  private updateBarrels(dt: number) {
    for (const barrel of this.barrels) {
      if (!barrel.active || barrel.chainTimer === undefined) continue;
      barrel.chainTimer -= dt;
      if (barrel.chainTimer <= 0) {
        this.explodeBarrel(barrel);
      }
    }
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
    if (this.playerHealth <= 0) return;
    let coinsCollected = 0;
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
        if (pickup.type === "health" && this.playerHealth >= this.maxHealth) continue;
        let ammoTargetId: WeaponId | null = null;
        if (pickup.type === "ammo") {
          const activeId = this.getActiveWeaponId();
          const candidates = [activeId, ...this.getAvailableWeapons().filter((w) => w !== activeId)];
          for (const candidateId of candidates) {
            const candidateState = this.weaponStates.get(candidateId);
            if (candidateState && candidateState.reserve < getWeaponStats(candidateId, this.profile.weaponRanks[candidateId]).reserve) {
              ammoTargetId = candidateId;
              break;
            }
          }
          if (!ammoTargetId) continue;
        }
        const pickupPos = pickup.mesh.position.clone().setY(1.2);
        this.audio.playPickup(pickup.type);
        if (pickup.type === "coin") {
          coinsCollected += pickup.value;
          this.spawnFloatingText(pickupPos, `+${pickup.value} `, "coin");
        } else if (pickup.type === "ammo" && ammoTargetId) {
          const state = this.weaponStates.get(ammoTargetId);
          if (state) {
            const stats = getWeaponStats(ammoTargetId, this.profile.weaponRanks[ammoTargetId]);
            state.reserve = Math.min(stats.reserve, state.reserve + Math.ceil(stats.reserve * 0.35));
          }
          const isHolstered = ammoTargetId !== this.getActiveWeaponId();
          this.spawnFloatingText(
            pickupPos,
            isHolstered ? `+AMMO (${WEAPONS[ammoTargetId].name.split(" ").pop()?.toUpperCase()})` : "+AMMO",
            "ammo",
          );
        } else {
          const healed = Math.min(pickup.value, this.maxHealth - this.playerHealth);
          this.playerHealth += healed;
          this.spawnFloatingText(pickupPos, `+${healed} HP`, "health");
        }
        this.scene.remove(pickup.mesh);
        this.visuals.disposeObject(pickup.mesh);
        this.pickups.splice(index, 1);
      }
    }
    // A magnet sweep can collect a whole horde's drops in one tick.
    if (coinsCollected > 0) this.callbacks.onCoins(coinsCollected);
  }

  /** Drop a lingering damage zone on the ground. */
  private spawnHazard(
    position: THREE.Vector3,
    radius: number,
    dps: number,
    life: number,
    options?: { hostile?: boolean; variant?: "acid" | "toxic" | "napalm"; ignites?: boolean },
  ) {
    const variant = options?.variant ?? (options?.hostile ? "toxic" : "acid");
    const pool = this.visuals.createSlimePool(radius, variant);
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
      hostile: options?.hostile,
      ignites: options?.ignites,
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

  /** Seismic Surge (and Blood Nova fusion): a 360 degree shove-and-damage burst around the player. */
  private detonateSeismicSurge(rank: number) {
    const bloodNova = this.unlockedFusions?.has("blood_nova") ?? false;
    const radius = bloodNova ? 7.3 : 5.4;
    const origin = this.playerMesh.position.clone();

    const shock = this.visuals.createShockwaveMesh(radius, bloodNova ? COMIC.blood : COMIC.electric);
    shock.position.copy(origin).setY(0.08);
    this.scene.add(shock);
    this.effects.push({ mesh: shock, life: 0.42, maxLife: 0.42 });
    this.audio.playGroundSlam();
    this.cameraShake = Math.max(this.cameraShake, 0.4);
    this.spawnFloatingText(origin.clone().setY(1.5), bloodNova ? "BLOOD NOVA!" : "SEISMIC SURGE! ", "comic-slam");

    let hits = 0;
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy) continue;
      const dx = enemy.mesh.position.x - origin.x;
      const dz = enemy.mesh.position.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance > radius) continue;
      hits += 1;
      const push = new THREE.Vector3(dx || 1, 0, dz).normalize();
      this.damageEnemy(enemy, 85 * rank, 15, push, "splash");
      // Stagger: interrupt any wind-up so the burst buys real breathing room.
      enemy.windupTimer = 0;
      this.clearTelegraph(enemy);
    }

    if (bloodNova && hits > 0 && this.playerHealth > 0) {
      const heal = Math.min(24, hits * 3);
      const restored = Math.min(heal, this.maxHealth - this.playerHealth);
      if (restored > 0) {
        this.playerHealth += restored;
        this.spawnFloatingText(origin.clone().setY(1.8), `+${restored} HP`, "health");
      }
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
        const progress = 1 - Math.max(0, event.timer) / (ARENA_LIMIT / 9);
        event.payload.scale.setScalar(Math.max(0.4, progress * ARENA_LIMIT));
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
      const marker = this.visuals.createTelegraphAnnulus(ARENA_LIMIT - hazard.radius, ARENA_LIMIT * Math.SQRT2);
      marker.rotation.x = -Math.PI / 2;
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

      // The pool outline retains the damage footprint until expiry.
      hazard.mesh.scale.setScalar(1);

      // Tick at 5Hz rather than per frame: cheaper, and damage numbers stay
      // readable instead of spraying sixty popups a second.
      if (hazard.tickTimer <= 0) {
        hazard.tickTimer = 0.2;
        if (hazard.hostile && this.playerHealth > 0) {
          const pdx = this.playerMesh.position.x - hazard.x;
          const pdz = this.playerMesh.position.z - hazard.z;
          if (pdx * pdx + pdz * pdz <= (hazard.radius + 0.35) ** 2) {
            this.damagePlayer(Math.max(1, Math.round(15 * 0.2)));
          }
        }
        for (let e = this.enemies.length - 1; e >= 0; e -= 1) {
          const enemy = this.enemies[e];
          if (!enemy) continue;
          const dx = enemy.mesh.position.x - hazard.x;
          const dz = enemy.mesh.position.z - hazard.z;
          if (dx * dx + dz * dz > (hazard.radius + enemy.definition.radius) ** 2) continue;
          enemy.health -= hazard.dps * 0.2;
          this.stats.damageDealt += hazard.dps * 0.2;
          enemy.hitFlash = Math.max(enemy.hitFlash, 0.05);
          if (hazard.ignites) {
            enemy.burningTimer = Math.max(enemy.burningTimer ?? 0, 3.6);
            enemy.burnDps = Math.max(enemy.burnDps ?? 0, 28);
          }
        }
      }

      if (hazard.life <= 0) {
        this.scene.remove(hazard.mesh);
        this.visuals.disposeObject(hazard.mesh);
        this.hazards.splice(index, 1);
      }
    }
  }

  private updatePresentation(dt: number) {
    this.damageFeedback.update(dt, (enemy, damage, critical) => {
      this.spawnFloatingText(enemy.mesh.position.clone().setY(1.8), `${damage}${critical ? "!" : ""}`, critical ? "crit" : "damage");
    });
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]; corpse.life -= dt;
      if (corpse.life <= 0) { this.visuals.disposeCharacter(corpse.rig); this.corpses.splice(i, 1); }
      else this.visuals.animateCharacter(corpse.rig, dt, 0, false, 0);
    }
  }

  private clearPresentation() {
    for (const corpse of this.corpses ?? []) this.visuals.disposeCharacter(corpse.rig);
    if (this.corpses) this.corpses.length = 0;
    this.damageFeedback?.clear();
    this.floatingLayer?.replaceChildren();
  }

  private updateEffects(dt: number) {
    while (this.effects.length > 96) {
      const oldest = this.effects.shift(); if (oldest) { this.scene.remove(oldest.mesh); this.visuals.disposeObject(oldest.mesh); }
    }
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.life -= dt;
      const progress = 1 - effect.life / effect.maxLife;
      if (!effect.fade) {
        const base = effect.mesh.userData.baseScale ?? 1;
        effect.mesh.scale.setScalar(base * (1 + progress * (effect.mesh.userData.muzzle || this.profile.settings.reducedMotion ? 0 : 1.25)));
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
    if (this.playerHealth <= 0) return;
    if (this.dashRemaining > 0) {
      if (!this.dashPerfectUsed) this.triggerPerfectDodge();
      return;
    }
    const dealt = Math.min(this.playerHealth, amount);
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.stats.damageTaken += dealt;
    this.cameraShake = Math.max(this.cameraShake, 0.48);
    this.postHitFlash = Math.max(this.postHitFlash ?? 0, 0.85);
    this.postChromatic = Math.max(this.postChromatic ?? 0, 0.65);
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
    // Only boss kills and combo milestones use a comic word treatment.
    if (type.startsWith("comic-") && text !== "KRAKOOM!") type = "damage";
    const projected = worldPos.clone().project(this.camera);
    if (projected.z < -1 || projected.z > 1) return;

    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const screenX = ((projected.x + 1) / 2) * width + THREE.MathUtils.randFloatSpread(6);
    const screenY = ((-projected.y + 1) / 2) * height + THREE.MathUtils.randFloatSpread(4);

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
      resolveCircleObstacle(position, radius, obstacle);
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
    this.audio.playSurfaceImpact?.(obstacle.health === undefined ? "metal" : "concrete");
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
      reloadProgress: normalizedReloadProgress(state),
      activeReloadAvailable: Boolean(state && state.reloading > 0 && !state.activeReloadAttempted),
      overchargedRounds: state?.overchargedRounds ?? 0,
      dash: 1 - Math.min(1, this.dashCooldown / this.dashCooldownTotal),
      grenade: 1 - Math.min(1, (this.grenadeCooldown ?? 0) / (this.grenadeCooldownTotal ?? 8)),
      blade: 1 - Math.min(1, (this.bladeCooldown ?? 0) / BLADE_COOLDOWN),
      executeTargetReady: this.enemies.some(
        (enemy) =>
          isEnemyExecutable(enemy.health, enemy.maxHealth, enemy.type === "juggernaut") &&
          enemy.mesh.position.distanceToSquared(this.playerMesh.position) <= BLADE_EXECUTE_RANGE * BLADE_EXECUTE_RANGE,
      ),
      techEnergy: Math.round(this.techEnergy ?? 0),
      turretCount: (this.deployables ?? []).filter((d) => d.kind === "turret").length,
      pylonCount: (this.deployables ?? []).filter((d) => d.kind === "pylon").length,
      superWeapon: this.activeSuperWeapon
        ? {
            id: this.activeSuperWeapon.id,
            name: SUPER_WEAPONS[this.activeSuperWeapon.id].name,
            ammo: this.activeSuperWeapon.ammo,
            maxAmmo: this.activeSuperWeapon.maxAmmo,
          }
        : null,
      overdriveCharge: Math.round(this.overdriveCharge ?? 0),
      overdriveActive: (this.overdriveRemaining ?? 0) > 0,
      overdriveProgress:
        (this.overdriveRemaining ?? 0) > 0
          ? Math.max(0, Math.min(1, this.overdriveRemaining / Math.max(0.01, this.overdriveDuration)))
          : 0,
      comboMultiplier: getComboSalvageMultiplier(this.comboCount),
      activeFusions: this.unlockedFusions ? [...this.unlockedFusions] : [],
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
    this.updatePresentation(dt);

    // Ticked before the early return, so a freeze cannot extend its own gate.
    this.hitStopCooldown = Math.max(0, this.hitStopCooldown - dt);

    // Hit-stop micro freeze frame (slow down/freeze simulation momentarily for punchy impact)
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= dt;
      this.updateCamera(dt);
      this.emitHud();
      return;
    }

    // Bullet-time slow-mo on Perfect Dodge and Overdrive activation:
    // Enemies/projectiles slow dramatically while Kai stays responsive!
    let simDt = dt;
    let playerDt = dt;
    if ((this.bulletTimeTimer ?? 0) > 0) {
      this.bulletTimeTimer = Math.max(0, this.bulletTimeTimer - dt);
      simDt = dt * (this.bulletTimeScale ?? 1);
      playerDt = dt * 0.78;
    }

    this.updatePlayer(playerDt);
    this.updateWave(simDt);
    if (this.paused) return;
    this.updateEnemies(simDt);
    if (this.paused) return;
    this.updateProjectiles(simDt);
    if (this.paused) return;
    this.updateGrenades(simDt);
    if (this.paused) return;
    this.updateDeployables(simDt);
    if (this.paused) return;
    this.updateOrbitalPods(simDt);
    if (this.paused) return;
    this.updateBarrels(simDt);
    if (this.paused) return;
    this.updateHazards(simDt);
    if (this.paused) return;
    this.updateArenaHazards(simDt);
    if (this.paused) return;
    // After projectiles, so indirect damage (chain lightning, burn splash,
    // explosions) resolves into deaths on the same frame it was dealt.
    this.reapDead();
    if (this.paused) return;
    this.updatePickups(playerDt);
    this.updateEffects(simDt);
    this.updateDynamicVisuals(dt);
    this.updateAtmosphere();
    this.updateCamera(dt);
    this.emitHud();
  }

  private updateDynamicVisuals(dt: number) {
    // 1. Tactical operator headlamp follows Kai & leads slightly along aim
    if (this.operatorLight) {
      this.operatorLight.position.set(
        this.playerMesh.position.x + this.aim.x * 1.4,
        2.35,
        this.playerMesh.position.z + this.aim.z * 1.4,
      );
      const inOverdrive = (this.overdriveRemaining ?? 0) > 0;
      this.operatorLight.color.setHex(inOverdrive ? COMIC.gold : 0x66e8ff);
      this.operatorLight.intensity = inOverdrive ? 4.4 : 2.8;
    }

    // 2. Decay muzzle & explosion dynamic lights
    if (this.muzzleLight && this.muzzleLightTimer > 0) {
      this.muzzleLightTimer = Math.max(0, this.muzzleLightTimer - dt);
      if (this.muzzleLightTimer <= 0) this.muzzleLight.intensity = 0;
    }
    if (this.blastLight && this.blastLightTimer > 0) {
      this.blastLightTimer = Math.max(0, this.blastLightTimer - dt);
      this.blastLight.intensity = (this.blastLightTimer / 0.24) * 14;
    }

    // 3. Flicker arena ambient accent lights gently
    for (let i = 0; i < (this.activeAccentLights?.length ?? 0); i += 1) {
      const light = this.activeAccentLights[i];
      const base = i === 0 ? 4.2 : 3.8;
      light.intensity = base + Math.sin(this.missionElapsed * (6.2 + i * 2.1)) * 0.55;
    }

    // 4. Raycasted tactical laser sight from Kai's muzzle
    if (this.laserSight) {
      const activeState = this.weaponStates.get(this.getActiveWeaponId());
      const origin = this.playerRig
        ? this.playerRig.muzzle.getWorldPosition(this.projectileStart)
        : this.projectileStart.set(this.playerMesh.position.x + this.aim.x * 0.75, 1.15, this.playerMesh.position.z + this.aim.z * 0.75);
      const maxRange = 17.5;
      this.projectileEnd.copy(origin).addScaledVector(this.aim, maxRange);
      let hitT = 1;
      for (const obs of this.obstacles) {
        const t = segmentObstacleHit(origin, this.projectileEnd, obs);
        if (t !== null && t < hitT) hitT = t;
      }
      for (const enemy of this.enemies) {
        if (enemy.health <= 0) continue;
        const t = segmentCircleHit(origin, this.projectileEnd, enemy.mesh.position, enemy.definition.radius + 0.15);
        if (t !== null && t < hitT) hitT = t;
      }
      const beamLength = Math.max(0.25, maxRange * hitT);
      const isHot = (this.overdriveRemaining ?? 0) > 0 || (activeState?.overchargedRounds ?? 0) > 0;
      this.laserSight.beamMaterial.color.setHex(isHot ? COMIC.gold : COMIC.electric);
      this.laserSight.dotMaterial.color.setHex(isHot ? 0xfff3a1 : 0xd9ffff);
      this.laserSight.beam.position.copy(origin);
      this.laserSight.beam.lookAt(origin.x + this.aim.x, origin.y, origin.z + this.aim.z);
      this.laserSight.beam.scale.set(1, 1, beamLength);
      this.laserSight.dot.position.set(
        origin.x + this.aim.x * beamLength,
        origin.y,
        origin.z + this.aim.z * beamLength,
      );
      this.laserSight.group.visible = this.playerHealth > 0 && (activeState?.reloading ?? 0) <= 0;
    }

    // 5. Ejected brass shell casings physics
    for (let i = (this.shellCasings?.length ?? 0) - 1; i >= 0; i -= 1) {
      const shell = this.shellCasings[i];
      shell.life -= dt;
      shell.velocity.y -= 14 * dt;
      shell.mesh.position.addScaledVector(shell.velocity, dt);
      shell.mesh.rotation.x += shell.spin.x * dt;
      shell.mesh.rotation.y += shell.spin.y * dt;
      shell.mesh.rotation.z += shell.spin.z * dt;
      if (shell.mesh.position.y < 0.04) {
        shell.mesh.position.y = 0.04;
        shell.velocity.y = Math.abs(shell.velocity.y) * 0.35;
        shell.velocity.x *= 0.6;
        shell.velocity.z *= 0.6;
        shell.spin.multiplyScalar(0.5);
      }
      if (shell.life <= 0) {
        this.scene.remove(shell.mesh);
        this.shellCasings.splice(i, 1);
      }
    }

    // 6. Atmospheric 3D weather particles (embers / storm rain / sparks / ash)
    if (this.activeWeather && !this.profile.settings.reducedMotion) {
      const identity = this.activeWeather.userData.weatherIdentity as string | undefined;
      const pos = this.activeWeather.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i += 1) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);
        if (identity === "floodbay") {
          y -= dt * 11.5;
          x -= dt * 1.4;
          if (y < 0.1) { y = 9.0; x = (Math.random() - 0.5) * 38; z = (Math.random() - 0.5) * 38; }
        } else if (identity === "rooftop") {
          x += dt * (2.6 + (i % 4) * 0.4);
          y += Math.sin(this.missionElapsed * 2 + i) * dt * 0.4;
          if (x > 19) x = -19;
        } else {
          // Rising embers / welding sparks
          y += dt * (0.75 + (i % 5) * 0.22);
          x += Math.sin(this.missionElapsed * 1.6 + i) * dt * 0.35;
          if (y > 9.0) { y = 0.2; x = (Math.random() - 0.5) * 36; z = (Math.random() - 0.5) * 36; }
        }
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
    }

    // 7. Drive bloom/chromatic/overdrive/hit-flash post-process uniforms
    this.postChromatic = Math.max(0, (this.postChromatic ?? 0) - dt * 2.8);
    this.postHitFlash = Math.max(0, (this.postHitFlash ?? 0) - dt * 3.2);
    const targetOverdrive = (this.overdriveRemaining ?? 0) > 0 ? 1 : 0;
    this.postOverdrive = THREE.MathUtils.lerp(this.postOverdrive ?? 0, targetOverdrive, 1 - Math.exp(-dt * 8));
    if (this.post && typeof this.post.setUniform === "function") {
      const reduced = this.profile.settings.reducedMotion;
      this.post.setUniform("uChromatic", reduced ? 0 : this.postChromatic);
      this.post.setUniform("uHitFlash", reduced ? 0 : this.postHitFlash);
      this.post.setUniform("uOverdrive", this.postOverdrive);
    }
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

    const shake = this.profile.settings.reducedMotion ? 0 : Math.min(0.2, this.cameraShake);
    const offsetX = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;
    const offsetZ = shake > 0 ? THREE.MathUtils.randFloatSpread(shake) : 0;

    const posX = this.cameraLook.x + this.cameraRecoil.x + offsetX;
    const posZ = this.cameraLook.z + CAMERA_BACK + this.cameraRecoil.z + offsetZ;
    this.camera.position.set(posX, CAMERA_HEIGHT, posZ);

    const targetX = this.cameraLook.x + this.cameraRecoil.x * 0.5;
    const targetZ = this.cameraLook.z + this.cameraRecoil.z * 0.5;
    this.camera.lookAt(targetX, 0.42, targetZ);

    this.cameraShake = Math.max(0, this.cameraShake - dt * 3.2);

    const desiredFov =
      (this.baseCameraFov ?? 42) +
      (!this.profile.settings.reducedMotion && (this.overdriveRemaining ?? 0) > 0 ? 3.5 : 0);
    if (Math.abs(this.camera.fov - desiredFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, desiredFov, dt > 0 ? 1 - Math.exp(-dt * 8) : 1);
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Wave pressure shifts the backdrop from cool blue toward an angry red sky.
   * Tinting the background beats dimming the scene: the arena stays readable
   * while the panel still gets visibly hotter as the run goes on.
   */
  private updateAtmosphere() {
    const pressure = Math.min(1, (this.wave - 1) / 9);
    // Endless and active Overdrive push the score to peak intensity.
    this.audio.setIntensity(this.endless || (this.overdriveRemaining ?? 0) > 0 ? 1 : pressure);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.skyCool).lerp(this.skyHot, pressure * 0.65);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.copy(this.scene.background);
      }
    }
  }

  private scheduleFrame() {
    if (!this.destroyed && !this.paused && this.frame === 0) this.frame = requestAnimationFrame(this.animate);
  }

  private animate = () => {
    this.renderFrame();
  };

  private renderFrame() {
    this.frame = 0;
    if (this.destroyed || this.paused) return;
    this.timer.update();
    const delta = Math.min(0.25, this.timer.getDelta());
    this.frameTimeAverage += (delta - this.frameTimeAverage) * 0.04;
    this.performanceSampleTime += delta;
    if (!this.qaMode && this.performanceSampleTime >= 2) {
      this.performanceSampleTime = 0;
      const maximum = Math.min(window.devicePixelRatio, this.maxPixelRatio);
      const minimum = Math.min(maximum, this.minPixelRatio);
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
    this.accumulator = Math.min(this.accumulator + delta, FIXED_STEP * MAX_CATCH_UP_STEPS);
    while (this.accumulator >= FIXED_STEP && !this.paused) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
    }
    if (!this.qaMode || this.qaFramesRendered < 2) {
      this.post.render(this.scene, this.camera);
      this.qaFramesRendered += 1;
    }
    this.scheduleFrame();
  }

  private resize = () => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.aspect = width / height;
    this.baseCameraFov = width / height < 0.8 ? 56 : 42;
    this.camera.fov = this.baseCameraFov;
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
    if (!this.paused && event.button === 1) {
      event.preventDefault();
      this.throwGrenade();
    }
    if (!this.paused && event.button === 2) {
      event.preventDefault();
      this.performBladeSlash();
    }
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
    if (code === "KeyF" || key === "f") {
      this.triggerOverdrive();
      return;
    }
    if (code === "KeyG" || key === "g") {
      this.throwGrenade();
      return;
    }
    if (code === "KeyV" || key === "v") {
      this.performBladeSlash();
      return;
    }
    if (code === "KeyT" || key === "t") {
      this.deployTurret();
      return;
    }
    if (code === "KeyC" || key === "c") {
      this.deployPylon();
      return;
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
      this.completeWave();
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
    this.dashPerfectUsed = false;
    // Phantom Reflex and active Overdrive both shorten the dash cooldown.
    const phantomRank = this.activeSynergies.get("phantom_reflex") ?? 0;
    const overdriveMult = (this.overdriveRemaining ?? 0) > 0 ? OVERDRIVE_DASH_COOLDOWN_MULT : 1;
    this.dashCooldownTotal = 2.8 * Math.max(0.4, 1 - 0.18 * phantomRank) * overdriveMult;
    this.dashCooldown = this.dashCooldownTotal;
    this.cameraShake = Math.max(this.cameraShake, 0.18);
    this.audio.playDash();

    if (!this.profile.settings.reducedMotion) {
      const speedLines = this.visuals.createRadialSpeedLinesMesh(COMIC.operator);
      speedLines.position.copy(this.playerMesh.position);
      this.scene.add(speedLines);
      this.effects.push({ mesh: speedLines, life: 0.14, maxLife: 0.14 });
    }
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
