import type { SuperWeaponDefinition, SuperWeaponId } from "./types";

/**
 * Core rules for the Deadwave Action-Siege overhaul:
 *   1. Cyber-Blade Slash & Teleport-Execution Chains (Right-Click / V)
 *   2. Deployable Orbital Auto-Turrets (T) & Linked Tesla Laser-Fence Pylons (C)
 *   3. Orbital Supply Drop Pods awarding heavy limited-ammo Super-Weapons
 */

export const TECH_ENERGY_MAX = 100;
export const TECH_ENERGY_START = 75;
export const TECH_ENERGY_REGEN_PER_SEC = 3.2;
export const TECH_ENERGY_KILL_GAIN = 14;
export const TECH_ENERGY_EXECUTE_GAIN = 22;

export const TURRET_COST = 40;
export const TURRET_MAX_ACTIVE = 3;
export const TURRET_HEALTH = 140;
export const TURRET_RANGE = 13.5;
export const TURRET_FIRE_INTERVAL = 0.24;
export const TURRET_DAMAGE = 22;

export const PYLON_COST = 45;
export const PYLON_MAX_ACTIVE = 4;
export const PYLON_HEALTH = 160;
export const PYLON_PULSE_RADIUS = 5.5;
export const PYLON_PULSE_INTERVAL = 1.5;
export const PYLON_PULSE_DAMAGE = 38;
export const PYLON_FENCE_MAX_DIST = 11.5;
export const PYLON_FENCE_DPS = 95;

export const BLADE_COOLDOWN = 0.72;
export const BLADE_SLASH_RANGE = 3.6;
export const BLADE_SLASH_DAMAGE = 58;
export const BLADE_EXECUTE_RANGE = 8.2;
export const BLADE_EXECUTE_HP_RATIO = 0.48;
export const BLADE_EXECUTE_HEAL = 10;
export const BLADE_DEFLECT_RADIUS = 3.8;

export const ORBITAL_POD_FIRST_DELAY = 7.5;
export const ORBITAL_POD_INTERVAL = 16.0;
export const ORBITAL_POD_FALL_TIME = 1.45;
export const ORBITAL_POD_IMPACT_RADIUS = 4.2;

export const SUPER_WEAPONS: Record<SuperWeaponId, SuperWeaponDefinition> = {
  railcannon: {
    id: "railcannon",
    name: "ARC RAILCANNON",
    tagline: "Screen-splitting hyper-velocity piercing beam",
    ammo: 8,
    damage: 210,
    fireRate: 1.5,
    color: 0x35f6ff,
  },
  minigun: {
    id: "minigun",
    name: "HELLFIRE MINIGUN",
    tagline: "Rotary storm of explosive incendiary shells",
    ammo: 75,
    damage: 26,
    fireRate: 18,
    color: 0xff6e24,
  },
  sawblade: {
    id: "sawblade",
    name: "RIPPER SAWBLADE",
    tagline: "Giant ricocheting plasma blades that shred hordes",
    ammo: 14,
    damage: 115,
    fireRate: 2.6,
    color: 0xffe44d,
  },
};

export const SUPER_WEAPON_IDS = Object.keys(SUPER_WEAPONS) as SuperWeaponId[];

/** Whether an enemy is wounded enough to trigger a Cyber-Blade Teleport Execution. */
export function isEnemyExecutable(health: number, maxHealth: number, isBoss = false): boolean {
  if (health <= 0 || maxHealth <= 0) return false;
  const threshold = isBoss ? 0.14 : BLADE_EXECUTE_HP_RATIO;
  return health / maxHealth <= threshold;
}

/** Distance from a point (px, pz) to line segment AB in the X/Z plane (for Tesla Laser Fences). */
export function pointToSegmentDistanceSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-6) {
    const dx = px - ax;
    const dz = pz - az;
    return dx * dx + dz * dz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

export function pickRandomSuperWeapon(random: () => number = Math.random): SuperWeaponDefinition {
  const index = Math.min(SUPER_WEAPON_IDS.length - 1, Math.floor(random() * SUPER_WEAPON_IDS.length));
  return SUPER_WEAPONS[SUPER_WEAPON_IDS[index]];
}
