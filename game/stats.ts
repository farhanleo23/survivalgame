/**
 * Per-run tallies shown on the death and victory screens.
 *
 * Kept as plain data so the engine can hand a snapshot across a redeploy: the
 * engine is rebuilt when the player spends a redeploy, and without carrying
 * these over the summary would only ever describe the last life.
 */
export interface RunStats {
  kills: number;
  eliteKills: number;
  bossKills: number;
  /** Pellets count individually, so a shotgun blast is six shots. */
  shotsFired: number;
  /** Direct bullet impacts. A piercing round that hits two enemies counts twice. */
  shotsHit: number;
  damageDealt: number;
  damageTaken: number;
  peakCombo: number;
  wavesCleared: number;
  /** Seconds of simulation time, not wall-clock. */
  missionTime: number;
}

export function createRunStats(): RunStats {
  return {
    kills: 0,
    eliteKills: 0,
    bossKills: 0,
    shotsFired: 0,
    shotsHit: 0,
    damageDealt: 0,
    damageTaken: 0,
    peakCombo: 0,
    wavesCleared: 0,
    missionTime: 0,
  };
}

/**
 * Hit rate from 0 to 1. Clamped, because piercing rounds can land on more
 * enemies than there were shots and "130% accuracy" reads as a bug.
 */
export function getAccuracy(stats: Pick<RunStats, "shotsFired" | "shotsHit">): number {
  if (stats.shotsFired <= 0) return 0;
  return Math.max(0, Math.min(1, stats.shotsHit / stats.shotsFired));
}

/** mm:ss, floored, never negative. Caps at 99:59 rather than growing a digit. */
export function formatMissionTime(seconds: number): string {
  const total = Math.min(99 * 60 + 59, Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0)));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
