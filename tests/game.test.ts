import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_WAVES,
  ENEMIES,
  getWaveDefinition,
  getWaveScaling,
  getRandomPerkDraft,
  getWeaponStats,
  SYNERGY_CARD_IDS,
  SYNERGY_CARDS,
  WAVES,
} from "../game/config";
import type { SynergyCardId } from "../game/types";
import { purchaseWeapon, upgradePerk, upgradeWeapon } from "../game/economy";
import { createDefaultProfile, loadProfile, PROFILE_KEY, saveProfile, validateProfile } from "../game/profile";

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
  it("defines ten sequential campaign waves", () => {
    expect(WAVES).toHaveLength(10);
    expect(WAVES.map((wave) => wave.wave)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("stages a juggernaut at the wave five midpoint and the wave ten finale", () => {
    // The mid-boss is deliberate: it has its own health value, a two-phase
    // fight against the finale's three, and a distinct nameplate. An earlier
    // version of this test asserted a single boss at wave ten and had been
    // failing ever since the midpoint fight was added.
    const bossWaves = WAVES.filter((wave) => wave.enemies.juggernaut).map((wave) => wave.wave);
    expect(bossWaves).toEqual([5, 10]);
    expect(WAVES[4].enemies.juggernaut).toBe(1);
    expect(WAVES[9].enemies.juggernaut).toBe(1);
  });
});

describe("wave scaling", () => {
  it("leaves wave one unscaled so authored stats are the baseline", () => {
    const scaling = getWaveScaling(1);
    expect(scaling.health).toBe(1);
    expect(scaling.speed).toBe(1);
    expect(scaling.damage).toBe(1);
    expect(scaling.reward).toBe(1);
  });

  it("increases every stat monotonically with wave depth", () => {
    for (let wave = 2; wave <= 40; wave += 1) {
      const previous = getWaveScaling(wave - 1);
      const current = getWaveScaling(wave);
      expect(current.health).toBeGreaterThan(previous.health);
      expect(current.speed).toBeGreaterThanOrEqual(previous.speed);
      expect(current.damage).toBeGreaterThanOrEqual(previous.damage);
      expect(current.reward).toBeGreaterThan(previous.reward);
    }
  });

  it("caps speed below the player's move speed so kiting stays viable", () => {
    // Runners are the fastest archetype at 4.2 against a 6.2 player.
    const fastest = ENEMIES.runner.speed * getWaveScaling(500).speed;
    expect(fastest).toBeLessThan(6.2);
  });

  it("caps damage so a single late-wave hit is never instantly lethal", () => {
    const worst = ENEMIES.juggernaut.damage * getWaveScaling(500).damage;
    expect(worst).toBeLessThan(100);
  });

  it("steepens the health curve once the campaign is over", () => {
    const campaignStep = getWaveScaling(10).health - getWaveScaling(9).health;
    const endlessStep = getWaveScaling(16).health - getWaveScaling(15).health;
    expect(endlessStep).toBeGreaterThan(campaignStep);
  });
});

describe("endless wave generation", () => {
  it("returns the authored definitions across the campaign", () => {
    for (let wave = 1; wave <= CAMPAIGN_WAVES; wave += 1) {
      expect(getWaveDefinition(wave)).toBe(WAVES[wave - 1]);
    }
  });

  it("generates populated waves past the campaign", () => {
    for (const wave of [11, 17, 26, 60]) {
      const definition = getWaveDefinition(wave);
      expect(definition.wave).toBe(wave);
      const total = Object.values(definition.enemies).reduce((sum, n) => sum + (n ?? 0), 0);
      expect(total).toBeGreaterThan(0);
      expect(definition.spawnInterval).toBeGreaterThan(0);
    }
  });

  it("never lets spawn interval collapse to zero", () => {
    expect(getWaveDefinition(500).spawnInterval).toBeGreaterThanOrEqual(0.24);
  });

  it("drops a juggernaut every fifth endless wave", () => {
    expect(getWaveDefinition(15).enemies.juggernaut).toBeGreaterThan(0);
    expect(getWaveDefinition(16).enemies.juggernaut).toBeUndefined();
  });
});

describe("synergy draft", () => {
  const sample = (draws: number) => {
    const counts = new Map<SynergyCardId, number>();
    for (let i = 0; i < draws; i += 1) {
      for (const card of getRandomPerkDraft({}, 3)) {
        counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
      }
    }
    return counts;
  };

  it("offers three distinct cards", () => {
    for (let i = 0; i < 200; i += 1) {
      const draft = getRandomPerkDraft({}, 3);
      expect(draft).toHaveLength(3);
      expect(new Set(draft.map((c) => c.id)).size).toBe(3);
    }
  });

  it("never offers a card already at max stacks", () => {
    const maxed = Object.fromEntries(
      SYNERGY_CARD_IDS.map((id) => [id, SYNERGY_CARDS[id].maxStacks]),
    ) as Partial<Record<SynergyCardId, number>>;
    expect(getRandomPerkDraft(maxed, 3)).toHaveLength(0);

    const allButOne = { ...maxed, piercing: 0 };
    const draft = getRandomPerkDraft(allButOne, 3);
    expect(draft.map((c) => c.id)).toEqual(["piercing"]);
  });

  it("offers commons more often than epics", () => {
    const counts = sample(20_000);
    const rate = (id: SynergyCardId) => (counts.get(id) ?? 0) / 60_000;
    // piercing is common, tesla_arcs is epic.
    expect(rate("piercing")).toBeGreaterThan(rate("tesla_arcs") * 1.5);
  });

  it("does not favour cards by their position in the table", () => {
    // The old sort-based shuffle offered the first card ~2.2x as often as the
    // ninth purely because of array order. Compare same-rarity cards from
    // opposite ends of the table: they should now land within noise.
    const counts = sample(20_000);
    const first = counts.get("piercing") ?? 0;        // index 0, common
    const last = counts.get("adrenaline_surge") ?? 0; // index 11, common
    const ratio = first / Math.max(1, last);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });
});

describe("card definitions", () => {
  it("keeps every card's stack count meaningful", () => {
    for (const id of SYNERGY_CARD_IDS) {
      const card = SYNERGY_CARDS[id];
      expect(card.maxStacks).toBeGreaterThanOrEqual(1);
      expect(card.description.length).toBeGreaterThan(10);
    }
  });
});
