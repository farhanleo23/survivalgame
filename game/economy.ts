import { getPerkUpgradeCost, getWeaponUpgradeCost, WEAPONS } from "./config";
import type { PerkId, ProfileV1, WeaponId } from "./types";

export type PurchaseResult =
  | { ok: true; profile: ProfileV1 }
  | { ok: false; reason: "owned" | "unowned" | "insufficient" | "max-rank" };

export function purchaseWeapon(profile: ProfileV1, id: WeaponId): PurchaseResult {
  if (profile.ownedWeapons.includes(id)) return { ok: false, reason: "owned" };
  const cost = WEAPONS[id].cost;
  if (profile.coins < cost) return { ok: false, reason: "insufficient" };
  const currentLoadout: WeaponId[] = profile.equippedLoadout.length ? profile.equippedLoadout : ["pistol"];
  const equipped = currentLoadout.length < 2
    ? [...currentLoadout, id]
    : [currentLoadout[0], id];
  return {
    ok: true,
    profile: { ...profile, coins: profile.coins - cost, ownedWeapons: [...profile.ownedWeapons, id], equippedLoadout: equipped },
  };
}

export function upgradeWeapon(profile: ProfileV1, id: WeaponId): PurchaseResult {
  if (!profile.ownedWeapons.includes(id)) return { ok: false, reason: "unowned" };
  const rank = profile.weaponRanks[id];
  if (rank >= 5) return { ok: false, reason: "max-rank" };
  const cost = getWeaponUpgradeCost(id, rank);
  if (profile.coins < cost) return { ok: false, reason: "insufficient" };
  return {
    ok: true,
    profile: { ...profile, coins: profile.coins - cost, weaponRanks: { ...profile.weaponRanks, [id]: rank + 1 } },
  };
}

export function upgradePerk(profile: ProfileV1, id: PerkId): PurchaseResult {
  const rank = profile.perkRanks[id];
  if (rank >= 3) return { ok: false, reason: "max-rank" };
  const cost = getPerkUpgradeCost(id, rank);
  if (profile.coins < cost) return { ok: false, reason: "insufficient" };
  return {
    ok: true,
    profile: { ...profile, coins: profile.coins - cost, perkRanks: { ...profile.perkRanks, [id]: rank + 1 } },
  };
}
