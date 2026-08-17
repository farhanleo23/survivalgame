import type {
  EnemyDefinition,
  EnemyId,
  PerkId,
  PickupDefinition,
  PickupId,
  WaveDefinition,
  WeaponDefinition,
  WeaponId,
} from "./types";

export const WEAPONS: Record<WeaponId, WeaponDefinition> = {
  pistol: {
    id: "pistol", name: "Service Pistol", description: "Reliable and accurate. Your last line of defense.",
    cost: 0, damage: 24, fireRate: 3.2, magazine: 12, reserve: 72, reload: 1.1,
    spread: 0.018, pellets: 1, color: 0xb8ff5a,
  },
  smg: {
    id: "smg", name: "Viper SMG", description: "Close-range crowd control with a vicious fire rate.",
    cost: 180, damage: 13, fireRate: 10, magazine: 28, reserve: 140, reload: 1.45,
    spread: 0.055, pellets: 1, color: 0x61f2aa,
  },
  shotgun: {
    id: "shotgun", name: "Breach Shotgun", description: "Six pellets of immediate personal space.",
    cost: 280, damage: 12, fireRate: 1.15, magazine: 6, reserve: 42, reload: 1.8,
    spread: 0.17, pellets: 6, color: 0xffc35a,
  },
  rifle: {
    id: "rifle", name: "Sentinel Rifle", description: "High-velocity rounds for distant priority targets.",
    cost: 450, damage: 31, fireRate: 5.2, magazine: 24, reserve: 120, reload: 1.65,
    spread: 0.024, pellets: 1, color: 0x7fc7ff,
  },
};

export const ENEMIES: Record<EnemyId, EnemyDefinition> = {
  shambler: { id: "shambler", name: "Shambler", health: 55, speed: 2.25, damage: 9, attackRange: 1.25, attackCooldown: 0.9, reward: 12, radius: 0.55, color: 0x6e9a5e },
  runner: { id: "runner", name: "Runner", health: 38, speed: 4.2, damage: 7, attackRange: 1.1, attackCooldown: 0.65, reward: 15, radius: 0.46, color: 0xd7a66c },
  spitter: { id: "spitter", name: "Spitter", health: 70, speed: 1.65, damage: 12, attackRange: 9, attackCooldown: 2.4, reward: 22, radius: 0.58, color: 0x8bef67 },
  brute: { id: "brute", name: "Brute", health: 230, speed: 1.35, damage: 20, attackRange: 1.5, attackCooldown: 1.4, reward: 38, radius: 0.9, color: 0x995b4a },
  juggernaut: { id: "juggernaut", name: "Juggernaut", health: 1300, speed: 1.25, damage: 28, attackRange: 2.05, attackCooldown: 1.5, reward: 250, radius: 1.45, color: 0xd94b38 },
};

export const PICKUPS: Record<PickupId, PickupDefinition> = {
  coin: { id: "coin", label: "Salvage", color: 0xffd34d },
  ammo: { id: "ammo", label: "Ammunition", color: 0x62c8ff },
  health: { id: "health", label: "Trauma kit", color: 0xff5f66 },
};

export const WAVES: WaveDefinition[] = [
  { wave: 1, label: "First contact", enemies: { shambler: 6 }, spawnInterval: 0.82 },
  { wave: 2, label: "Perimeter breach", enemies: { shambler: 10 }, spawnInterval: 0.76 },
  { wave: 3, label: "They can run", enemies: { shambler: 8, runner: 4 }, spawnInterval: 0.7 },
  { wave: 4, label: "Hazardous exposure", enemies: { shambler: 8, runner: 5, spitter: 2 }, spawnInterval: 0.66 },
  { wave: 5, label: "Heavy footsteps", enemies: { shambler: 10, runner: 5, spitter: 2, brute: 1 }, spawnInterval: 0.62 },
  { wave: 6, label: "No clean exits", enemies: { shambler: 12, runner: 7, spitter: 3, brute: 2 }, spawnInterval: 0.58 },
  { wave: 7, label: "The depot stirs", enemies: { shambler: 14, runner: 8, spitter: 4, brute: 2 }, spawnInterval: 0.54 },
  { wave: 8, label: "Containment failed", enemies: { shambler: 15, runner: 10, spitter: 5, brute: 3 }, spawnInterval: 0.5 },
  { wave: 9, label: "Last stand", enemies: { shambler: 17, runner: 12, spitter: 6, brute: 4 }, spawnInterval: 0.46 },
  { wave: 10, label: "Juggernaut", enemies: { shambler: 8, runner: 5, spitter: 3, brute: 2, juggernaut: 1 }, spawnInterval: 0.58 },
];

export const PERKS: Record<PerkId, { name: string; description: string; baseCost: number }> = {
  vitality: { name: "Vitality", description: "+20 maximum health per rank", baseCost: 125 },
  mobility: { name: "Mobility", description: "+6% movement speed per rank", baseCost: 140 },
  magnet: { name: "Salvage Magnet", description: "+1.3m pickup radius per rank", baseCost: 100 },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
export const PERK_IDS = Object.keys(PERKS) as PerkId[];

export function getWeaponStats(id: WeaponId, rank: number) {
  const weapon = WEAPONS[id];
  const level = Math.max(1, Math.min(5, rank));
  const bonus = level - 1;
  return {
    ...weapon,
    damage: weapon.damage * (1 + bonus * 0.18),
    magazine: weapon.magazine + bonus * Math.max(1, Math.round(weapon.magazine * 0.09)),
    reload: Math.max(0.55, weapon.reload * (1 - bonus * 0.055)),
    fireRate: weapon.fireRate * (1 + bonus * 0.045),
  };
}

export function getWeaponUpgradeCost(id: WeaponId, currentRank: number) {
  const multiplier = id === "pistol" ? 1 : WEAPONS[id].cost / 180 + 0.35;
  return Math.round((80 + currentRank * 55) * multiplier / 5) * 5;
}

export function getPerkUpgradeCost(id: PerkId, currentRank: number) {
  return PERKS[id].baseCost + currentRank * 85;
}
