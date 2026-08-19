import * as THREE from "three";

/**
 * Comic post-process: the pass that turns a flat-shaded 3D scene into a
 * printed page.
 *
 * Four things happen in one fullscreen shader:
 *   1. Ink outlines from depth + luminance discontinuities. Screen-space edge
 *      detection gives a constant-width line regardless of how far away or how
 *      large the object is — the thing inflated back-face hulls can never do.
 *   2. Posterisation, snapping colour to a small number of steps so gradients
 *      that survive the toon ramp still read as flat fill.
 *   3. Halftone dots in the shadows, scaled by local luminance the way a real
 *      screen-printed comic varies dot size.
 *   4. Paper grain, fixed to screen space so it reads as paper rather than
 *      shimmering film noise.
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

    varying vec2 vUv;

    float luma(vec3 color) {
      return dot(color, vec3(0.299, 0.587, 0.114));
    }

    // Depth buffer is non-linear; comparing raw values makes distant edges
    // vanish and near edges scream. Convert to view-space distance first.
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

    // The scene arrives linear. Posterising, halftoning and thresholding are
    // all print operations that belong in display space, so encode first and
    // work in sRGB from there — and because this pass writes straight to the
    // canvas, the encode has to happen here or the frame renders dark.
    vec3 linearToSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    vec3 sampleSRGB(vec2 uv) {
      return linearToSRGB(texture2D(tDiffuse, uv).rgb);
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      // Sample offset in *device* pixels. At DPR 2 a one-texel offset is only
      // half a CSS pixel, which is why a naive edge pass looks hairline-thin on
      // retina displays; uOutlineWidth is set from the live pixel ratio so the
      // ink reads the same weight everywhere.
      vec2 off = texel * uOutlineWidth;
      vec3 color = sampleSRGB(vUv);

      // --- 1. Ink outlines -------------------------------------------------
      // Roberts cross on both depth and luminance. Depth catches silhouettes
      // and overlaps; luminance catches creases between two touching surfaces
      // at the same depth, which depth alone misses on flat cel shading.
      float d0 = linearDepth(vUv);
      float d1 = linearDepth(vUv + vec2(off.x, 0.0));
      float d2 = linearDepth(vUv + vec2(0.0, off.y));
      float d3 = linearDepth(vUv + off);

      float depthEdge = length(vec2(d0 - d3, d1 - d2));
      // Scale the threshold with distance so far-away geometry does not
      // dissolve into a solid mass of outline.
      depthEdge = smoothstep(0.0006, 0.0022 + d0 * 0.02, depthEdge);

      float l0 = luma(color);
      float l1 = luma(sampleSRGB(vUv + vec2(off.x, 0.0)));
      float l2 = luma(sampleSRGB(vUv + vec2(0.0, off.y)));
      float l3 = luma(sampleSRGB(vUv + off));
      float lumaEdge = smoothstep(0.16, 0.42, length(vec2(l0 - l3, l1 - l2)));

      float edge = clamp(max(depthEdge, lumaEdge * 0.75), 0.0, 1.0) * uOutlineStrength;

      // --- 2. Posterise ----------------------------------------------------
      vec3 posterised = floor(color * uPosterSteps + 0.5) / uPosterSteps;
      color = mix(color, posterised, 0.75);

      // --- 3. Halftone -----------------------------------------------------
      // Classic screen-print angle keeps the dot grid from aligning with the
      // pixel grid and moiring against the floor tiles.
      float angle = 0.4363; // 25 degrees
      mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
      vec2 gridUv = rotation * (vUv * uResolution / uHalftoneScale);
      vec2 cell = fract(gridUv) - 0.5;

      float brightness = luma(color);
      // Dot radius grows as the area darkens — ink coverage, not opacity.
      float radius = (1.0 - smoothstep(0.0, 0.62, brightness)) * 0.58;
      float dot = 1.0 - smoothstep(radius - 0.14, radius + 0.05, length(cell));
      // Confined to genuine shadow. Letting dots creep into the midtones just
      // reads as a dimmer image, which is the murk we came here to remove.
      float shadowMask = 1.0 - smoothstep(0.05, 0.34, brightness);
      color = mix(color, uInkColor, dot * shadowMask * uHalftoneStrength);

      // --- 4. Paper grain --------------------------------------------------
      // No time term: paper does not crawl between frames.
      float grain = hash(floor(vUv * uResolution * 0.5)) - 0.5;
      color += grain * uGrainStrength;

      // Ink goes on last so outlines stay solid black over dots and grain.
      color = mix(color, uInkColor, edge);

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
      // Three always writes linear into a non-XR render target — `outputColorSpace`
      // only applies to the default framebuffer — so the pass reads linear values
      // and has to encode to sRGB itself before writing to the canvas.
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
          uOutlineStrength: { value: options.outlineStrength ?? 1.0 },
          uOutlineWidth: { value: 2.0 },
          uHalftoneScale: { value: this.halftoneCssScale * renderer.getPixelRatio() },
          uHalftoneStrength: { value: options.halftoneStrength ?? 0.5 },
          uGrainStrength: { value: options.grainStrength ?? 0.045 },
          uPosterSteps: { value: options.posterSteps ?? 10 },
          uInkColor: { value: new THREE.Color(options.inkColor ?? 0x140f1e) },
        },
      });

      // Fullscreen triangle-ish quad; the vertex shader ignores the projection.
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
      this.material.uniforms.uOutlineWidth.value = 1.6 * pixelRatio;
      this.material.uniforms.uHalftoneScale.value = this.halftoneCssScale * pixelRatio;
    } catch {
      this.fallbackDirect = true;
    }
  }

  /** Set once per frame so the depth linearisation matches the live camera. */
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
