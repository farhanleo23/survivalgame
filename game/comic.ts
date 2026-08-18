import * as THREE from "three";

/**
 * Shared comic-book art system.
 *
 * Everything the game draws goes through here so the whole scene reads as one
 * printed page: flat cel bands instead of smooth PBR falloff, heavy ink
 * outlines, and a saturated palette with no muddy mid-tones.
 */

/**
 * Saturated pop-art palette. Colours are picked to stay separated at the
 * top-down camera distance, where value contrast matters more than hue.
 */
export const COMIC = {
  ink: 0x120d1a,
  paper: 0xf4ead6,
  sky: 0x2b3f7a,

  // Floor and architecture
  asphalt: 0x6b7a99,
  asphaltDark: 0x4c5a78,
  concrete: 0x9aa7bd,
  hazardYellow: 0xffc61e,
  hazardStripe: 0xe8531f,
  rust: 0xc2571f,
  steel: 0x7f8fa8,

  // Operator
  operator: 0x35d3ff,
  operatorDeep: 0x1a72c4,
  operatorTrim: 0xfff4d6,

  // Infected — each archetype owns a hue band so type reads at a glance
  shambler: 0x6fbf3f,
  runner: 0xff8a1f,
  spitter: 0x27d17a,
  brute: 0x8f6bd6,
  boomer: 0xd8e04a,
  juggernaut: 0xff2e4d,

  // FX
  blood: 0xd11a4a,
  acid: 0x6dff2f,
  fire: 0xff6a1a,
  frost: 0x59e5ff,
  electric: 0x35f0ff,
  gold: 0xffc61e,
};

/**
 * Three hard bands and a highlight. Nearest filtering keeps the steps crisp —
 * any interpolation here reintroduces the smooth gradients we are removing.
 */
export function createToonRamp(): THREE.DataTexture {
  // The shadow band is deliberately high. Comic art keeps hue in the shadows
  // and reserves true black for the ink line — drop this band much lower and
  // every saturated colour turns muddy on its unlit side.
  const bands = new Uint8Array([
    134, 126, 152, 255, // shadow, still carrying colour
    190, 184, 202, 255, // mid
    238, 236, 232, 255, // light
    255, 255, 255, 255, // highlight
  ]);
  const texture = new THREE.DataTexture(bands, 4, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export interface ToonOptions {
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

/**
 * Factory for every surface in the game. Holds the one shared ramp so all
 * materials step their light at exactly the same thresholds.
 */
export class ComicPalette {
  readonly ramp: THREE.DataTexture;
  private materials: THREE.Material[] = [];
  private outlineMaterials = new Map<number, THREE.MeshBasicMaterial>();

  constructor() {
    this.ramp = createToonRamp();
  }

  /** Flat cel-shaded surface. The workhorse material. */
  toon(color: number, options: ToonOptions = {}): THREE.MeshToonMaterial {
    const material = new THREE.MeshToonMaterial({
      color,
      gradientMap: this.ramp,
      emissive: options.emissive ?? 0x000000,
      emissiveIntensity: options.emissiveIntensity ?? 1,
      transparent: options.transparent ?? false,
      opacity: options.opacity ?? 1,
      side: options.side ?? THREE.FrontSide,
    });
    this.materials.push(material);
    return material;
  }

  /** Unlit fill, for glows and screen-space-ish graphics that must not shade. */
  flat(color: number, options: ToonOptions = {}): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: options.transparent ?? false,
      opacity: options.opacity ?? 1,
      side: options.side ?? THREE.FrontSide,
    });
    this.materials.push(material);
    return material;
  }

  /** Shared back-face ink shell material, cached per colour. */
  outlineMaterial(color = COMIC.ink): THREE.MeshBasicMaterial {
    const existing = this.outlineMaterials.get(color);
    if (existing) return existing;
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    this.outlineMaterials.set(color, material);
    this.materials.push(material);
    return material;
  }

  dispose() {
    for (const material of this.materials) material.dispose();
    this.materials = [];
    this.outlineMaterials.clear();
    this.ramp.dispose();
  }
}

/**
 * Inflated back-face hull — the classic cheap ink outline.
 *
 * `thickness` is a fraction of the mesh size, so small props need a larger
 * value than big ones to end up with a visually comparable line weight.
 */
export function inkOutline(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  outlineMaterial: THREE.MeshBasicMaterial,
  thickness = 0.06,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "inked";

  const fill = new THREE.Mesh(geometry, material);
  fill.castShadow = true;
  fill.receiveShadow = true;

  const outline = new THREE.Mesh(geometry, outlineMaterial);
  outline.scale.setScalar(1 + thickness);
  outline.renderOrder = -1;
  outline.raycast = () => {};

  group.add(outline, fill);
  return group;
}

/**
 * Ink an existing mesh in place by parenting a scaled back-face twin to it.
 * Used when geometry is already positioned inside a rig and cannot be wrapped.
 */
export function inkInPlace(target: THREE.Mesh, outlineMaterial: THREE.MeshBasicMaterial, thickness = 0.06) {
  const outline = new THREE.Mesh(target.geometry, outlineMaterial);
  outline.scale.setScalar(1 + thickness);
  outline.renderOrder = -1;
  outline.raycast = () => {};
  outline.name = "ink-shell";
  target.add(outline);
  return outline;
}
