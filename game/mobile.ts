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

