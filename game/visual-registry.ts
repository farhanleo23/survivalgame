import type { EnemyId, GraphicsQuality, PickupId, WeaponId } from "./types";

export type CharacterVisualId = "player" | EnemyId;
export type CharacterMotion = "idle" | "walk" | "run" | "attack" | "hit" | "death" | "spawn";

export interface CharacterVisualDefinition {
  id: CharacterVisualId;
  silhouette: "operator" | "shambler" | "runner" | "spitter" | "brute" | "juggernaut";
  scale: number;
  bodyColor: number;
  accentColor: number;
  emissiveColor: number;
  gait: "tactical" | "drag" | "sprint" | "stalk" | "heavy" | "siege";
  modelPath?: string;
  lodModelPath?: string;
  textureSize: 1024 | 2048;
  motions: readonly CharacterMotion[];
}

export interface WeaponVisualDefinition {
  id: WeaponId;
  length: number;
  width: number;
  barrelLength: number;
  stockLength: number;
  accentColor: number;
  tracerColor: number;
  kick: number;
}

export interface EnvironmentVisualDefinition {
  id: "depot";
  palette: {
    asphalt: number;
    concrete: number;
    steel: number;
    objective: number;
    danger: number;
  };
  landmarks: readonly ["evacuation-ring", "medical-command", "damaged-gate"];
  materialLayers: readonly ["asphalt", "cracked-concrete", "mud", "paint"];
}

export interface GraphicsBudget {
  quality: GraphicsQuality;
  maxPixelRatio: number;
  shadowMapSize: 512 | 1024 | 2048;
  maxBloodDecals: number;
  maxParticles: number;
  dustParticles: number;
  dynamicCharacterShadows: number;
  lodDistance: number;
}

const motions = ["idle", "walk", "run", "attack", "hit", "death", "spawn"] as const;

export const CHARACTER_VISUALS: Record<CharacterVisualId, CharacterVisualDefinition> = {
  player: { id: "player", silhouette: "operator", scale: 1.08, bodyColor: 0x9ca9a0, accentColor: 0xb8ff5a, emissiveColor: 0x64ffb0, gait: "tactical", textureSize: 2048, motions },
  shambler: { id: "shambler", silhouette: "shambler", scale: 1, bodyColor: 0x697264, accentColor: 0xa64c36, emissiveColor: 0xff4a32, gait: "drag", textureSize: 1024, motions },
  runner: { id: "runner", silhouette: "runner", scale: 0.92, bodyColor: 0x806d5e, accentColor: 0xef9b4c, emissiveColor: 0xff6d37, gait: "sprint", textureSize: 1024, motions },
  spitter: { id: "spitter", silhouette: "spitter", scale: 1.04, bodyColor: 0x60735a, accentColor: 0x9aff4d, emissiveColor: 0x75ff2f, gait: "stalk", textureSize: 1024, motions },
  brute: { id: "brute", silhouette: "brute", scale: 1.28, bodyColor: 0x6d6259, accentColor: 0xe16b43, emissiveColor: 0xff4d34, gait: "heavy", textureSize: 1024, motions },
  juggernaut: { id: "juggernaut", silhouette: "juggernaut", scale: 1.62, bodyColor: 0x4e4b48, accentColor: 0xff3e2c, emissiveColor: 0xff271b, gait: "siege", textureSize: 2048, motions },
};

export const WEAPON_VISUALS: Record<WeaponId, WeaponVisualDefinition> = {
  pistol: { id: "pistol", length: 0.55, width: 0.16, barrelLength: 0.25, stockLength: 0, accentColor: 0xe48a45, tracerColor: 0xffd36b, kick: 0.06 },
  smg: { id: "smg", length: 0.82, width: 0.2, barrelLength: 0.34, stockLength: 0.18, accentColor: 0x67efb1, tracerColor: 0x81ffd2, kick: 0.04 },
  shotgun: { id: "shotgun", length: 1.1, width: 0.2, barrelLength: 0.56, stockLength: 0.34, accentColor: 0xff8c4f, tracerColor: 0xffaa62, kick: 0.18 },
  rifle: { id: "rifle", length: 1.18, width: 0.18, barrelLength: 0.62, stockLength: 0.3, accentColor: 0x9be8ff, tracerColor: 0xa8efff, kick: 0.09 },
};

export const PICKUP_VISUALS: Record<PickupId, { icon: "salvage" | "ammo" | "medical"; color: number }> = {
  coin: { icon: "salvage", color: 0xffc652 },
  ammo: { icon: "ammo", color: 0x65d9ff },
  health: { icon: "medical", color: 0xff6658 },
};

export const ENVIRONMENT_VISUAL: EnvironmentVisualDefinition = {
  id: "depot",
  palette: { asphalt: 0x252c2a, concrete: 0x4c5954, steel: 0x1d2929, objective: 0x92ff65, danger: 0xff5b35 },
  landmarks: ["evacuation-ring", "medical-command", "damaged-gate"],
  materialLayers: ["asphalt", "cracked-concrete", "mud", "paint"],
};

export const GRAPHICS_BUDGETS: Record<GraphicsQuality, GraphicsBudget> = {
  low: { quality: "low", maxPixelRatio: 1, shadowMapSize: 512, maxBloodDecals: 12, maxParticles: 80, dustParticles: 70, dynamicCharacterShadows: 1, lodDistance: 8 },
  medium: { quality: "medium", maxPixelRatio: 1.35, shadowMapSize: 1024, maxBloodDecals: 26, maxParticles: 180, dustParticles: 150, dynamicCharacterShadows: 4, lodDistance: 12 },
  high: { quality: "high", maxPixelRatio: 1.75, shadowMapSize: 2048, maxBloodDecals: 40, maxParticles: 300, dustParticles: 240, dynamicCharacterShadows: 8, lodDistance: 16 },
};

export function validateVisualRegistry() {
  return {
    characters: Object.keys(CHARACTER_VISUALS).length === 6,
    weapons: Object.keys(WEAPON_VISUALS).length === 4,
    pickups: Object.keys(PICKUP_VISUALS).length === 3,
    qualities: Object.keys(GRAPHICS_BUDGETS).length === 3,
  };
}
