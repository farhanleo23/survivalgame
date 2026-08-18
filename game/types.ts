export type GameScreen =
  | "lobby"
  | "loadout"
  | "playing"
  | "paused"
  | "armory"
  | "draft"
  | "dead"
  | "victory";

export type WeaponId = "pistol" | "smg" | "shotgun" | "rifle";
export type EnemyId = "shambler" | "runner" | "spitter" | "brute" | "juggernaut" | "boomer";
export type PickupId = "coin" | "ammo" | "health";
export type PerkId = "vitality" | "mobility" | "magnet";

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
  dash: number;
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


