import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { CharacterMotion, CharacterVisualId } from "../visual-registry";
import type { WeaponId } from "../types";

export interface CharacterRig {
  root: THREE.Group;
  model: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponMount: THREE.Group;
  muzzle: THREE.Object3D;
  hitMaterials: THREE.MeshStandardMaterial[];
  accentMaterials: THREE.MeshStandardMaterial[];
  activeMotion?: CharacterMotion;
  activeWeapon?: WeaponId;
  attackTelegraph?: THREE.Mesh;
  phase: number;
  scale: number;
  kind: CharacterVisualId;
  disposed: boolean;
}

export interface DisposableResources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

export const createResources = (): DisposableResources => ({
  geometries: new Set(),
  materials: new Set(),
  textures: new Set(),
});

export const collectResources = (root: THREE.Object3D, resources: DisposableResources, includeTextures = true) => {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
    resources.geometries.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      resources.materials.add(material);
      if (!includeTextures) continue;
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.textures.add(value);
    }
  });
};

export const disposeResources = (resources: DisposableResources) => {
  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();
  for (const texture of resources.textures) texture.dispose();
};

export const disposeObject = (root: THREE.Object3D, includeTextures = true) => {
  const resources = createResources();
  collectResources(root, resources, includeTextures);
  disposeResources(resources);
};

export const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => new THREE.Mesh(geometry, material);

export const rounded = (x: number, y: number, z: number, material: THREE.Material, radius = 0.05) =>
  mesh(new RoundedBoxGeometry(x, y, z, 3, Math.min(radius, x * 0.2, y * 0.2, z * 0.2)), material);

export const material = (
  color: number,
  roughness = 0.72,
  metalness = 0.08,
  emissive = 0x000000,
  emissiveIntensity = 0,
) => new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });

export const enableShadows = (root: THREE.Object3D, cast = true) => {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = cast;
    object.receiveShadow = true;
  });
};

export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

