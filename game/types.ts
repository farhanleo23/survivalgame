export type GameScreen =
  | "lobby"
  | "loadout"
  | "playing"
  | "paused"
  | "armory"
  | "dead"
  | "victory";

export type WeaponId = "pistol" | "smg" | "shotgun" | "rifle";
export type EnemyId = "shambler" | "runner" | "spitter" | "brute" | "juggernaut";
export type PickupId = "coin" | "ammo" | "health";
export type PerkId = "vitality" | "mobility" | "magnet";

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
}

export interface HudState {
  health: number;
  maxHealth: number;
  wave: number;
  enemies: number;
  weapon: WeaponId;
  weaponName: string;
  magazine: number;
  reserve: number;
  reloading: number;
  dash: number;
  bossHealth?: number;
  bossMaxHealth?: number;
  announcement?: string;
}
