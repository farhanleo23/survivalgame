import type { SynergyCardId, SynergyFusionDefinition, SynergyFusionId } from "./types";

/**
 * Kinetic combat rules: Overdrive Surge, Active Tactical Reload, Perfect Dodge,
 * Combo Salvage Multiplier, and Evolved Synergy Fusions.
 *
 * Kept pure and data-driven so every mechanic is transparent, tunable, and
 * directly unit-testable without a WebGL context.
 */

export const OVERDRIVE_MAX_CHARGE = 100;
export const OVERDRIVE_BASE_DURATION = 6.0;
export const OVERDRIVE_KILL_EXTENSION = 0.35;
export const OVERDRIVE_MAX_EXTENSION = 3.0;
export const OVERDRIVE_FIRE_RATE_MULT = 1.45;
export const OVERDRIVE_SPEED_MULT = 1.28;
export const OVERDRIVE_DASH_COOLDOWN_MULT = 0.5;
export const OVERDRIVE_SHOCKWAVE_RADIUS = 5.6;

export const ACTIVE_RELOAD_WINDOW_START = 0.48;
export const ACTIVE_RELOAD_WINDOW_END = 0.72;
export const ACTIVE_RELOAD_JAM_PENALTY = 0.25;
export const OVERCHARGE_DAMAGE_MULT = 1.35;
export const OVERCHARGE_CRIT_BONUS = 0.15;

export const PERFECT_DODGE_DASH_REFUND = 0.5;
export const PERFECT_DODGE_OVERDRIVE_GAIN = 22;
export const PERFECT_DODGE_SLOWMO_DURATION = 0.28;
export const PERFECT_DODGE_SLOWMO_SCALE = 0.35;
export const PERFECT_DODGE_SHOT_BONUS = 1.5;

export const BARREL_CHAIN_RADIUS = 5.8;
export const BARREL_CHAIN_DELAY = 0.14;

export const SYNERGY_FUSIONS: Record<SynergyFusionId, SynergyFusionDefinition> = {
  superconductor: {
    id: "superconductor",
    name: "Superconductor",
    pair: ["cryo_frost", "tesla_arcs"],
    description: "Chain lightning arcs to 5 targets, chills every zapped foe, and deals +80% damage to chilled targets.",
  },
  napalm_wake: {
    id: "napalm_wake",
    name: "Napalm Wake",
    pair: ["incendiary", "acid_dash"],
    description: "Caustic dash trails ignite in blue-orange firestorms: +60% DPS and enemies catch fire to detonate on death.",
  },
  rail_bounce: {
    id: "rail_bounce",
    name: "Rail-Bounce",
    pair: ["piercing", "ricochet"],
    description: "Every ricochet amplifies bullet damage by +45% and refreshes piercing for devastating bank-shot lasers.",
  },
  blood_nova: {
    id: "blood_nova",
    name: "Blood Nova",
    pair: ["vampiric_leech", "kinetic_impact"],
    description: "Seismic Surge radius grows +35% and siphons +3 HP per enemy hit (up to +24 HP per blast).",
  },
};

export const SYNERGY_FUSION_IDS = Object.keys(SYNERGY_FUSIONS) as SynergyFusionId[];

/** Evaluate an active reload tap against the current normalized reload progress (0..1). */
export function evaluateActiveReload(progress: number): "perfect" | "miss" {
  if (progress >= ACTIVE_RELOAD_WINDOW_START && progress <= ACTIVE_RELOAD_WINDOW_END) {
    return "perfect";
  }
  return "miss";
}

/** Salvage reward multiplier earned from maintaining an active kill combo streak. */
export function getComboSalvageMultiplier(comboCount: number): number {
  if (comboCount >= 12) return 2.0;
  if (comboCount >= 8) return 1.75;
  if (comboCount >= 5) return 1.5;
  if (comboCount >= 3) return 1.25;
  return 1.0;
}

/** Return all Evolved Synergy Fusions currently unlocked by a synergy deck. */
export function getActiveFusions(
  synergies: Partial<Record<SynergyCardId, number>> | ReadonlyMap<SynergyCardId, number>,
): SynergyFusionId[] {
  const has = (id: SynergyCardId) =>
    synergies instanceof Map
      ? (synergies.get(id) ?? 0) > 0
      : ((synergies as Partial<Record<SynergyCardId, number>>)[id] ?? 0) > 0;
  return SYNERGY_FUSION_IDS.filter((fusionId) => {
    const [a, b] = SYNERGY_FUSIONS[fusionId].pair;
    return has(a) && has(b);
  });
}

/**
 * Check if picking `candidate` in the draft will immediately complete a Synergy Fusion
 * with a card the operator already owns.
 */
export function getFusionCompletedByCard(
  activeSynergies: Partial<Record<SynergyCardId, number>>,
  candidate: SynergyCardId,
): SynergyFusionDefinition | null {
  if ((activeSynergies[candidate] ?? 0) > 0) return null;
  for (const fusionId of SYNERGY_FUSION_IDS) {
    const fusion = SYNERGY_FUSIONS[fusionId];
    const [a, b] = fusion.pair;
    if (a === candidate && (activeSynergies[b] ?? 0) > 0) return fusion;
    if (b === candidate && (activeSynergies[a] ?? 0) > 0) return fusion;
  }
  return null;
}

/** Compute rotated AABB half-extents for a box of given width/depth and yaw rotation. */
export function rotatedBoxHalfExtents(width: number, depth: number, rotation: number): { hx: number; hz: number } {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  return {
    hx: (cos * width + sin * depth) / 2,
    hz: (sin * width + cos * depth) / 2,
  };
}
