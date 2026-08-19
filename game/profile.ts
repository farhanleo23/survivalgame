import type { ControlMode, GraphicsMode, PerkId, ProfileV1, WeaponId } from "./types";

export const PROFILE_KEY = "deadwave.profile.v1";

export function createDefaultProfile(): ProfileV1 {
  return {
    version: 1,
    coins: 0,
    ownedWeapons: ["pistol"],
    weaponRanks: { pistol: 1, smg: 1, shotgun: 1, rifle: 1 },
    perkRanks: { vitality: 0, mobility: 0, magnet: 0 },
    equippedLoadout: ["pistol"],
    settings: { music: true, sfx: true, reducedMotion: false, controlMode: "auto", graphicsMode: "auto" },
    completedLevels: [],
    highestWave: 1,
    checkpointWave: 1,
    bestEndlessWave: 0,
  };
}

const weaponIds: WeaponId[] = ["pistol", "smg", "shotgun", "rifle"];
const perkIds: PerkId[] = ["vitality", "mobility", "magnet"];
const controlModes: ControlMode[] = ["auto", "touch", "keyboard"];
const graphicsModes: GraphicsMode[] = ["auto", "quality", "performance"];

function safeInt(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function validateProfile(raw: unknown): ProfileV1 {
  const defaults = createDefaultProfile();
  if (!raw || typeof raw !== "object") return defaults;
  const value = raw as Partial<ProfileV1>;
  const owned = Array.isArray(value.ownedWeapons)
    ? weaponIds.filter((id) => value.ownedWeapons?.includes(id))
    : defaults.ownedWeapons;
  if (!owned.includes("pistol")) owned.unshift("pistol");
  const equipped: WeaponId[] = Array.isArray(value.equippedLoadout)
    ? value.equippedLoadout.filter((id): id is WeaponId => weaponIds.includes(id as WeaponId) && owned.includes(id as WeaponId)).slice(0, 2)
    : ["pistol"];
  if (equipped.length === 0) equipped.push("pistol");

  const weaponRanks = { ...defaults.weaponRanks };
  weaponIds.forEach((id) => { weaponRanks[id] = safeInt(value.weaponRanks?.[id], 1, 5, 1); });
  const perkRanks = { ...defaults.perkRanks };
  perkIds.forEach((id) => { perkRanks[id] = safeInt(value.perkRanks?.[id], 0, 3, 0); });

  return {
    version: 1,
    coins: safeInt(value.coins, 0, 99_999_999, 0),
    ownedWeapons: owned,
    weaponRanks,
    perkRanks,
    equippedLoadout: equipped,
    settings: {
      music: value.settings?.music !== false,
      sfx: value.settings?.sfx !== false,
      reducedMotion: value.settings?.reducedMotion === true,
      controlMode: controlModes.includes(value.settings?.controlMode as ControlMode)
        ? value.settings?.controlMode as ControlMode
        : "auto",
      graphicsMode: graphicsModes.includes(value.settings?.graphicsMode as GraphicsMode)
        ? value.settings?.graphicsMode as GraphicsMode
        : "auto",
    },
    completedLevels: Array.isArray(value.completedLevels)
      ? [...new Set(value.completedLevels.filter((level) => Number.isInteger(level) && level >= 1 && level <= 50))]
      : [],
    highestWave: safeInt(value.highestWave, 1, 10, 1),
    // Older saves predate checkpoints; default them to the start.
    // Not capped at 10: endless checkpoints run past the campaign, and the
    // old bound silently rewrote a wave-12 checkpoint to 10 on reload while
    // the in-memory copy still said 12.
    checkpointWave: safeInt(value.checkpointWave, 1, 9_999, 1),
    bestEndlessWave: safeInt(value.bestEndlessWave, 0, 9_999, 0),
  };
}

export function loadProfile(storage: Storage | undefined): ProfileV1 {
  if (!storage) return createDefaultProfile();
  const serialized = storage.getItem(PROFILE_KEY);
  if (!serialized) return createDefaultProfile();
  try {
    return validateProfile(JSON.parse(serialized));
  } catch {
    try {
      storage.setItem(`${PROFILE_KEY}.corrupt.${Date.now()}`, serialized);
    } catch {
      // Storage can be unavailable in privacy modes; the fresh profile still works.
    }
    return createDefaultProfile();
  }
}

export function saveProfile(storage: Storage | undefined, profile: ProfileV1) {
  if (!storage) return;
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(validateProfile(profile)));
  } catch {
    // Game progress remains available for this tab if storage is unavailable.
  }
}
