import { describe, expect, it } from "vitest";
import { getWeaponStats, WAVES } from "../game/config";
import { purchaseWeapon, upgradePerk, upgradeWeapon } from "../game/economy";
import { createDefaultProfile, loadProfile, PROFILE_KEY, saveProfile, validateProfile } from "../game/profile";
import { validateVisualRegistry } from "../game/visual-registry";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("profile persistence", () => {
  it("creates a safe new profile with the pistol equipped", () => {
    const profile = createDefaultProfile();
    expect(profile.version).toBe(1);
    expect(profile.coins).toBe(0);
    expect(profile.ownedWeapons).toEqual(["pistol"]);
    expect(profile.equippedLoadout).toEqual(["pistol"]);
    expect(profile.settings.graphicsQuality).toBe("medium");
  });

  it("defaults legacy profiles to medium graphics without losing progress", () => {
    const profile = validateProfile({ coins: 410, highestWave: 7, settings: { music: false } });
    expect(profile).toMatchObject({ coins: 410, highestWave: 7, settings: { music: false, graphicsQuality: "medium" } });
  });

  it("clamps invalid ranks and restores the starter weapon", () => {
    const profile = validateProfile({
      coins: -100,
      ownedWeapons: ["rifle", "invalid"],
      equippedLoadout: ["invalid"],
      weaponRanks: { pistol: 99, rifle: -2 },
      perkRanks: { vitality: 50 },
      highestWave: 42,
    });
    expect(profile.coins).toBe(0);
    expect(profile.ownedWeapons).toContain("pistol");
    expect(profile.weaponRanks.pistol).toBe(5);
    expect(profile.perkRanks.vitality).toBe(3);
    expect(profile.highestWave).toBe(10);
  });

  it("backs up corrupt data and starts clean", () => {
    const storage = new MemoryStorage();
    storage.setItem(PROFILE_KEY, "{not-json");
    const profile = loadProfile(storage);
    expect(profile.ownedWeapons).toEqual(["pistol"]);
    expect([...Array(storage.length).keys()].map((index) => storage.key(index))).toContainEqual(expect.stringContaining(".corrupt."));
  });

  it("round-trips saved progress", () => {
    const storage = new MemoryStorage();
    const profile = { ...createDefaultProfile(), coins: 325, highestWave: 6 };
    saveProfile(storage, profile);
    expect(loadProfile(storage)).toMatchObject({ coins: 325, highestWave: 6 });
  });
});

describe("visual registry", () => {
  it("covers every gameplay visual category", () => {
    expect(validateVisualRegistry()).toEqual({ characters: true, weapons: true, pickups: true, qualities: true });
  });
});

describe("economy and upgrades", () => {
  it("rejects a weapon purchase without enough salvage", () => {
    const profile = createDefaultProfile();
    const original = structuredClone(profile);
    expect(purchaseWeapon(profile, "smg")).toMatchObject({ ok: false, reason: "insufficient" });
    expect(profile).toEqual(original);
  });

  it("persists a third weapon by replacing loadout slot two", () => {
    const first = purchaseWeapon({ ...createDefaultProfile(), coins: 1_180 }, "smg");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const result = purchaseWeapon(first.profile, "shotgun");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.coins).toBe(720);
      expect(result.profile.ownedWeapons).toEqual(["pistol", "smg", "shotgun"]);
      expect(result.profile.equippedLoadout).toEqual(["pistol", "shotgun"]);
    }
  });

  it("rejects upgrades for unowned weapons without mutating the profile", () => {
    const profile = { ...createDefaultProfile(), coins: 1_000 };
    const original = structuredClone(profile);
    expect(upgradeWeapon(profile, "rifle")).toMatchObject({ ok: false, reason: "unowned" });
    expect(profile).toEqual(original);
  });

  it("persists purchased weapons and spends the exact price", () => {
    const result = purchaseWeapon({ ...createDefaultProfile(), coins: 200 }, "smg");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.coins).toBe(20);
      expect(result.profile.ownedWeapons).toContain("smg");
      expect(result.profile.equippedLoadout).toContain("smg");
    }
  });

  it("caps weapons at rank five and perks at rank three", () => {
    let profile = { ...createDefaultProfile(), coins: 100_000 };
    for (let index = 0; index < 4; index += 1) {
      const result = upgradeWeapon(profile, "pistol");
      expect(result.ok).toBe(true);
      if (result.ok) profile = result.profile;
    }
    expect(profile.weaponRanks.pistol).toBe(5);
    expect(upgradeWeapon(profile, "pistol")).toMatchObject({ ok: false, reason: "max-rank" });

    for (let index = 0; index < 3; index += 1) {
      const result = upgradePerk(profile, "vitality");
      expect(result.ok).toBe(true);
      if (result.ok) profile = result.profile;
    }
    expect(profile.perkRanks.vitality).toBe(3);
    expect(upgradePerk(profile, "vitality")).toMatchObject({ ok: false, reason: "max-rank" });
  });

  it("improves damage, capacity, fire rate, and reload time by rank", () => {
    const base = getWeaponStats("rifle", 1);
    const max = getWeaponStats("rifle", 5);
    expect(max.damage).toBeGreaterThan(base.damage);
    expect(max.magazine).toBeGreaterThan(base.magazine);
    expect(max.fireRate).toBeGreaterThan(base.fireRate);
    expect(max.reload).toBeLessThan(base.reload);
  });
});

describe("wave progression", () => {
  it("defines ten sequential waves and introduces the boss only at wave ten", () => {
    expect(WAVES).toHaveLength(10);
    expect(WAVES.map((wave) => wave.wave)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(WAVES.slice(0, 9).every((wave) => !wave.enemies.juggernaut)).toBe(true);
    expect(WAVES[9].enemies.juggernaut).toBe(1);
  });
});
