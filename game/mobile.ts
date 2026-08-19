import type { ControlMode, InputMode } from "./types";

export interface JoystickVector {
  x: number;
  z: number;
  knobX: number;
  knobY: number;
}

export function resolveInputMode(preference: ControlMode, touchPrimary: boolean): InputMode {
  if (preference === "auto") return touchPrimary ? "touch" : "keyboard";
  return preference;
}

export function normalizeJoystick(
  offsetX: number,
  offsetY: number,
  radius: number,
  deadZone = 0.12,
): JoystickVector {
  if (!Number.isFinite(radius) || radius <= 0) return { x: 0, z: 0, knobX: 0, knobY: 0 };
  const distance = Math.hypot(offsetX, offsetY);
  if (distance === 0 || distance / radius <= deadZone) return { x: 0, z: 0, knobX: 0, knobY: 0 };

  const clampedDistance = Math.min(distance, radius);
  const directionX = offsetX / distance;
  const directionY = offsetY / distance;
  const scaledMagnitude = Math.min(1, (clampedDistance / radius - deadZone) / (1 - deadZone));

  return {
    x: directionX * scaledMagnitude,
    z: directionY * scaledMagnitude,
    knobX: directionX * clampedDistance,
    knobY: directionY * clampedDistance,
  };
}

/** Keep the current target unless the challenger is at least 30% closer. */
export function shouldReplaceTouchTarget(currentDistanceSquared: number, candidateDistanceSquared: number) {
  return candidateDistanceSquared < currentDistanceSquared * 0.49;
}

/**
 * Choose the enemy auto-aim locks onto.
 *
 * Stickiness exists so the reticle does not flicker between two enemies at
 * comparable range — it protects a lock you already hold. A fresh acquisition
 * has nothing to protect and simply takes the nearest candidate; running the
 * 30% threshold against an arbitrary seed instead is what let the reticle open
 * on something across the arena while a runner was already on top of you.
 */
export function selectTouchAimTarget<T>(
  candidates: readonly T[],
  distanceSquared: (candidate: T) => number,
  current: T | null,
): T | null {
  if (candidates.length === 0) return null;
  const holding = current !== null && candidates.includes(current);
  let best = holding ? (current as T) : candidates[0];
  let bestDistance = distanceSquared(best);
  for (const candidate of candidates) {
    if (candidate === best) continue;
    const distance = distanceSquared(candidate);
    const replaces = holding
      ? shouldReplaceTouchTarget(bestDistance, distance)
      : distance < bestDistance;
    if (replaces) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Safe haptic feedback trigger for mobile devices supporting vibration */
export function triggerHaptic(pattern: number | number[] = 12) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Ignore environments where vibrate is restricted or blocked
  }
}

