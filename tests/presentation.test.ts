import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { CharacterFactory } from "../game/characters";
import { ComicPalette } from "../game/comic";
import { DamageFeedback, normalizedReloadProgress } from "../game/presentation";
import { GameEngine } from "../game/GameEngine";
import { EnvironmentAssets } from "../game/environment-assets";

afterEach(() => vi.restoreAllMocks());

describe("reload feedback", () => {
  it("tracks the actual reload duration, including shortened reloads", () => {
    expect(normalizedReloadProgress({ reloading: 1.5, reloadDuration: 2 })).toBe(0.25);
    expect(normalizedReloadProgress({ reloading: 0.3, reloadDuration: 0.6 })).toBe(0.5);
    expect(normalizedReloadProgress({ reloading: 0, reloadDuration: 2 })).toBe(0);
    expect(normalizedReloadProgress({ reloading: 2, reloadDuration: 2 })).toBeGreaterThan(0);
    expect(normalizedReloadProgress({ reloading: 1 })).toBe(0);
  });
});

describe("damage-number aggregation", () => {
  it("combines rapid hits per target, retaining critical information without starving a continuous burst", () => {
    const queue = new DamageFeedback<string>(); const emit = vi.fn();
    queue.add("first", 10); queue.update(0.06, emit); queue.add("first", 12, true); queue.add("second", 8);
    queue.update(0.06, emit);
    expect(emit).toHaveBeenCalledExactlyOnceWith("first", 22, true);
    queue.update(0.06, emit); expect(emit).toHaveBeenLastCalledWith("second", 8, false);
    expect(queue.size).toBe(0);
  });
  it("caps queued targets and clears feedback between arenas", () => {
    const queue = new DamageFeedback<number>(); for (let i = 0; i < 100; i++) queue.add(i, 1);
    expect(queue.size).toBe(48); queue.clear(); expect(queue.size).toBe(0);
  });
});

describe("animation lifetime and asset fallbacks", () => {
  it("keeps the survivor and its weapon visible when a model cannot load", async () => {
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockRejectedValue(new Error("offline"));
    const palette = new ComicPalette(); const factory = new CharacterFactory(palette);
    const rig = factory.createCharacter("player"); await factory.preload();
    expect(rig.fallback?.parent).toBe(rig.body); expect(rig.weaponModels?.size).toBe(4);
    factory.disposeCharacter(rig); expect(rig.disposed).toBe(true);
    factory.dispose(); palette.dispose();
  });
  it("does not attach a late asset to a disposed rig", async () => {
    let resolve!: (asset: GLTF) => void;
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(() => new Promise(r => { resolve = r; }));
    const palette = new ComicPalette(); const factory = new CharacterFactory(palette);
    const rig = factory.createCharacter("shambler"); factory.disposeCharacter(rig);
    resolve({ scene: new THREE.Group(), animations: [] } as unknown as GLTF);
    await Promise.resolve(); await Promise.resolve();
    expect(rig.model).toBeUndefined(); expect(rig.root.parent).toBeNull();
    factory.dispose(); palette.dispose();
  });
  it("stops a corpse mixer and disposes it exactly once when its visual lifetime expires", () => {
    const rig = { root: new THREE.Group(), mixer: { update: vi.fn() } };
    const disposeCharacter = vi.fn(); const animateCharacter = vi.fn();
    const engine = Object.assign(Object.create(GameEngine.prototype), {
      corpses: [{ rig, life: 0.1 }], enemies: [], damageFeedback: new DamageFeedback(),
      visuals: { disposeCharacter, animateCharacter }, spawnFloatingText: vi.fn(),
    });
    engine.updatePresentation(0.05); expect(animateCharacter).toHaveBeenCalledOnce();
    engine.updatePresentation(0.06); engine.updatePresentation(1);
    expect(disposeCharacter).toHaveBeenCalledExactlyOnceWith(rig); expect(engine.corpses).toHaveLength(0);
    expect(engine.enemies).toHaveLength(0);
  });
  it("cleans both death visuals and queued numbers on a transition", () => {
    const rig = {}; const queue = new DamageFeedback(); queue.add({}, 10);
    const disposeCharacter = vi.fn();
    const engine = Object.assign(Object.create(GameEngine.prototype), {
      corpses: [{ rig, life: 0.8 }], damageFeedback: queue, visuals: { disposeCharacter },
    });
    engine.clearPresentation(); expect(disposeCharacter).toHaveBeenCalledExactlyOnceWith(rig);
    expect(engine.corpses).toHaveLength(0); expect(queue.size).toBe(0);
  });
  it("preserves visible cover if the supporting architecture fails to load", async () => {
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockRejectedValue(new Error("missing"));
    const library = new EnvironmentAssets(); const fallback = new THREE.Group();
    const prop = library.create("building-h", 2, 3, 2, fallback); await library.ready();
    expect(prop.children).toContain(fallback); library.dispose();
  });
});
