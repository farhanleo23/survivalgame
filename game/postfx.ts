import * as THREE from "three";

/**
 * Neon-Noir Stylized Post-Process Pipeline:
 *   1. Crisp depth + luminance edge ink (refined thin contour, never muddy).
 *   2. Real 9-tap mip-style emissive bloom so lasers, muzzle flashes, fireballs,
 *      toxic pools, and Overdrive auras radiate across the dark arena.
 *   3. Subtle chromatic aberration + impact flash driven by explosions, crits,
 *      and active Overdrive Surge.
 *   4. Filmic contrast curve, subtle cool-shadow / warm-highlight split toning,
 *      and cinematic edge vignette.
 */

const COMIC_SHADER = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragment: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uOutlineStrength;
    uniform float uOutlineWidth;
    uniform float uHalftoneScale;
    uniform float uHalftoneStrength;
    uniform float uGrainStrength;
    uniform float uPosterSteps;
    uniform vec3 uInkColor;
    uniform float uBloomStrength;
    uniform float uChromatic;
    uniform float uOverdrive;
    uniform float uHitFlash;

    varying vec2 vUv;

    float luma(vec3 color) {
      return dot(color, vec3(0.299, 0.587, 0.114));
    }

    float linearDepth(vec2 uv) {
      float depth = texture2D(tDepth, uv).x;
      float z = depth * 2.0 - 1.0;
      float viewZ = (2.0 * uCameraNear * uCameraFar) /
                    (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
      return viewZ / uCameraFar;
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    vec3 acesFilm(vec3 x) {
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    vec3 linearToSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    vec3 brightPass(vec3 linearColor) {
      float b = max(linearColor.r, max(linearColor.g, linearColor.b));
      float knee = smoothstep(0.64, 0.98, b);
      return linearColor * knee;
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      vec2 centered = vUv - 0.5;
      float distFromCenter = length(centered);

      // --- 1. Subtle Chromatic Aberration (spikes on impacts & Overdrive) ---
      float caAmount = (0.0008 + uChromatic * 0.0048 + uOverdrive * 0.0018) * distFromCenter;
      vec2 caOffset = centered * caAmount;
      vec3 linColor = vec3(
        texture2D(tDiffuse, clamp(vUv + caOffset, 0.0, 1.0)).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, clamp(vUv - caOffset, 0.0, 1.0)).b
      );

      // --- 2. Dual-Ring Screen-Space Emissive Bloom -------------------------
      vec3 bloom = vec3(0.0);
      if (uBloomStrength > 0.001) {
        vec2 r1 = texel * 3.5;
        vec2 r2 = texel * 8.5;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(r1.x, 0.0), 0.0, 1.0)).rgb) * 0.16;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv - vec2(r1.x, 0.0), 0.0, 1.0)).rgb) * 0.16;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(0.0, r1.y), 0.0, 1.0)).rgb) * 0.16;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv - vec2(0.0, r1.y), 0.0, 1.0)).rgb) * 0.16;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(r2.x, r2.y), 0.0, 1.0)).rgb) * 0.09;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(-r2.x, r2.y), 0.0, 1.0)).rgb) * 0.09;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(r2.x, -r2.y), 0.0, 1.0)).rgb) * 0.09;
        bloom += brightPass(texture2D(tDiffuse, clamp(vUv + vec2(-r2.x, -r2.y), 0.0, 1.0)).rgb) * 0.09;
      }

      linColor += bloom * (uBloomStrength + uOverdrive * 0.35);

      // --- 3. Filmic Tone Mapping + Split-Tone Atmospheric Grading ----------
      vec3 graded = acesFilm(linColor * 1.18);
      vec3 color = linearToSRGB(graded);

      // Cool midnight-teal shadows, punchy warm-gold highlights
      float lum = luma(color);
      vec3 shadowTint = vec3(0.02, 0.06, 0.11);
      vec3 highlightTint = vec3(1.04, 1.01, 0.96);
      color = mix(color + shadowTint * (1.0 - lum) * 0.45, color * highlightTint, smoothstep(0.35, 0.85, lum));

      // Subtle saturation boost so neon cyan, fire orange & bio-green pop
      float satBoost = 1.14 + uOverdrive * 0.12;
      color = mix(vec3(luma(color)), color, satBoost);

      // --- 4. Refined Stylized Silhouette Outlines --------------------------
      vec2 off = texel * (uOutlineWidth * 0.72);
      float d0 = linearDepth(vUv);
      float d1 = linearDepth(vUv + vec2(off.x, 0.0));
      float d2 = linearDepth(vUv + vec2(0.0, off.y));
      float d3 = linearDepth(vUv + off);
      float depthEdge = length(vec2(d0 - d3, d1 - d2));
      depthEdge = smoothstep(0.001, 0.0032 + d0 * 0.024, depthEdge);
      float edge = clamp(depthEdge, 0.0, 1.0) * (uOutlineStrength * 0.62);
      color = mix(color, uInkColor, edge);

      // --- 5. Subtle Vignette, Overdrive Energy Rim & Damage Flash ----------
      float vignette = smoothstep(0.34, 0.92, distFromCenter);
      color *= mix(1.0, 0.66, vignette);

      if (uOverdrive > 0.01) {
        vec3 surgeGlow = mix(vec3(0.18, 0.85, 1.0), vec3(1.0, 0.78, 0.25), smoothstep(0.35, 0.85, distFromCenter));
        color += surgeGlow * vignette * uOverdrive * 0.28;
      }
      if (uHitFlash > 0.01) {
        color += vec3(0.95, 0.12, 0.18) * vignette * uHitFlash * 0.55;
      }

      // Ultra-fine film grain for tactile texture
      float grain = hash(floor(vUv * uResolution * 0.5)) - 0.5;
      color += grain * uGrainStrength;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

export interface ComicPostOptions {
  outlineStrength?: number;
  halftoneScale?: number;
  halftoneStrength?: number;
  grainStrength?: number;
  posterSteps?: number;
  inkColor?: number;
  bloomStrength?: number;
}

export class ComicPostProcess {
  private target?: THREE.WebGLRenderTarget;
  private material?: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad?: THREE.Mesh;
  private halftoneCssScale: number;
  private disposed = false;
  private fallbackDirect = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    options: ComicPostOptions = {},
  ) {
    this.halftoneCssScale = options.halftoneScale ?? 4.5;
    try {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());

      const depthTexture = new THREE.DepthTexture(size.x, size.y);
      depthTexture.type = THREE.UnsignedIntType;
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;

      this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthTexture,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;

      this.material = new THREE.ShaderMaterial({
        vertexShader: COMIC_SHADER.vertex,
        fragmentShader: COMIC_SHADER.fragment,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tDiffuse: { value: this.target.texture },
          tDepth: { value: depthTexture },
          uResolution: { value: new THREE.Vector2(size.x, size.y) },
          uCameraNear: { value: 0.1 },
          uCameraFar: { value: 110 },
          uOutlineStrength: { value: options.outlineStrength ?? 0.58 },
          uOutlineWidth: { value: 1.6 },
          uHalftoneScale: { value: this.halftoneCssScale * renderer.getPixelRatio() },
          uHalftoneStrength: { value: options.halftoneStrength ?? 0.04 },
          uGrainStrength: { value: options.grainStrength ?? 0.014 },
          uPosterSteps: { value: options.posterSteps ?? 12 },
          uInkColor: { value: new THREE.Color(options.inkColor ?? 0x09111c) },
          uBloomStrength: { value: options.bloomStrength ?? 0.72 },
          uChromatic: { value: 0.0 },
          uOverdrive: { value: 0.0 },
          uHitFlash: { value: 0.0 },
        },
      });

      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
      this.quad.frustumCulled = false;
      this.quadScene.add(this.quad);
    } catch {
      this.fallbackDirect = true;
    }
  }

  setSize(width: number, height: number) {
    if (this.disposed || this.fallbackDirect || !this.target || !this.material) return;
    try {
      const pixelRatio = this.renderer.getPixelRatio();
      const w = Math.max(1, Math.floor(width * pixelRatio));
      const h = Math.max(1, Math.floor(height * pixelRatio));
      this.target.setSize(w, h);
      this.material.uniforms.uResolution.value.set(w, h);
      this.material.uniforms.uOutlineWidth.value = 1.45 * pixelRatio;
      this.material.uniforms.uHalftoneScale.value = this.halftoneCssScale * pixelRatio;
    } catch {
      this.fallbackDirect = true;
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (this.disposed) return;
    if (this.fallbackDirect || !this.target || !this.material) {
      this.renderer.render(scene, camera);
      return;
    }
    try {
      this.material.uniforms.uCameraNear.value = camera.near;
      this.material.uniforms.uCameraFar.value = camera.far;

      this.renderer.setRenderTarget(this.target);
      this.renderer.clear();
      this.renderer.render(scene, camera);

      this.renderer.setRenderTarget(null);
      this.renderer.render(this.quadScene, this.quadCamera);
    } catch {
      this.fallbackDirect = true;
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
    }
  }

  setUniform(name: string, value: number) {
    if (!this.material) return;
    const uniform = this.material.uniforms[name];
    if (uniform) uniform.value = value;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.target?.depthTexture?.dispose();
      this.target?.dispose();
      this.material?.dispose();
      this.quad?.geometry.dispose();
    } catch {
      // Ignore cleanup error
    }
  }
}
