import type { WeaponInstance } from "./types";

/** Presentation only: the simulation owns reload duration and ammunition transfer. */
export function normalizedReloadProgress(weapon?: Pick<WeaponInstance, "reloading" | "reloadDuration">): number {
  if (!weapon || weapon.reloading <= 0 || !weapon.reloadDuration) return 0;
  return Math.max(0.001, Math.min(1, 1 - weapon.reloading / weapon.reloadDuration));
}

/** One compact number per target per short burst; never queues an unbounded horde. */
export class DamageFeedback<T> {
  private entries = new Map<T, { damage: number; critical: boolean; age: number }>();
  add(target: T, damage: number, critical = false) {
    const entry = this.entries.get(target);
    if (entry) { entry.damage += damage; entry.critical ||= critical; }
    else {
      if (this.entries.size >= 48) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(target, { damage, critical, age: 0 });
    }
  }
  update(dt: number, emit: (target: T, damage: number, critical: boolean) => void) {
    for (const [target, entry] of this.entries) {
      entry.age += dt;
      if (entry.age >= 0.12) {
        emit(target, Math.round(entry.damage), entry.critical); this.entries.delete(target);
      }
    }
  }
  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}
