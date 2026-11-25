import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** A small, shared library: scenery clones borrow geometry/materials until shutdown. */
export class EnvironmentAssets {
  private loader = new GLTFLoader();
  private assets = new Map<string, Promise<THREE.Group>>();
  private disposed = false;

  private load(name: string) {
    let asset = this.assets.get(name);
    if (!asset) {
      asset = this.loader.loadAsync(`/models/industrial/${name}.glb`).then(({ scene }) => {
        scene.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          node.castShadow = true; node.receiveShadow = true;
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            if (material instanceof THREE.MeshStandardMaterial) {
              material.color.multiply(new THREE.Color(0x9baebb));
              material.roughness = 0.95; material.metalness = 0.08;
              material.onBeforeCompile = shader => {
                shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
                  float industrialValue = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(industrialValue) * vec3(0.78, 0.91, 1.0), 0.84);`);
              };
              material.customProgramCacheKey = () => "deadwave-industrial-palette";
            }
          }
        });
        return scene;
      });
      this.assets.set(name, asset);
    }
    return asset;
  }

  /** The supplied placeholder and replacement occupy exactly the same X/Z bounds. */
  create(name: string, width: number, depth: number, height: number, fallback: THREE.Object3D) {
    const root = new THREE.Group(); root.add(fallback);
    void this.load(name).then(source => {
      if (this.disposed) return;
      const model = source.clone(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      model.scale.set(width / Math.max(size.x, 0.001), height / Math.max(size.y, 0.001), depth / Math.max(size.z, 0.001));
      bounds.setFromObject(model);
      model.position.set(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
      root.remove(fallback); root.add(model);
    }).catch(() => { /* The solid fallback keeps cover visible even offline. */ });
    return root;
  }

  async ready() { await Promise.allSettled(this.assets.values()); }

  dispose() {
    this.disposed = true;
    const geometry = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    for (const asset of this.assets.values()) void asset.then(scene => {
      scene.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        if (!geometry.has(node.geometry)) { geometry.add(node.geometry); node.geometry.dispose(); }
        for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
          if (!materials.has(mat)) { materials.add(mat); mat.dispose(); }
          const map = (mat as THREE.MeshStandardMaterial).map;
          if (map && !textures.has(map)) { textures.add(map); map.dispose(); }
        }
      });
    }).catch(() => {});
    this.assets.clear();
  }
}
