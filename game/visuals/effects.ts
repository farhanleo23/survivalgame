import * as THREE from "three";
import { GRAPHICS_BUDGETS } from "../visual-registry";
import type { GraphicsQuality } from "../types";
import { mesh, seededRandom } from "./shared";

type DecalKind = "blood" | "acid" | "scorch";

export class TacticalDecalSystem {
  private decals: THREE.Mesh[] = [];
  private textures: Record<DecalKind, THREE.CanvasTexture>;
  private quality: GraphicsQuality;

  constructor(quality: GraphicsQuality) {
    this.quality = quality;
    this.textures = {
      blood: this.createSplatterTexture("blood"),
      acid: this.createSplatterTexture("acid"),
      scorch: this.createSplatterTexture("scorch"),
    };
  }

  setQuality(quality: GraphicsQuality) {
    this.quality = quality;
    this.trim();
  }

  addBlood(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.add(scene, "blood", position, scale);
  }

  addAcid(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.add(scene, "acid", position, scale);
  }

  addScorch(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.add(scene, "scorch", position, scale);
  }

  dispose() {
    for (const decal of this.decals) this.disposeDecal(decal);
    this.decals = [];
    for (const texture of Object.values(this.textures)) texture.dispose();
  }

  private add(scene: THREE.Scene, kind: DecalKind, position: THREE.Vector3, scale: number) {
    const colors: Record<DecalKind, number> = { blood: 0x6d080b, acid: 0x72d93a, scorch: 0x161110 };
    const decalMaterial = new THREE.MeshStandardMaterial({
      color: colors[kind],
      map: this.textures[kind],
      transparent: true,
      depthWrite: false,
      opacity: kind === "acid" ? 0.76 : 0.84,
      roughness: kind === "acid" ? 0.28 : kind === "scorch" ? 1 : 0.58,
      metalness: 0.02,
      emissive: kind === "acid" ? 0x2c680f : 0x000000,
      emissiveIntensity: kind === "acid" ? 0.75 : 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const size = (kind === "scorch" ? 3.4 : 2.4) * scale;
    const decal = mesh(new THREE.PlaneGeometry(size, size), decalMaterial);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    decal.position.copy(position).setY(0.068 + Math.random() * 0.004);
    decal.name = `decal-${kind}`;
    scene.add(decal);
    this.decals.push(decal);
    this.trim();
  }

  private trim() {
    const maximum = GRAPHICS_BUDGETS[this.quality].maxBloodDecals;
    while (this.decals.length > maximum) {
      const old = this.decals.shift();
      if (old) this.disposeDecal(old);
    }
  }

  private disposeDecal(decal: THREE.Mesh) {
    decal.removeFromParent();
    decal.geometry.dispose();
    const materials = Array.isArray(decal.material) ? decal.material : [decal.material];
    for (const decalMaterial of materials) decalMaterial.dispose();
  }

  private createSplatterTexture(kind: DecalKind) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d");
    const random = seededRandom(kind === "blood" ? 419 : kind === "acid" ? 733 : 991);
    if (context) {
      context.clearRect(0, 0, 512, 512);
      const primary = kind === "blood" ? [130, 10, 14] : kind === "acid" ? [118, 220, 58] : [24, 18, 16];
      const rgb = primary.join(",");
      const gradient = context.createRadialGradient(256, 256, 20, 256, 256, 190);
      gradient.addColorStop(0, `rgba(${rgb},.96)`);
      gradient.addColorStop(0.58, `rgba(${rgb},.76)`);
      gradient.addColorStop(1, `rgba(${rgb},0)`);
      context.fillStyle = gradient;
      context.beginPath();
      for (let i = 0; i < 36; i += 1) {
        const angle = i / 36 * Math.PI * 2;
        const radius = 112 + (random() - 0.5) * 75;
        const x = 256 + Math.cos(angle) * radius;
        const y = 256 + Math.sin(angle) * radius;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
      context.fillStyle = `rgba(${rgb},.72)`;
      for (let i = 0; i < 30; i += 1) {
        const angle = random() * Math.PI * 2;
        const distance = 130 + random() * 115;
        context.beginPath();
        context.arc(256 + Math.cos(angle) * distance, 256 + Math.sin(angle) * distance, 2 + random() * 10, 0, Math.PI * 2);
        context.fill();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}

