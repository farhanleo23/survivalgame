import type {
  CardRarity,
  EnemyDefinition,
  EnemyId,
  PerkId,
  PickupDefinition,
  PickupId,
  SynergyCardDefinition,
  SynergyCardId,
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
  boomer: { id: "boomer", name: "Volatile Boomer", health: 85, speed: 1.85, damage: 30, attackRange: 1.8, attackCooldown: 1.0, reward: 32, radius: 0.82, color: 0x48c774 },
  juggernaut: { id: "juggernaut", name: "Titan Juggernaut", health: 1450, speed: 1.3, damage: 32, attackRange: 2.1, attackCooldown: 1.5, reward: 300, radius: 1.55, color: 0xd94b38 },
};

export const PICKUPS: Record<PickupId, PickupDefinition> = {
  coin: { id: "coin", label: "Salvage", color: 0xffd34d },
  ammo: { id: "ammo", label: "Ammunition", color: 0x62c8ff },
  health: { id: "health", label: "Trauma kit", color: 0xff5f66 },
};

export const SYNERGY_CARDS: Record<SynergyCardId, SynergyCardDefinition> = {
  piercing: {
    id: "piercing",
    name: "AP Tungsten Rounds",
    rarity: "common",
    description: "Bullets punch through targets (+1 enemy pierce per stack).",
    flavorText: "Laser-straight lines through packed hordes.",
    icon: "🏹",
    maxStacks: 3,
  },
  ricochet: {
    id: "ricochet",
    name: "Kinetic Deflector",
    rarity: "rare",
    description: "Bullets ricochet off obstacles towards nearby enemies (+1 bounce per stack).",
    flavorText: "Turn depot barricades into bank-shot death traps.",
    icon: "⚡",
    maxStacks: 2,
  },
  shrapnel: {
    id: "shrapnel",
    name: "Hollow-Point Shrapnel",
    rarity: "rare",
    description: "Critical hits shatter targets, spraying 4 needle shards into surrounding foes.",
    flavorText: "Micro-explosive core fracturing upon high-velocity impact.",
    icon: "💥",
    maxStacks: 2,
  },
  high_caliber: {
    id: "high_caliber",
    name: "Magnum Overpressure",
    rarity: "common",
    description: "+25% bullet damage, +20% size, and heavy concussive knockback.",
    flavorText: "Packed with enough powder to flip a charging brute.",
    icon: "🎯",
    maxStacks: 3,
  },
  tesla_arcs: {
    id: "tesla_arcs",
    name: "Tesla Discharge",
    rarity: "epic",
    description: "Every 4th bullet or critical hit unleashes chain lightning zapping up to 3 enemies.",
    flavorText: "Capacitor coils wired straight to the firing pin.",
    icon: "⚡",
    maxStacks: 3,
  },
  incendiary: {
    id: "incendiary",
    name: "Dragon's Breath",
    rarity: "rare",
    description: "Bullets ignite enemies for 22 burn damage/sec per stack. Burning foes detonate on death.",
    flavorText: "White phosphorus paste engineered for bio-containment.",
    icon: "🔥",
    maxStacks: 2,
  },
  cryo_frost: {
    id: "cryo_frost",
    name: "Cryo Core",
    rarity: "common",
    description: "Bullets chill targets: -30% enemy speed per stack, +15% critical vulnerability.",
    flavorText: "Sub-zero flash-freezing halts charging runners in their tracks.",
    icon: "❄️",
    maxStacks: 2,
  },
  acid_dash: {
    id: "acid_dash",
    name: "Caustic Jet",
    rarity: "rare",
    description: "Dashing lays a caustic trail dealing 40 acid damage/sec per stack to pursuers.",
    flavorText: "Never evade without leaving a lethal wake.",
    icon: "🧪",
    maxStacks: 2,
  },
  kinetic_impact: {
    id: "kinetic_impact",
    name: "Seismic Surge",
    rarity: "epic",
    description: "Dash release detonates a 360° blast for 85 damage per stack, staggering the crowd.",
    flavorText: "Instantaneous pressure wave clears immediate personal space.",
    icon: "💫",
    maxStacks: 2,
  },
  phantom_reflex: {
    id: "phantom_reflex",
    name: "Phantom Reflex",
    rarity: "common",
    description: "Dash cooldown -18% per stack. Hitting an elite or boss refunds 0.7s more per stack.",
    flavorText: "Blink through hostile swarms without breaking your stride.",
    icon: "👟",
    maxStacks: 3,
  },
  vampiric_leech: {
    id: "vampiric_leech",
    name: "Vampiric Leech",
    rarity: "epic",
    description: "Critical hits and multi-kill combos siphon life, instantly restoring +4 HP.",
    flavorText: "Sub-dermal bio-siphons convert carnage into raw survival.",
    icon: "🩸",
    maxStacks: 2,
  },
  adrenaline_surge: {
    id: "adrenaline_surge",
    name: "Adrenaline Surge",
    rarity: "common",
    description: "Below 45% HP: +30% fire rate, +20% reload speed and +12% move speed, per stack.",
    flavorText: "Redline your vitals when cornered against the wall.",
    icon: "⚡",
    maxStacks: 2,
  },
};

export const SYNERGY_CARD_IDS = Object.keys(SYNERGY_CARDS) as SynergyCardId[];

export const WAVES: WaveDefinition[] = [
  { wave: 1, label: "First contact", enemies: { shambler: 6 }, spawnInterval: 0.82 },
  { wave: 2, label: "Perimeter breach", enemies: { shambler: 10 }, spawnInterval: 0.76 },
  { wave: 3, label: "They can run", enemies: { shambler: 8, runner: 4 }, spawnInterval: 0.7 },
  { wave: 4, label: "Hazardous exposure", enemies: { shambler: 7, runner: 4, spitter: 2, boomer: 2 }, spawnInterval: 0.66 },
  { wave: 5, label: "Prototype Titan Emerges", enemies: { shambler: 6, runner: 4, spitter: 2, boomer: 1, juggernaut: 1 }, spawnInterval: 0.68 },
  { wave: 6, label: "No clean exits", enemies: { shambler: 9, runner: 6, spitter: 3, brute: 1, boomer: 2 }, spawnInterval: 0.58 },
  { wave: 7, label: "The depot stirs", enemies: { shambler: 11, runner: 7, spitter: 3, brute: 2, boomer: 3 }, spawnInterval: 0.54 },
  { wave: 8, label: "Containment failed", enemies: { shambler: 13, runner: 8, spitter: 4, brute: 2, boomer: 4 }, spawnInterval: 0.5 },
  { wave: 9, label: "Last stand", enemies: { shambler: 14, runner: 9, spitter: 5, brute: 3, boomer: 4 }, spawnInterval: 0.46 },
  { wave: 10, label: "Titan Dreadnought Prime", enemies: { shambler: 8, runner: 6, spitter: 3, brute: 2, boomer: 2, juggernaut: 1 }, spawnInterval: 0.58 },
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

/** Relative draw weight per rarity. Higher means offered more often. */
export const RARITY_WEIGHT: Record<CardRarity, number> = {
  common: 10,
  rare: 5,
  epic: 2,
};

/**
 * Weighted draw without replacement.
 *
 * The previous implementation was `[...available].sort(() => Math.random() -
 * 0.5).slice(0, count)`, which has two faults. A random comparator is not a
 * uniform shuffle, so offer rates tracked a card's index in the array —
 * measured over 180,000 draws, the first card appeared 12.7% of the time
 * against 5.7% for the ninth. And despite the "weighted rarity" comment,
 * rarity was never consulted, so epics dropped as freely as commons.
 */
export function getRandomPerkDraft(
  activeCards: Partial<Record<SynergyCardId, number>>,
  count = 3,
): SynergyCardDefinition[] {
  const pool = SYNERGY_CARD_IDS.filter((id) => (activeCards[id] ?? 0) < SYNERGY_CARDS[id].maxStacks);
  const picked: SynergyCardDefinition[] = [];

  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, id) => sum + RARITY_WEIGHT[SYNERGY_CARDS[id].rarity], 0);
    let roll = Math.random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= RARITY_WEIGHT[SYNERGY_CARDS[pool[i]].rarity];
      if (roll <= 0) {
        index = i;
        break;
      }
    }
    const [id] = pool.splice(index, 1);
    picked.push(SYNERGY_CARDS[id]);
  }

  return picked;
}


/** How far the authored campaign runs before endless takes over. */
export const CAMPAIGN_WAVES = WAVES.length;

export interface WaveScaling {
  health: number;
  speed: number;
  damage: number;
  reward: number;
}

/**
 * Per-wave stat multipliers for the infected.
 *
 * Before this existed, enemy stats were completely flat: a wave-9 shambler was
 * identical to a wave-1 one, while the player gained weapon ranks, perks and a
 * stacking synergy deck. The curves crossed — brutal at the start, trivial by
 * the end. Scaling the enemies is what lets difficulty track the player, and
 * it is also what makes endless mode possible at all.
 *
 * Health climbs fastest because it is the stat the player's damage growth
 * directly outpaces. Speed is capped: past about 1.4x, runners outrun the
 * player's 6.2 move speed and kiting stops being a viable answer to anything.
 */
export function getWaveScaling(wave: number): WaveScaling {
  const step = Math.max(0, wave - 1);
  // Past the campaign the curve steepens, otherwise endless plateaus.
  const overtime = Math.max(0, wave - CAMPAIGN_WAVES);

  return {
    health: 1 + step * 0.15 + overtime * 0.08,
    speed: Math.min(1.4, 1 + step * 0.018),
    damage: Math.min(2.6, 1 + step * 0.055),
    reward: 1 + step * 0.09,
  };
}

/**
 * Wave composition for any wave number. Authored waves 1–10 are returned as
 * written; beyond that the mix is generated, leaning harder on the fast and
 * heavy archetypes and dropping a juggernaut every fifth wave.
 */
export function getWaveDefinition(wave: number): WaveDefinition {
  if (wave <= CAMPAIGN_WAVES) return WAVES[wave - 1];

  const over = wave - CAMPAIGN_WAVES;
  const scale = 1 + over * 0.12;
  const count = (base: number) => Math.max(1, Math.round(base * scale));

  const enemies: Partial<Record<EnemyId, number>> = {
    shambler: count(10),
    runner: count(8),
    spitter: count(4),
    brute: count(2),
    boomer: count(3),
  };
  // A titan every fifth endless wave keeps the rhythm from flattening out.
  if (over % 5 === 0) enemies.juggernaut = 1 + Math.floor(over / 15);

  return {
    wave,
    label: `Endless surge ${over}`,
    enemies,
    // Spawn pressure tightens but never outruns the active-enemy cap.
    spawnInterval: Math.max(0.24, 0.46 - over * 0.012),
  };
}

export interface EnemyBehaviour {
  /**
   * Seconds of wind-up before a melee hit lands. Damage used to apply the
   * instant an enemy entered range, with no animation to read — survivable
   * only because early enemies hit softly. Once damage scales past 2x that
   * becomes unreadable, so every melee attack now telegraphs.
   */
  windup: number;
  /**
   * How far around the player this archetype circles before closing, in
   * radians. Zero beelines. Without it every enemy converged on the same
   * point and the horde arrived as a single clump from one bearing.
   */
  flankSpread: number;
  /** Preferred engagement distance; ranged types back off below it. */
  standoff?: number;
}

export const BEHAVIOURS: Record<EnemyId, EnemyBehaviour> = {
  // Slow and stupid on purpose: the baseline the others are read against.
  shambler: { windup: 0.5, flankSpread: 0.35 },
  // Circles wide and comes in from the side — the archetype that punishes
  // standing still and tunnel-visioning on one direction.
  runner: { windup: 0.28, flankSpread: 1.15 },
  // Hangs back and kites; closing the gap has to be the player's job.
  spitter: { windup: 0.42, flankSpread: 0.8, standoff: 7.2 },
  // Heavy, slow tell. Telegraph is long enough to reliably dash out of.
  brute: { windup: 0.75, flankSpread: 0.15 },
  // Waddles straight in; the threat is the corpse, not the swing.
  boomer: { windup: 0.55, flankSpread: 0.25 },
  juggernaut: { windup: 0.7, flankSpread: 0 },
};

export type WaveModifierId = "elite_surge" | "swarm" | "blitz" | "toxic_bloom" | "iron_hide";

/**
 * Per-wave rule changes.
 *
 * Ten-plus waves in one arena against one enemy roster reads as repetitive no
 * matter how the numbers scale, because every wave is answered the same way.
 * A modifier changes the question rather than the difficulty: swarm punishes
 * single-target weapons, iron hide punishes chip damage, blitz removes the
 * time to reposition. Multipliers stack on top of getWaveScaling.
 */
export interface WaveModifier {
  id: WaveModifierId;
  name: string;
  blurb: string;
  icon: string;
  countMult: number;
  healthMult: number;
  speedMult: number;
  /** Overrides the default 22% elite roll when set. */
  eliteChance?: number;
  /** Seconds between arena hazard blooms, when set. */
  hazardInterval?: number;
}

export const WAVE_MODIFIERS: Record<WaveModifierId, WaveModifier> = {
  elite_surge: {
    id: "elite_surge",
    name: "Elite Surge",
    blurb: "Every hostile is an elite",
    icon: "🛡️",
    countMult: 0.7,
    healthMult: 1,
    speedMult: 1,
    eliteChance: 1,
  },
  swarm: {
    id: "swarm",
    name: "Swarm",
    blurb: "Twice the bodies, half the meat",
    icon: "🐝",
    countMult: 1.8,
    healthMult: 0.55,
    speedMult: 1.05,
  },
  blitz: {
    id: "blitz",
    name: "Blitz",
    blurb: "They are moving fast",
    icon: "⚡",
    countMult: 0.9,
    healthMult: 0.85,
    speedMult: 1.35,
  },
  toxic_bloom: {
    id: "toxic_bloom",
    name: "Toxic Bloom",
    blurb: "The floor is going bad",
    icon: "☣️",
    countMult: 0.85,
    healthMult: 1,
    speedMult: 1,
    hazardInterval: 2.6,
  },
  iron_hide: {
    id: "iron_hide",
    name: "Iron Hide",
    blurb: "Armoured and slow",
    icon: "🪨",
    countMult: 0.75,
    healthMult: 1.9,
    speedMult: 0.78,
  },
};

export const WAVE_MODIFIER_IDS = Object.keys(WAVE_MODIFIERS) as WaveModifierId[];

/**
 * Pick a modifier for a wave, or null for a plain one.
 *
 * Waves 1–2 stay clean so the run has a readable baseline, and boss waves stay
 * clean so the fight is not muddied by a second rule change. Endless leans on
 * them harder, since that is where repetition actually bites.
 */
export function rollWaveModifier(wave: number, random: () => number = Math.random): WaveModifier | null {
  if (wave < 3) return null;
  if (wave % 5 === 0) return null;

  const chance = wave > CAMPAIGN_WAVES ? 0.75 : 0.45;
  if (random() >= chance) return null;

  const index = Math.min(WAVE_MODIFIER_IDS.length - 1, Math.floor(random() * WAVE_MODIFIER_IDS.length));
  return WAVE_MODIFIERS[WAVE_MODIFIER_IDS[index]];
}

/** The player's base move speed, before the mobility perk. */
export const PLAYER_BASE_SPEED = 6.2;

/**
 * Hard ceiling on enemy speed.
 *
 * Wave scaling caps its own multiplier, but a modifier multiplies on top of it,
 * and the two stacked put a deep-endless Blitz runner at 7.9 against a 6.2
 * player — at which point nothing can be outrun and kiting, the core answer to
 * being surrounded, stops working. Every speed path funnels through here.
 */
export const MAX_ENEMY_SPEED = PLAYER_BASE_SPEED * 0.95;

export function getEnemySpeed(
  baseSpeed: number,
  wave: number,
  modifier?: WaveModifier | null,
): number {
  const scaled = baseSpeed * getWaveScaling(wave).speed * (modifier?.speedMult ?? 1);
  return Math.min(MAX_ENEMY_SPEED, scaled);
}
