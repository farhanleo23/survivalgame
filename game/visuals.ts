import * as THREE from "three";
import type { EnemyDefinition, EnemyId, GraphicsQuality, WeaponId } from "./types";
import { CharacterVisualSystem } from "./visuals/characters";
import { EnvironmentVisualSystem } from "./visuals/environment";
import { TacticalDecalSystem } from "./visuals/effects";
import { collectResources, createResources, disposeObject, disposeResources, type CharacterRig } from "./visuals/shared";

export type { CharacterRig } from "./visuals/shared";

export class VisualFactory {
  readonly groundMaterial: THREE.MeshStandardMaterial;
  private characters: CharacterVisualSystem;
  private environment: EnvironmentVisualSystem;
  private decals: TacticalDecalSystem;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, quality: GraphicsQuality = "medium") {
    this.characters = new CharacterVisualSystem(quality);
    this.environment = new EnvironmentVisualSystem(renderer, quality);
    this.decals = new TacticalDecalSystem(quality);
    this.groundMaterial = this.environment.groundMaterial;
  }

  ready() {
    return this.characters.ready();
  }

  setQuality(quality: GraphicsQuality) {
    this.characters.setQuality(quality);
    this.environment.setQuality(quality);
    this.decals.setQuality(quality);
  }

  createGround() {
    return this.environment.createGround();
  }

  addPerimeter(scene: THREE.Scene) {
    this.environment.addPerimeter(scene);
  }

  createDepotStructure(width: number, depth: number, accentColor: number) {
    return this.environment.createDepotStructure(width, depth, accentColor);
  }

  createBarricade(width: number, depth: number) {
    return this.environment.createBarricade(width, depth);
  }

  createFloodlight(color: number) {
    return this.environment.createFloodlight(color);
  }

  createBarrel() {
    return this.environment.createBarrel();
  }

  addSetDressing(scene: THREE.Scene) {
    this.environment.addSetDressing(scene);
  }

  createPlayer(weapon: WeaponId = "pistol") {
    return this.characters.createPlayer(weapon);
  }

  createEnemy(type: EnemyId, definition: EnemyDefinition) {
    return this.characters.createEnemy(type, definition);
  }

  setPlayerWeapon(rig: CharacterRig, weapon: WeaponId) {
    this.characters.setWeapon(rig, weapon);
  }

  animateCharacter(rig: CharacterRig, dt: number, speed: number, attacking: boolean, hit: number) {
    this.characters.animate(rig, dt, speed, attacking, hit);
  }

  disposeCharacter(rig: CharacterRig) {
    this.characters.dispose(rig);
  }

  disposeObject(root: THREE.Object3D) {
    disposeObject(root);
  }

  addBloodDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.decals.addBlood(scene, position, scale);
  }

  addAcidDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.decals.addAcid(scene, position, scale);
  }

  addScorchDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.decals.addScorch(scene, position, scale);
  }

  dispose(scene: THREE.Scene) {
    if (this.disposed) return;
    this.disposed = true;
    this.decals.dispose();
    const resources = createResources();
    collectResources(scene, resources, true);
    disposeResources(resources);
    scene.clear();
  }
}

