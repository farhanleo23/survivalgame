import { describe, expect, it } from "vitest";
import {
  ACTIVE_RELOAD_WINDOW_END,
  ACTIVE_RELOAD_WINDOW_START,
  evaluateActiveReload,
  getActiveFusions,
  getComboSalvageMultiplier,
  getFusionCompletedByCard,
  rotatedBoxHalfExtents,
  SYNERGY_FUSION_IDS,
  SYNERGY_FUSIONS,
} from "../game/combat-systems";

describe("active tactical reload", () => {
  it("awards a perfect reload inside the sweet spot and misses outside it", () => {
    expect(evaluateActiveReload(0.2)).toBe("miss");
    expect(evaluateActiveReload(ACTIVE_RELOAD_WINDOW_START - 0.01)).toBe("miss");
    expect(evaluateActiveReload(ACTIVE_RELOAD_WINDOW_START)).toBe("perfect");
    expect(evaluateActiveReload(0.6)).toBe("perfect");
    expect(evaluateActiveReload(ACTIVE_RELOAD_WINDOW_END)).toBe("perfect");
    expect(evaluateActiveReload(ACTIVE_RELOAD_WINDOW_END + 0.01)).toBe("miss");
  });
});

describe("combo salvage multiplier", () => {
  it("scales salvage rewards monotonically at combo milestones", () => {
    expect(getComboSalvageMultiplier(0)).toBe(1);
    expect(getComboSalvageMultiplier(2)).toBe(1);
    expect(getComboSalvageMultiplier(3)).toBe(1.25);
    expect(getComboSalvageMultiplier(5)).toBe(1.5);
    expect(getComboSalvageMultiplier(8)).toBe(1.75);
    expect(getComboSalvageMultiplier(12)).toBe(2.0);
    expect(getComboSalvageMultiplier(30)).toBe(2.0);
  });
});

describe("evolved synergy fusions", () => {
  it("unlocks each fusion only when both paired synergies are owned", () => {
    for (const fusionId of SYNERGY_FUSION_IDS) {
      const [a, b] = SYNERGY_FUSIONS[fusionId].pair;
      expect(getActiveFusions({ [a]: 1 })).not.toContain(fusionId);
      expect(getActiveFusions({ [b]: 1 })).not.toContain(fusionId);
      expect(getActiveFusions({ [a]: 1, [b]: 1 })).toContain(fusionId);
    }
  });

  it("identifies draft cards that will complete a new fusion", () => {
    expect(getFusionCompletedByCard({ cryo_frost: 1 }, "tesla_arcs")?.id).toBe("superconductor");
    expect(getFusionCompletedByCard({ tesla_arcs: 1 }, "cryo_frost")?.id).toBe("superconductor");
    expect(getFusionCompletedByCard({ cryo_frost: 1, tesla_arcs: 1 }, "tesla_arcs")).toBeNull();
    expect(getFusionCompletedByCard({ piercing: 1 }, "vampiric_leech")).toBeNull();
  });
});

describe("rotated obstacle bounds", () => {
  it("swaps width and depth half-extents for 90-degree rotated barricades", () => {
    const unrotated = rotatedBoxHalfExtents(2.4, 0.6, 0);
    expect(unrotated.hx).toBeCloseTo(1.2);
    expect(unrotated.hz).toBeCloseTo(0.3);

    const perpendicular = rotatedBoxHalfExtents(2.4, 0.6, Math.PI / 2);
    expect(perpendicular.hx).toBeCloseTo(0.3);
    expect(perpendicular.hz).toBeCloseTo(1.2);
  });
});
