export type GameScreen =
  | "lobby"
  | "loadout"
  /** The armory opened from the lobby, with no run in progress. */
  | "shop"
  | "playing"
  | "paused"
  | "armory"
  | "draft"
  | "dead"
  | "victory";

export type WeaponId = "pistol" | "smg" | "shotgun" | "rifle";
export type SuperWeaponId = "railcannon" | "minigun" | "sawblade";

export interface SuperWeaponDefinition {
  id: SuperWeaponId;
  name: string;
  tagline: string;
  ammo: number;
  damage: number;
  fireRate: number;
  color: number;
}
export type EnemyId = "shambler" | "runner" | "spitter" | "brute" | "juggernaut" | "boomer";
export type PickupId = "coin" | "ammo" | "health";
export type PerkId = "vitality" | "mobility" | "magnet";
export type ControlMode = "auto" | "touch" | "keyboard";
export type InputMode = Exclude<ControlMode, "auto">;
export type GraphicsMode = "auto" | "quality" | "performance";

export type SynergyCardId =
  | "piercing"
  | "ricochet"
  | "shrapnel"
  | "high_caliber"
  | "tesla_arcs"
  | "incendiary"
  | "cryo_frost"
  | "acid_dash"
  | "kinetic_impact"
  | "phantom_reflex"
  | "vampiric_leech"
  | "adrenaline_surge";

export type SynergyFusionId =
  | "superconductor"
  | "napalm_wake"
  | "rail_bounce"
  | "blood_nova";

export interface SynergyFusionDefinition {
  id: SynergyFusionId;
  name: string;
  pair: [SynergyCardId, SynergyCardId];
  description: string;
}

export type CardRarity = "common" | "rare" | "epic";

export interface SynergyCardDefinition {
  id: SynergyCardId;
  name: string;
  rarity: CardRarity;
  description: string;
  flavorText: string;
  icon: string;
  maxStacks: number;
}

export type EliteAffix = "shielded" | "frenzy" | "toxic";

export interface WeaponDefinition {
  id: WeaponId;
  name: string;
  description: string;
  cost: number;
  damage: number;
  fireRate: number;
  magazine: number;
  reserve: number;
  reload: number;
  spread: number;
  pellets: number;
  color: number;
}

export interface WeaponInstance {
  id: WeaponId;
  rank: number;
  magazine: number;
  reserve: number;
  cooldown: number;
  reloading: number;
  reloadDuration?: number;
  /** Whether the active-reload sweet-spot tap has already been attempted during this reload. */
  activeReloadAttempted?: boolean;
  /** Number of overcharged rounds left in the current magazine from a perfect active reload. */
  overchargedRounds?: number;
}

export interface EnemyDefinition {
  id: EnemyId;
  name: string;
  health: number;
  speed: number;
  damage: number;
  attackRange: number;
  attackCooldown: number;
  reward: number;
  radius: number;
  color: number;
}

export interface WaveDefinition {
  wave: number;
  label: string;
  enemies: Partial<Record<EnemyId, number>>;
  spawnInterval: number;
}

export interface PickupDefinition {
  id: PickupId;
  label: string;
  color: number;
}

export interface PlayerState {
  health: number;
  maxHealth: number;
  moveSpeed: number;
  dashCooldown: number;
  dashRemaining: number;
}

export interface RunState {
  wave: number;
  enemiesAlive: number;
  enemiesQueued: number;
  activeWeapon: WeaponId;
  loadout: WeaponId[];
  player: PlayerState;
}

export interface GameSettings {
  music: boolean;
  sfx: boolean;
  reducedMotion: boolean;
  controlMode: ControlMode;
  graphicsMode: GraphicsMode;
}

export interface ProfileV1 {
  version: 1;
  coins: number;
  ownedWeapons: WeaponId[];
  weaponRanks: Record<WeaponId, number>;
  perkRanks: Record<PerkId, number>;
  equippedLoadout: WeaponId[];
  settings: GameSettings;
  completedLevels: number[];
  highestWave: number;
  /** Furthest wave reached in a failed run; offered as a redeploy point. */
  checkpointWave: number;
  /** Deepest endless wave ever reached, for the lobby record. */
  bestEndlessWave: number;
}

export interface HudState {
  health: number;
  maxHealth: number;
  wave: number;
  /** True once the run has continued past the authored campaign. */
  endless?: boolean;
  /** Active wave modifier, when the wave rolled one. */
  modifier?: { name: string; icon: string };
  enemies: number;
  weapon: WeaponId;
  weaponName: string;
  magazine: number;
  reserve: number;
  reloading: number;
  reloadProgress?: number;
  /** True while the active-reload sweet spot is open and unattempted. */
  activeReloadAvailable?: boolean;
  /** Number of overcharged rounds remaining in the active weapon's magazine. */
  overchargedRounds?: number;
  dash: number;
  /** Frag grenade readiness from 0 (cooling) to 1 (ready). */
  grenade?: number;
  /** Cyber-Blade slash readiness from 0 to 1. */
  blade?: number;
  /** True when an enemy in teleport-execute range can be chain-executed right now. */
  executeTargetReady?: boolean;
  /** Live mid-wave Tech Energy (0..100) used to drop Auto-Turrets & Tesla Pylons. */
  techEnergy?: number;
  /** Active deployable counts. */
  turretCount?: number;
  pylonCount?: number;
  /** Active Orbital Super-Weapon override, when picked up from a Drop Pod. */
  superWeapon?: { id: SuperWeaponId; name: string; ammo: number; maxAmmo: number } | null;
  /** Overdrive meter charge from 0 to 100. */
  overdriveCharge?: number;
  /** True while Deadwave Overdrive Surge is currently active. */
  overdriveActive?: boolean;
  /** Remaining fraction (0..1) of active Overdrive duration. */
  overdriveProgress?: number;
  /** Live salvage multiplier earned from the current combo streak. */
  comboMultiplier?: number;
  /** Active evolved synergy fusions unlocked from card pairs. */
  activeFusions?: SynergyFusionId[];
  bossHealth?: number;
  bossMaxHealth?: number;
  bossPhase?: number;
  bossMaxPhases?: number;
  bossName?: string;
  bossSpecialAlert?: string;
  announcement?: string;
  comboCount?: number;
  comboTimer?: number;
  extractionZoneActive?: boolean;
  extractionProgress?: number;
  missionTime?: number;
  playerPos?: { x: number; z: number; rotation: number };
  minimapEnemies?: Array<{ x: number; z: number; type: EnemyId }>;
  activeSynergies?: Partial<Record<SynergyCardId, number>>;
}
