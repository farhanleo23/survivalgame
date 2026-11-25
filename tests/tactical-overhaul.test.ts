import { describe, expect, it } from "vitest";
import {
  isEnemyExecutable,
  pickRandomSuperWeapon,
  pointToSegmentDistanceSq,
  SUPER_WEAPON_IDS,
  SUPER_WEAPONS,
} from "../game/tactical-overhaul";

describe("cyber-blade execution threshold", () => {
  it("marks regular enemies executable below 48% HP and bosses only below 14% HP", () => {
    expect(isEnemyExecutable(100, 100, false)).toBe(false);
    expect(isEnemyExecutable(48, 100, false)).toBe(true);
    expect(isEnemyExecutable(0, 100, false)).toBe(false);
    expect(isEnemyExecutable(40, 100, true)).toBe(false);
    expect(isEnemyExecutable(14, 100, true)).toBe(true);
  });
});

describe("tesla laser fence geometry", () => {
  it("computes exact perpendicular distance from an enemy to the fence segment", () => {
    // Fence along X from (0, 0) to (10, 0)
    expect(pointToSegmentDistanceSq(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    expect(pointToSegmentDistanceSq(5, 2, 0, 0, 10, 0)).toBeCloseTo(4);
    expect(pointToSegmentDistanceSq(-3, 4, 0, 0, 10, 0)).toBeCloseTo(25);
    expect(pointToSegmentDistanceSq(13, 4, 0, 0, 10, 0)).toBeCloseTo(25);
  });
});

describe("orbital super-weapons", () => {
  it("defines distinct high-impact orbital weapons and samples across the table", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SUPER_WEAPON_IDS.length; i += 1) {
      const pick = pickRandomSuperWeapon(() => i / SUPER_WEAPON_IDS.length);
      seen.add(pick.id);
      expect(SUPER_WEAPONS[pick.id].ammo).toBeGreaterThan(0);
      expect(SUPER_WEAPONS[pick.id].damage).toBeGreaterThan(0);
    }
    expect(seen.size).toBe(SUPER_WEAPON_IDS.length);
  });
});
