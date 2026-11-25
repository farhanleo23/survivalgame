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
  ink: 0x09111a,
  paper: 0xeef4f6,
  sky: 0x0b1622,

  // Floor and architecture — dark moody industrial surfaces so neon FX & lights pop
  asphalt: 0x2a3642,
  asphaltDark: 0x1e2833,
  concrete: 0x4b5a68,
  hazardYellow: 0xffc43d,
  hazardStripe: 0xff5a2c,
  rust: 0x8f4d36,
  steel: 0x3b5163,

  // Operator — crisp electric cyan silhouette
  operator: 0x3ae2ff,
  operatorDeep: 0x0e6eb8,
  operatorTrim: 0xfff4d6,

  // Infected — vivid silhouettes against dark concrete
  shambler: 0x8db870,
  runner: 0xe08d58,
  spitter: 0x5be86b,
  brute: 0x7b63a8,
  boomer: 0x86e84f,
  juggernaut: 0xe83b4a,

  // FX — high-luminance emissives that feed the bloom pass
  blood: 0xd11a4a,
  acid: 0x5eff3b,
  fire: 0xff6a1a,
  frost: 0x59e5ff,
  electric: 0x35f0ff,
  gold: 0xffcf4a,
};

/**
 * High-contrast stylized shading ramp: deeper cool shadows with crisp lit highlights
 * so dramatic directional lighting, rim light, and dynamic fire/muzzle lights pop.
 */
export function createToonRamp(): THREE.DataTexture {
  const bands = new Uint8Array([
    68, 84, 102, 255,   // deep cool shadow
    144, 160, 178, 255, // crisp midtone
    228, 232, 238, 255, // lit band
    255, 255, 255, 255, // hot rim highlight
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
  /**
   * Every material handed out, so the palette can free them all at once. A
   * Set rather than an array so `release` is O(1): characters hand their
   * materials back on death, and a long run disposes thousands of them.
   */
  private materials = new Set<THREE.Material>();
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
    this.materials.add(material);
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
    this.materials.add(material);
    return material;
  }

  /**
   * Free a material that will never be drawn again.
   *
   * Materials made for one character or one effect used to live until the
   * engine died, because the palette only ever disposed in bulk. Each enemy
   * spawn allocates several, so an endless run grew without bound.
   */
  release(material: THREE.Material) {
    if (!this.materials.delete(material)) return;
    material.dispose();
  }

  /** Shared back-face ink shell material, cached per colour. */
  outlineMaterial(color = COMIC.ink): THREE.MeshBasicMaterial {
    const existing = this.outlineMaterials.get(color);
    if (existing) return existing;
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    this.outlineMaterials.set(color, material);
    this.materials.add(material);
    return material;
  }

  dispose() {
    for (const material of this.materials) material.dispose();
    this.materials.clear();
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
