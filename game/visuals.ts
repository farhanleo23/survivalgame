import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { COMIC, ComicPalette, inkInPlace, inkOutline } from "./comic";
import { CharacterFactory, type CharacterKind, type CharacterRig } from "./characters";
import { EnvironmentAssets } from "./environment-assets";
import type { ArenaTheme } from "./arenas";
import type { EnemyDefinition, EnemyId, WeaponId } from "./types";

export type { CharacterRig } from "./characters";

/**
 * GPU resources that belong to exactly one object and die with it.
 *
 * Almost everything the factory hands out is shared and lives until the
 * engine does. The exceptions are per-instance materials whose opacity is
 * animated (a shared one would make every live effect fade in lockstep) and
 * one-off geometry such as a lightning arc. Those are tagged here so
 * `disposeObject` can free them, instead of leaking one per shot, hit and
 * death for the whole run.
 */
export interface TransientResources {
  geometries?: THREE.BufferGeometry[];
  materials?: THREE.Material[];
}

export function markTransient(object: THREE.Object3D, resources: TransientResources) {
  object.userData.transient = resources;
}

/**
 * Scene construction for the depot arena, drawn as a printed comic panel:
 * flat cel-shaded surfaces, heavy ink outlines, and a bright saturated floor
 * that keeps every silhouette readable from the top-down camera.
 */
export class VisualFactory {
  private palette = new ComicPalette();
  private characters: CharacterFactory;

  private bloodMaterial: THREE.MeshBasicMaterial;
  private acidMaterial: THREE.MeshBasicMaterial;
  private scorchMaterial: THREE.MeshBasicMaterial;
  private decalGeometry = new THREE.PlaneGeometry(1, 1);
  private decals: THREE.Mesh[] = [];
  private textures: THREE.Texture[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  /**
   * Effect geometry and materials, keyed by every parameter that shapes them.
   *
   * A muzzle flash, a telegraph ring, a health bar, a slime pool: each used to
   * be built from scratch on every call and retained until the engine died,
   * so a minute of SMG fire left over a thousand dead geometries holding GPU
   * buffers. The variants are fully determined by their arguments, so a small
   * cache serves a whole run.
   */
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private materialCache = new Map<string, THREE.Material>();
  private disposed = false;
  private environment = new EnvironmentAssets();
  private concreteTexture?: THREE.Texture;
  private puddleRoughnessTexture?: THREE.Texture;
  private identity: ArenaTheme["identity"] = "depot";

  constructor(private renderer: THREE.WebGLRenderer) {
    this.characters = new CharacterFactory(this.palette);
    this.bloodMaterial = this.palette.flat(COMIC.blood, { transparent: true, opacity: 0.9 });
    this.bloodMaterial.map = this.track(this.createSplatTexture("#d11a4a", "#780b28"));
    this.acidMaterial = this.palette.flat(COMIC.acid, { transparent: true, opacity: 0.88 });
    this.acidMaterial.map = this.track(this.createSplatTexture("#5eff3b", "#1d7a14"));
    this.scorchMaterial = this.palette.flat(0x0b0f15, { transparent: true, opacity: 0.82 });
    this.scorchMaterial.map = this.track(this.createSplatTexture("#090d12", "#261c18"));
    this.bloodMaterial.depthWrite = false;
    this.acidMaterial.depthWrite = false;
    this.scorchMaterial.depthWrite = false;
  }

  /** Resolves once every character model is decoded and cached. */
  async ready() {
    try {
      await Promise.all([this.characters.preload(), this.environment.ready()]);
    } catch (error) {
      console.warn("Character models could not be preloaded.", error);
    }
  }

  private track<T extends THREE.Texture>(texture: T): T {
    this.textures.push(texture);
    return texture;
  }

  private own<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private cachedGeometry<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    const hit = this.geometryCache.get(key);
    if (hit) return hit as T;
    const geometry = this.own(make());
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  private cachedMaterial<T extends THREE.Material>(key: string, make: () => T): T {
    const hit = this.materialCache.get(key);
    if (hit) return hit as T;
    const material = make();
    this.materialCache.set(key, material);
    return material;
  }

  // ---------------------------------------------------------------- textures

  /** Hand-inked splat: a few overlapping blobs plus outward droplets. */
  private createSplatTexture(fill: string, edge: string): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = edge;
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2;
        const radius = 26 + Math.random() * 20;
        ctx.beginPath();
        ctx.arc(64 + Math.cos(angle) * 16, 64 + Math.sin(angle) * 16, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = fill;
      for (let i = 0; i < 5; i += 1) {
        const angle = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(64 + Math.cos(angle) * 12, 64 + Math.sin(angle) * 12, 20 + Math.random() * 14, 0, Math.PI * 2);
        ctx.fill();
      }
      // Droplets flung clear of the main mass read as motion.
      for (let i = 0; i < 12; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const distance = 40 + Math.random() * 22;
        ctx.beginPath();
        ctx.arc(64 + Math.cos(angle) * distance, 64 + Math.sin(angle) * distance, 2 + Math.random() * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return new THREE.CanvasTexture(canvas);
  }

  /** Quiet albedo under arena-specific wear; no checkerboard or screen-space texture. */
  private createFloorTexture(): THREE.Texture {
    if (this.concreteTexture) return this.concreteTexture;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    const context = canvas.getContext("2d");
    if (context) { context.fillStyle = "#8e9ba2"; context.fillRect(0, 0, 1024, 1024); }
    const texture: THREE.Texture = new THREE.CanvasTexture(canvas);
    this.concreteTexture = texture;
    new THREE.TextureLoader().load("/textures/depot-concrete.jpg", loaded => {
      if (!this.disposed) { texture.image = loaded.image; texture.needsUpdate = true; }
      loaded.dispose();
    }, undefined, () => { /* Keep the neutral fallback. */ });
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(7, 7); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  /** Diagonal hazard stripes, used on every barrier and kerb in the depot. */
  private createHazardTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#bba16c";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#37434a";
      ctx.lineWidth = 0;
      for (let i = -64; i < 128; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 16, 0);
        ctx.lineTo(i + 16 - 64, 64);
        ctx.lineTo(i - 64, 64);
        ctx.closePath();
        ctx.fill();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** Procedural rain-puddle roughness map so dynamic lights shimmer across wet patches. */
  private createPuddleRoughnessTexture(): THREE.Texture {
    if (this.puddleRoughnessTexture) return this.puddleRoughnessTexture;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#c8c8c8"; // dry matte concrete
      ctx.fillRect(0, 0, 512, 512);
      // Organic wet rain puddles with low roughness (dark values)
      for (let i = 0; i < 22; i += 1) {
        const x = ((i * 97) % 440) + 36;
        const y = ((i * 151) % 440) + 36;
        const r = 24 + (i % 5) * 14;
        const grad = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
        grad.addColorStop(0, "#1c1c1c");
        grad.addColorStop(0.65, "#3a3a3a");
        grad.addColorStop(1, "rgba(200,200,200,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Subtle concrete panel seams
      ctx.strokeStyle = "#888888";
      ctx.lineWidth = 2;
      for (let p = 0; p < 512; p += 128) {
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, 512);
        ctx.moveTo(0, p);
        ctx.lineTo(512, p);
        ctx.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    this.puddleRoughnessTexture = this.track(texture);
    return texture;
  }

  // ------------------------------------------------------------------ ground

  createGround(theme: ArenaTheme) {
    this.identity = theme.identity;
    const group = new THREE.Group();

    // Moody wet PBR concrete/asphalt floor so muzzle flashes, fireballs,
    // operator headlamp, and neon floodlights gleam across the surface!
    const floorTint =
      theme.identity === "floodbay"
        ? 0x204757
        : theme.identity === "garage"
          ? 0x2c333c
          : theme.identity === "rooftop"
            ? 0x3f3936
            : 0x33414e;
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: floorTint,
      map: this.track(this.createFloorTexture()),
      roughnessMap: this.createPuddleRoughnessTexture(),
      roughness: theme.identity === "floodbay" ? 0.32 : 0.68,
      metalness: theme.identity === "floodbay" ? 0.42 : 0.22,
    });
    const floor = new THREE.Mesh(this.own(new THREE.PlaneGeometry(46, 46)), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    // Subtle tactical concrete expansion grid
    const seams = this.palette.flat(0x0d161e, { transparent: true, opacity: 0.35 });
    const seamGeoV = this.own(new THREE.PlaneGeometry(0.05, 37));
    const seamGeoH = this.own(new THREE.PlaneGeometry(37, 0.05));
    for (const pos of [-12, -4, 4, 12]) {
      const jointV = new THREE.Mesh(seamGeoV, seams);
      jointV.rotation.x = -Math.PI / 2;
      jointV.position.set(pos, 0.011, 0);
      group.add(jointV);

      const jointH = new THREE.Mesh(seamGeoH, seams);
      jointH.rotation.x = -Math.PI / 2;
      jointH.position.set(0, 0.011, pos);
      group.add(jointH);
    }

    // Central tactical evacuation helipad stencil markings
    const padOuter = new THREE.Mesh(
      this.own(new THREE.RingGeometry(3.45, 3.65, 48)),
      this.palette.flat(theme.paint, { transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    padOuter.rotation.x = -Math.PI / 2;
    padOuter.position.y = 0.015;
    group.add(padOuter);

    const padInner = new THREE.Mesh(
      this.own(new THREE.RingGeometry(1.7, 1.78, 36)),
      this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
    );
    padInner.rotation.x = -Math.PI / 2;
    padInner.position.y = 0.016;
    group.add(padInner);

    const tickGeo = this.own(new THREE.PlaneGeometry(0.18, 0.95));
    const tickMat = this.palette.flat(theme.paint, { transparent: true, opacity: 0.42 });
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * Math.PI) / 2;
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = angle;
      tick.position.set(Math.sin(angle) * 4.2, 0.016, Math.cos(angle) * 4.2);
      group.add(tick);
    }

    // Hazard kerbs marking the playable boundary + thin glowing neon edge strips
    const hazardMaterial = this.palette.flat(0xffffff, { side: THREE.DoubleSide });
    hazardMaterial.map = this.track(this.createHazardTexture());
    hazardMaterial.map.repeat.set(24, 1);
    const stripeGeometry = this.own(new THREE.PlaneGeometry(37, 0.32));
    const glowStripGeo = this.own(new THREE.PlaneGeometry(36.4, 0.06));
    const glowStripMat = this.palette.flat(theme.identity === "floodbay" ? COMIC.electric : COMIC.hazardYellow, {
      transparent: true,
      opacity: 0.65,
    });
    for (const [x, z, rotation] of [
      [0, -18.2, 0],
      [0, 18.2, 0],
      [-18.2, 0, Math.PI / 2],
      [18.2, 0, Math.PI / 2],
    ] as const) {
      const stripe = new THREE.Mesh(stripeGeometry, hazardMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = rotation;
      stripe.position.set(x, 0.02, z);
      group.add(stripe);

      const glowStrip = new THREE.Mesh(glowStripGeo, glowStripMat);
      glowStrip.rotation.x = -Math.PI / 2;
      glowStrip.rotation.z = rotation;
      glowStrip.position.set(x * 0.975, 0.022, z * 0.975);
      group.add(glowStrip);
    }

    // Subtle worn bay lane dashes
    const laneMaterial = this.palette.flat(theme.paint, { transparent: true, opacity: 0.18 });
    const laneGeometry = this.own(new THREE.PlaneGeometry(0.14, 2.2));
    for (let i = -3; i <= 3; i += 1) {
      for (let j = -2; j <= 2; j += 1) {
        if (Math.abs(i) < 2 && Math.abs(j) < 2) continue;
        const lane = new THREE.Mesh(laneGeometry, laneMaterial);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(i * 4.6, 0.018, j * 6.2);
        group.add(lane);
      }
    }

    return group;
  }

  addPerimeter(scene: THREE.Object3D, theme: ArenaTheme) {
    const wallMaterial = this.palette.toon(theme.wall);
    const trimMaterial = this.palette.toon(theme.trim);
    const ink = this.palette.outlineMaterial();

    const wallGeometry = this.own(new RoundedBoxGeometry(42, 3.4, 0.9, 3, 0.08));
    const trimGeometry = this.own(new RoundedBoxGeometry(42, 0.45, 1.05, 3, 0.06));

    for (const [x, z, rotation] of [
      [0, -20.5, 0],
      [0, 20.5, 0],
      [-20.5, 0, Math.PI / 2],
      [20.5, 0, Math.PI / 2],
    ] as const) {
      const wall = inkOutline(wallGeometry, wallMaterial, ink, 0.012);
      wall.position.set(x, 1.7, z);
      wall.rotation.y = rotation;
      scene.add(wall);

      const trim = new THREE.Mesh(trimGeometry, trimMaterial);
      trim.position.set(x, 3.5, z);
      trim.rotation.y = rotation;
      inkInPlace(trim, ink, 0.03);
      scene.add(trim);
    }

    // Corner towers close the panel and stop the walls reading as a flat box.
    const towerGeometry = this.own(new RoundedBoxGeometry(2.6, 5.2, 2.6, 3, 0.1));
    for (const [x, z] of [
      [-20, -20],
      [20, -20],
      [-20, 20],
      [20, 20],
    ] as const) {
      const tower = inkOutline(towerGeometry, this.palette.toon(theme.wall), ink, 0.02);
      tower.position.set(x, 2.6, z);
      scene.add(tower);
    }
  }

  addSetDressing(scene: THREE.Object3D, theme: ArenaTheme) {
    for (const [x, z, rotation] of [[-13, -25, 0], [11, -25, 0], [-25, 7, Math.PI / 2], [25, 7, Math.PI / 2]]) {
      const name = theme.identity === "rooftop" ? "building-h" : "building-a";
      const prop = this.industrial(name, 14, 7, theme.identity === "garage" ? 6 : 8);
      prop.position.set(x, 0, z); prop.rotation.y = rotation; scene.add(prop);
    }
    const feature = theme.identity === "rooftop" ? "solar-panel-landscape" : theme.identity === "floodbay" ? "water-tower" : theme.identity === "garage" ? "pickup-truck" : "shipping-container-a";
    for (const x of [-14, 14]) {
      const prop = this.industrial(feature, theme.identity === "garage" ? 5 : 4, 3, theme.identity === "floodbay" ? 6 : 2);
      prop.position.set(x, 0, 23); scene.add(prop);
    }
  }

  private industrial(name: string, width: number, depth: number, height: number) {
    const shell = new THREE.Mesh(this.cachedGeometry(`cover:${width}:${depth}:${height}`, () => new THREE.BoxGeometry(width, height, depth)),
      this.cachedMaterial("cover:steel", () => this.palette.toon(COMIC.steel)));
    shell.position.y = height / 2; shell.castShadow = true; shell.receiveShadow = true;
    return this.environment.create(name, width, depth, height, shell);
  }

  createDepotStructure(width: number, depth: number, colorVariant = COMIC.steel) {
    void colorVariant;
    return this.industrial(this.identity === "depot" ? "shipping-container-a" : "building-h", width, depth, this.identity === "rooftop" ? 1.7 : 2.3);
  }

  createBarricade(width: number, depth: number) {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();
    const material = this.palette.toon(0xffffff);
    material.map = this.track(this.createHazardTexture());
    material.map.repeat.set(3, 1);

    const slab = new THREE.Mesh(this.own(new RoundedBoxGeometry(width, 0.84, depth, 2, 0.06)), material);
    slab.position.y = 0.42;
    inkInPlace(slab, ink, 0.05);
    group.add(slab);
    return group;
  }

  createTrafficBarricade(width = 2.4) {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const material = this.palette.toon(0xffffff);
    material.map = this.track(this.createHazardTexture());
    material.map.repeat.set(4, 1);

    const body = new THREE.Mesh(this.own(new RoundedBoxGeometry(width, 0.78, 0.5, 2, 0.07)), material);
    body.position.y = 0.39;
    inkInPlace(body, ink, 0.05);
    group.add(body);

    const cap = new THREE.Mesh(
      this.own(new RoundedBoxGeometry(width * 1.03, 0.14, 0.62, 2, 0.04)),
      this.palette.toon(COMIC.concrete),
    );
    cap.position.y = 0.82;
    inkInPlace(cap, ink, 0.05);
    group.add(cap);
    return group;
  }

  createTrafficCone() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const cone = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.26, 0.72, 10)), this.palette.toon(COMIC.hazardStripe));
    cone.position.y = 0.36;
    inkInPlace(cone, ink, 0.07);
    group.add(cone);

    const band = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.19, 0.22, 0.13, 10)),
      this.palette.toon(COMIC.paper),
    );
    band.position.y = 0.4;
    group.add(band);

    const base = new THREE.Mesh(
      this.own(new RoundedBoxGeometry(0.52, 0.08, 0.52, 2, 0.02)),
      this.palette.toon(COMIC.ink),
    );
    base.position.y = 0.04;
    group.add(base);
    return group;
  }

  createPallet() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();
    const wood = this.palette.toon(COMIC.rust);
    const plankGeometry = this.own(new RoundedBoxGeometry(1.5, 0.1, 0.24, 2, 0.02));

    for (let i = 0; i < 4; i += 1) {
      const plank = new THREE.Mesh(plankGeometry, wood);
      plank.position.set(0, 0.16, -0.55 + i * 0.36);
      inkInPlace(plank, ink, 0.07);
      group.add(plank);
    }
    const runner = new THREE.Mesh(this.own(new RoundedBoxGeometry(1.5, 0.12, 1.5, 2, 0.02)), this.palette.toon(0x8a4a1c));
    runner.position.y = 0.06;
    inkInPlace(runner, ink, 0.04);
    group.add(runner);
    return group;
  }

  /**
   * Destructible supply crate.
   *
   * Reads as cover at a glance and as *shootable* cover on a second look: the
   * stencilled cross and the chipped corner slats are the only props in the
   * arena drawn with a broken outline, which is the cue that it can be
   * removed. `damageCrate` swaps the material to sell each hit.
   */
  createSupplyCrate(): THREE.Group {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const body = new THREE.Mesh(
      this.own(new RoundedBoxGeometry(1.6, 1.5, 1.6, 3, 0.06)),
      this.palette.toon(COMIC.rust),
    );
    body.position.y = 0.75;
    body.castShadow = true;
    body.name = "crate-body";
    inkInPlace(body, ink, 0.045);
    group.add(body);

    // Corner slats, deliberately not flush — a crate that is already coming
    // apart reads as breakable without needing an icon.
    const slatGeometry = this.own(new RoundedBoxGeometry(1.72, 0.16, 0.2, 2, 0.02));
    const slatMaterial = this.palette.toon(0x8a4a1c);
    for (const [y, z, tilt] of [
      [0.28, 0.8, 0.04],
      [1.2, 0.8, -0.03],
      [0.28, -0.8, -0.05],
      [1.2, -0.8, 0.02],
    ] as const) {
      const slat = new THREE.Mesh(slatGeometry, slatMaterial);
      slat.position.set(0, y, z);
      slat.rotation.z = tilt;
      group.add(slat);
    }

    // Stencilled supply cross on the two faces the camera can actually see.
    const crossMaterial = this.palette.flat(COMIC.paper, { transparent: true, opacity: 0.9 });
    const barGeometry = this.own(new THREE.PlaneGeometry(0.9, 0.24));
    for (const [rotY, offZ, offX] of [
      [0, 0.81, 0],
      [Math.PI / 2, 0, 0.81],
    ] as const) {
      for (let i = 0; i < 2; i += 1) {
        const bar = new THREE.Mesh(barGeometry, crossMaterial);
        bar.position.set(offX, 0.78, offZ);
        bar.rotation.y = rotY;
        bar.rotation.z = i === 0 ? 0 : Math.PI / 2;
        group.add(bar);
      }
    }

    return group;
  }

  /**
   * Recolour a crate to its damage state. Three flat steps rather than a fade,
   * because the post-process posterises anything smoother back into steps
   * anyway and a lerp just lands on an unpredictable one.
   */
  damageCrate(crate: THREE.Group, healthFraction: number) {
    const body = crate.getObjectByName("crate-body");
    if (!(body instanceof THREE.Mesh)) return;
    const tint = healthFraction > 0.66 ? COMIC.rust : healthFraction > 0.33 ? 0x9c4a18 : 0x6b3411;
    const material = body.material as THREE.MeshToonMaterial;
    material.color.setHex(tint);
  }

  /**
   * Falling ceiling slab for the garage. Spawned above the impact point and
   * dropped by the engine, so the telegraph on the floor and the thing casting
   * it are the same event.
   */
  createDebrisSlab(): THREE.Group {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();
    const slab = new THREE.Mesh(
      this.cachedGeometry("debris-slab", () => new RoundedBoxGeometry(2.3, 0.5, 2.3, 3, 0.05)),
      this.cachedMaterial("debris-slab", () => this.palette.toon(COMIC.concrete)),
    );
    inkInPlace(slab, ink, 0.05);
    group.add(slab);

    const rebarGeometry = this.cachedGeometry("debris-rebar", () => new THREE.CylinderGeometry(0.05, 0.05, 1.1, 5));
    const rebarMaterial = this.cachedMaterial("debris-rebar", () => this.palette.toon(COMIC.steel));
    for (const [x, z] of [
      [-0.6, -0.5],
      [0.5, 0.6],
      [0.7, -0.4],
    ] as const) {
      const rebar = new THREE.Mesh(rebarGeometry, rebarMaterial);
      rebar.position.set(x, 0.5, z);
      rebar.rotation.z = 0.3;
      group.add(rebar);
    }
    return group;
  }

  /**
   * Electrified surge ring for the flooded bay: a bright annulus the engine
   * scales outward. Drawn double-sided and unlit so it stays the same
   * screaming cyan at every radius.
   */
  createSurgeRing(): THREE.Mesh {
    const ring = new THREE.Mesh(
      this.cachedGeometry("surge-ring", () => new THREE.RingGeometry(0.82, 1, 48)),
      this.cachedMaterial("surge-ring", () =>
        this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      ),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    return ring;
  }

  createBarrel() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const body = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.44, 0.44, 1.15, 14)),
      this.palette.toon(0xd93829, { emissive: 0x4a0b06, emissiveIntensity: 0.6 }),
    );
    body.position.y = 0.57;
    inkInPlace(body, ink, 0.05);
    group.add(body);

    const bandGeometry = this.own(new THREE.CylinderGeometry(0.47, 0.47, 0.11, 14));
    const bandMaterial = this.palette.flat(COMIC.hazardYellow);
    for (const y of [0.28, 0.86]) {
      const band = new THREE.Mesh(bandGeometry, bandMaterial);
      band.position.y = y;
      group.add(band);
    }

    // Glowing red ignition cap so explosive barrels pop cleanly in low light
    const cap = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.16, 0.18, 0.08, 10)),
      this.palette.flat(0xff5238),
    );
    cap.position.y = 1.18;
    group.add(cap);

    // Subtle danger halo on floor
    const halo = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.48, 0.58, 18)),
      this.palette.flat(0xff4422, { transparent: true, opacity: 0.42, side: THREE.DoubleSide }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;
    group.add(halo);
    return group;
  }

  createToxicVat() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const tank = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(1.3, 1.42, 2.7, 18)),
      this.palette.toon(COMIC.steel),
    );
    tank.position.y = 1.35;
    inkInPlace(tank, ink, 0.03);
    group.add(tank);

    const ring = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(1.46, 1.46, 0.22, 18)),
      this.palette.toon(COMIC.hazardYellow),
    );
    ring.position.y = 1.9;
    group.add(ring);

    // Glowing sludge surface — the only emissive thing on the prop.
    const sludge = new THREE.Mesh(
      this.own(new THREE.CircleGeometry(1.26, 18)),
      this.palette.flat(COMIC.acid),
    );
    sludge.rotation.x = -Math.PI / 2;
    sludge.position.y = 2.72;
    group.add(sludge);
    return group;
  }

  createGenerator() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const body = inkOutline(
      this.own(new RoundedBoxGeometry(2.6, 2.0, 1.7, 3, 0.08)),
      this.palette.toon(COMIC.hazardYellow),
      ink,
      0.025,
    );
    body.position.y = 1.0;
    group.add(body);

    const exhaust = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.19, 0.24, 1.1, 10)),
      this.palette.toon(COMIC.ink),
    );
    exhaust.position.set(0.85, 2.4, -0.4);
    inkInPlace(exhaust, ink, 0.06);
    group.add(exhaust);

    const vent = new THREE.Mesh(this.own(new THREE.PlaneGeometry(1.5, 0.9)), this.palette.flat(COMIC.ink));
    vent.position.set(0, 1.05, 0.86);
    group.add(vent);
    return group;
  }

  createFloodlight(color: number) {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const mast = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.12, 0.16, 5.0, 8)),
      this.palette.toon(COMIC.steel),
    );
    mast.position.y = 2.5;
    inkInPlace(mast, ink, 0.08);
    group.add(mast);

    const housing = new THREE.Mesh(
      this.own(new RoundedBoxGeometry(0.95, 0.65, 0.42, 2, 0.05)),
      this.palette.toon(COMIC.ink),
    );
    housing.position.set(0, 5.0, 0.2);
    housing.rotation.x = 0.45;
    inkInPlace(housing, ink, 0.05);
    group.add(housing);

    const lens = new THREE.Mesh(this.own(new THREE.PlaneGeometry(0.84, 0.54)), this.palette.flat(color));
    lens.position.set(0, 4.9, 0.44);
    lens.rotation.x = 0.45;
    group.add(lens);

    // Translucent volumetric floodlight beam & soft ground light pool
    const cone = new THREE.Mesh(
      this.own(new THREE.ConeGeometry(2.8, 5.4, 16, 1, true)),
      this.palette.flat(color, { transparent: true, opacity: 0.075, side: THREE.DoubleSide }),
    );
    cone.position.set(0, 2.35, 1.5);
    cone.rotation.x = -0.35;
    cone.renderOrder = 2;
    group.add(cone);

    const pool = new THREE.Mesh(
      this.own(new THREE.CircleGeometry(3.4, 24)),
      this.palette.flat(color, { transparent: true, opacity: 0.09, side: THREE.DoubleSide }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.025, 2.5);
    group.add(pool);
    return group;
  }

  createFurnaceBeacon() {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const stand = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.5, 0.72, 1.5, 10)),
      this.palette.toon(COMIC.ink),
    );
    stand.position.y = 0.75;
    inkInPlace(stand, ink, 0.05);
    group.add(stand);

    const drum = new THREE.Mesh(
      this.own(new THREE.CylinderGeometry(0.62, 0.56, 0.95, 12)),
      this.palette.toon(COMIC.rust),
    );
    drum.position.y = 1.9;
    inkInPlace(drum, ink, 0.05);
    group.add(drum);

    const fire = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.54, 1.15, 9)), this.palette.flat(COMIC.fire));
    fire.position.y = 2.8;
    group.add(fire);

    const flameTip = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.3, 0.72, 8)), this.palette.flat(0xfff1a8));
    flameTip.position.y = 3.0;
    group.add(flameTip);

    // Warm glowing ember pool cast on the concrete below the furnace
    const glowPool = new THREE.Mesh(
      this.own(new THREE.CircleGeometry(3.1, 24)),
      this.palette.flat(COMIC.fire, { transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
    );
    glowPool.rotation.x = -Math.PI / 2;
    glowPool.position.y = 0.026;
    group.add(glowPool);
    return group;
  }

  createSlimePool(radius = 1.4, variant: "acid" | "toxic" | "napalm" = "acid") {
    const group = new THREE.Group();
    const key = radius.toFixed(2);
    const outerColor = variant === "toxic" ? 0xd938ff : variant === "napalm" ? COMIC.fire : 0x26c736;
    const innerColor = variant === "toxic" ? 0xff70f0 : variant === "napalm" ? 0xffe478 : 0x7aff5c;

    // Dark recessed corroded ring gives depth against the concrete floor
    const recess = new THREE.Mesh(
      this.cachedGeometry(`slime-recess:${key}`, () => new THREE.CircleGeometry(radius * 1.08, 22)),
      this.cachedMaterial("slime-recess", () => this.palette.flat(0x0a1414, { transparent: true, opacity: 0.72 })),
    );
    recess.rotation.x = -Math.PI / 2;
    recess.position.y = 0.025;
    group.add(recess);

    const pool = new THREE.Mesh(
      this.cachedGeometry(`slime:${key}`, () => new THREE.CircleGeometry(radius, 22)),
      this.cachedMaterial(`slime-fill:${variant}`, () => this.palette.flat(outerColor, { transparent: true, opacity: 0.56 })),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.031;
    group.add(pool);

    // Bright glowing toxic core + concentric bio-vein ring
    const core = new THREE.Mesh(
      this.cachedGeometry(`slime-core:${key}`, () => new THREE.CircleGeometry(radius * 0.45, 16)),
      this.cachedMaterial(`slime-core:${variant}`, () => this.palette.flat(innerColor, { transparent: true, opacity: 0.78 })),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.036;
    group.add(core);

    const rim = new THREE.Mesh(
      this.cachedGeometry(`slime-rim:${key}`, () => new THREE.RingGeometry(Math.max(0.1, radius - 0.1), radius + 0.02, 24)),
      this.cachedMaterial(`slime-rim:${variant}`, () =>
        this.palette.flat(innerColor, { transparent: true, opacity: variant === "toxic" ? 0.92 : 0.6, side: THREE.DoubleSide }),
      ),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.042;
    group.add(rim);

    // Three glossy bio-bubbles sitting on the surface
    const bubbleGeo = this.cachedGeometry("slime-bubble", () => new THREE.SphereGeometry(0.11, 8, 6));
    const bubbleMat = this.cachedMaterial(`slime-bubble:${variant}`, () => this.palette.flat(innerColor, { transparent: true, opacity: 0.9 }));
    for (let i = 0; i < 3; i += 1) {
      const a = i * 2.15 + 0.4;
      const dist = radius * (0.28 + i * 0.16);
      const bubble = new THREE.Mesh(bubbleGeo, bubbleMat);
      bubble.scale.setScalar(0.75 + (i % 2) * 0.5);
      bubble.position.set(Math.cos(a) * dist, 0.06, Math.sin(a) * dist);
      group.add(bubble);
    }
    return group;
  }

  /**
   * Orbiting golden-cyan ring and chevrons attached to Kai while Overdrive is active.
   */
  createOverdriveAura(): THREE.Group {
    const group = new THREE.Group();
    group.name = "overdrive-aura";

    const outerRing = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.95, 1.12, 36)),
      this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.06;
    group.add(outerRing);

    const innerRing = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.76, 0.84, 32)),
      this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.065;
    group.add(innerRing);

    const shardGeometry = this.own(new THREE.ConeGeometry(0.12, 0.42, 3));
    const shardMaterial = this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.95 });
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      const shard = new THREE.Mesh(shardGeometry, shardMaterial);
      shard.position.set(Math.cos(angle) * 1.18, 0.35 + (i % 2) * 0.25, Math.sin(angle) * 1.18);
      shard.rotation.z = -angle + Math.PI / 2;
      shard.rotation.x = Math.PI / 2;
      group.add(shard);
    }

    group.visible = false;
    return group;
  }

  createExtractionZone() {
    const group = new THREE.Group();

    const ring = new THREE.Mesh(
      this.own(new THREE.RingGeometry(3.08, 3.2, 40)),
      this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    const innerRing = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.22, 0.3, 24)),
      this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.052;
    group.add(innerRing);

    // Beam pillars mark the zone from across the arena.
    const pillarGeometry = this.own(new THREE.CylinderGeometry(0.065, 0.065, 3.8, 6));
    const pillarMaterial = this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.5 });
    for (let i = 0; i < 3; i += 1) {
      const angle = (i / 3) * Math.PI * 2;
      const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
      pillar.position.set(Math.cos(angle) * 3.1, 1.9, Math.sin(angle) * 3.1);
      group.add(pillar);
    }
    return group;
  }

  // -------------------------------------------------------------- characters

  createPlayer(): CharacterRig {
    const rig = this.characters.createCharacter("player");

    // Bright selection ring — the fastest way to find yourself in a crowd.
    const ring = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.7, 0.77, 32)),
      this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.renderOrder = -1;
    rig.root.add(ring);

    return rig;
  }

  createEnemy(type: EnemyId, definition: EnemyDefinition, isElite = false): CharacterRig {
    void definition;
    const rig = this.characters.createCharacter(type);

    if (type === "juggernaut") {
      const ring = new THREE.Mesh(
        this.cachedGeometry("ring:juggernaut", () => new THREE.RingGeometry(1.5, 1.85, 44)),
        this.cachedMaterial("ring:juggernaut", () =>
          this.palette.flat(COMIC.juggernaut, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
        ),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      rig.root.add(ring);
    } else if (isElite) {
      // Gold ring plus gold trim so elites stand out from their own archetype.
      const ring = new THREE.Mesh(
        this.cachedGeometry(`ring:elite:${rig.scale.toFixed(3)}`, () =>
          new THREE.RingGeometry(0.62 * rig.scale, 0.82 * rig.scale, 28),
        ),
        this.cachedMaterial("ring:elite", () =>
          this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
        ),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.035;
      rig.root.add(ring);
    }

    return rig;
  }

  /**
   * Floating health bar for an enemy.
   *
   * Two flat quads that always face the camera. Only shown once an enemy has
   * been hurt, so a full-strength crowd stays uncluttered — the bar is there to
   * answer "is this one nearly down?", which only matters after you shoot it.
   */
  createEnemyHealthBar(width: number): THREE.Group {
    const group = new THREE.Group();
    const key = width.toFixed(3);

    const back = new THREE.Mesh(
      this.cachedGeometry(`hp-back:${key}`, () => new THREE.PlaneGeometry(width, 0.16)),
      this.cachedMaterial("hp-back", () => this.palette.flat(COMIC.ink)),
    );
    group.add(back);

    const fill = new THREE.Mesh(
      this.cachedGeometry(`hp-fill:${key}`, () => new THREE.PlaneGeometry(width - 0.06, 0.1)),
      this.cachedMaterial("hp-fill", () => this.palette.flat(COMIC.juggernaut)),
    );
    fill.position.z = 0.001;
    fill.name = "hp-fill";
    group.add(fill);

    group.visible = false;
    return group;
  }

  /**
   * High-contrast ground marker for the enemy selected by mobile auto-aim.
   *
   * The marker is deliberately geometric rather than glow-based: it remains
   * legible through the comic post-process and on lower-resolution screens,
   * while the open centre leaves the enemy silhouette unobstructed.
   */
  createAutoAimIndicator(): THREE.Group {
    const group = new THREE.Group();
    group.name = "mobile-auto-aim-indicator";

    const wash = new THREE.Mesh(
      this.own(new THREE.CircleGeometry(0.82, 32)),
      this.palette.flat(COMIC.electric, {
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
      }),
    );
    wash.rotation.x = -Math.PI / 2;
    group.add(wash);

    const ring = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.78, 1, 32)),
      this.palette.flat(COMIC.electric, {
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.name = "auto-aim-ring";
    group.add(ring);

    const bracketGeometry = this.own(new THREE.PlaneGeometry(0.46, 0.12));
    const bracketMaterial = this.palette.flat(COMIC.hazardYellow, {
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    });
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2;
      const bracket = new THREE.Mesh(bracketGeometry, bracketMaterial);
      bracket.rotation.set(-Math.PI / 2, 0, angle);
      bracket.position.set(Math.cos(angle) * 1.05, 0.015, Math.sin(angle) * 1.05);
      group.add(bracket);
    }

    group.visible = false;
    return group;
  }

  animateCharacter(
    rig: CharacterRig,
    dt: number,
    speed: number,
    attacking: boolean,
    hit: number,
    isChilled = false,
    isBurning = false,
  ) {
    this.characters.animate(rig, dt, speed, attacking, hit, isChilled, isBurning);
  }

  applyWeaponRecoil(rig: CharacterRig, intensity = 1) {
    rig.recoilZ = Math.min(0.1, rig.recoilZ + 0.05 * intensity);
    rig.recoilPitch = Math.min(0.12, rig.recoilPitch + 0.06 * intensity);
  }

  setPlayerWeapon(rig: CharacterRig, weaponId: WeaponId) {
    this.characters.setWeapon(rig, weaponId);
  }

  beginDeath(rig: CharacterRig) { this.characters.beginDeath(rig); }

  disposeCharacter(rig: CharacterRig) {
    if (rig.disposed) return;
    // Must go through the factory so the AnimationMixer is stopped; a leaked
    // mixer keeps updating a detached skeleton every frame.
    this.characters.disposeCharacter(rig);
  }

  // ---------------------------------------------------------------- fx meshes

  createMuzzleFlashMesh(color = COMIC.hazardYellow) {
    const group = new THREE.Group();

    // Four-point comic star rather than a soft glow sprite.
    const star = new THREE.Mesh(
      this.cachedGeometry("flash-star", () => this.createStarGeometry(0.42, 0.16, 4)),
      this.cachedMaterial(`flash:${color}`, () => this.palette.flat(color)),
    );
    group.add(star);

    const core = new THREE.Mesh(
      this.cachedGeometry("flash-core", () => new THREE.CircleGeometry(0.13, 10)),
      this.cachedMaterial("flash-core", () => this.palette.flat(COMIC.paper)),
    );
    core.position.z = 0.01;
    group.add(core);
    return group;
  }

  private createStarGeometry(outer: number, inner: number, points: number) {
    const shape = new THREE.Shape();
    const total = points * 2;
    for (let i = 0; i < total; i += 1) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }

  createRadialSpeedLinesMesh(color = COMIC.electric): THREE.Group {
    const group = new THREE.Group();
    // Faded by the engine, so it cannot be shared with another live burst.
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    markTransient(group, { materials: [material] });
    const geometry = this.cachedGeometry("speed-line", () => new THREE.PlaneGeometry(0.09, 1.5));

    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      const line = new THREE.Mesh(geometry, material);
      line.position.set(Math.cos(angle) * 1.5, 0.6, Math.sin(angle) * 1.5);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -angle;
      group.add(line);
    }
    return group;
  }

  createShockwaveMesh(radius: number, color = COMIC.juggernaut): THREE.Group {
    const group = new THREE.Group();
    const key = radius.toFixed(2);
    const ringMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const spikeMaterial = new THREE.MeshBasicMaterial({ color: COMIC.paper, transparent: true, opacity: 0.8 });
    markTransient(group, { materials: [ringMaterial, spikeMaterial] });

    const ring = new THREE.Mesh(
      this.cachedGeometry(`shock-ring:${key}`, () => new THREE.RingGeometry(radius * 0.72, radius, 40)),
      ringMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    group.add(ring);

    // Jagged spikes turn a plain ring into a comic impact burst.
    const spikeGeometry = this.cachedGeometry(`shock-spike:${key}`, () =>
      new THREE.ConeGeometry(radius * 0.12, radius * 0.4, 3),
    );
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      const spike = new THREE.Mesh(spikeGeometry, spikeMaterial);
      spike.position.set(Math.cos(angle) * radius, 0.12, Math.sin(angle) * radius);
      spike.rotation.z = -angle + Math.PI / 2;
      spike.rotation.x = Math.PI / 2;
      group.add(spike);
    }
    return group;
  }

  createChainLightningMesh(points: THREE.Vector3[], color = COMIC.electric): THREE.LineSegments {
    const vertices: number[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      // Break each span into jagged segments so the arc looks drawn, not straight.
      const segments = 5;
      let previous = from;
      for (let s = 1; s <= segments; s += 1) {
        const t = s / segments;
        const next = from.clone().lerp(to, t);
        if (s < segments) {
          next.x += THREE.MathUtils.randFloatSpread(0.55);
          next.y += THREE.MathUtils.randFloatSpread(0.45);
          next.z += THREE.MathUtils.randFloatSpread(0.55);
        }
        vertices.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
        previous = next;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const lines = new THREE.LineSegments(geometry, material);
    // Every arc is a different shape, so the geometry is genuinely one-off.
    markTransient(lines, { geometries: [geometry], materials: [material] });
    return lines;
  }

  createEliteShieldMesh(radius = 1.15): THREE.Mesh {
    const shield = new THREE.Mesh(
      this.cachedGeometry(`shield:${radius.toFixed(3)}`, () => new THREE.SphereGeometry(radius, 14, 11)),
      this.cachedMaterial("shield", () => this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.32 })),
    );
    shield.position.y = radius * 0.85;
    shield.raycast = () => {};
    return shield;
  }

  /**
   * Attack telegraph. Read at a glance from the top-down camera over a busy
   * floor, so it is a filled warning disc under a heavy ink rim rather than a
   * thin translucent hoop — the first version was invisible in a crowd.
   *
   * One is created for every melee swing in the game, so everything here is
   * cached: the radii come from a handful of fixed attack ranges.
   */
  createTelegraphAnnulus(inner: number, outer: number) {
    return new THREE.Mesh(this.cachedGeometry(`annulus:${inner}:${outer}`, () => new THREE.RingGeometry(inner, outer, 64)),
      this.cachedMaterial("annulus:warning", () => this.palette.flat(0xef706b, { transparent: true, opacity: 0.22, side: THREE.DoubleSide })));
  }

  createTelegraphCircle(radius = 4.5): THREE.Group {
    const group = new THREE.Group();
    const key = radius.toFixed(3);

    const fill = new THREE.Mesh(
      this.cachedGeometry(`tele-fill:${key}`, () => new THREE.CircleGeometry(radius, 32)),
      // Kept low: a dozen overlapping discs in a swarm must not become a soup.
      this.cachedMaterial("tele-fill", () =>
        this.palette.flat(0xef706b, { transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
      ),
    );
    fill.name = "telegraph-fill";
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.05;
    group.add(fill);

    const rim = new THREE.Mesh(
      this.cachedGeometry(`tele-rim:${key}`, () => new THREE.RingGeometry(Math.max(0, radius - 0.08), radius, 32)),
      this.cachedMaterial("tele-rim", () =>
        this.palette.flat(0xef706b, { transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      ),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.06;
    group.add(rim);

    const ink = new THREE.Mesh(
      this.cachedGeometry(`tele-ink:${key}`, () => new THREE.RingGeometry(radius, radius + 0.03, 32)),
      this.cachedMaterial("tele-ink", () =>
        this.palette.flat(COMIC.ink, { transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      ),
    );
    ink.rotation.x = -Math.PI / 2;
    ink.position.y = 0.061;
    group.add(ink);

    return group;
  }

  /**
   * Flat silhouette snapshot of the player used for dash trails. Copies world
   * transforms so the ghost freezes the exact pose it was cloned from.
   */
  createDashGhost(playerGroup: THREE.Group): THREE.Group {
    const ghost = new THREE.Group();
    // Faded per ghost; the geometry is the player's own and is never freed here.
    const material = new THREE.MeshBasicMaterial({ color: COMIC.electric, transparent: true, opacity: 0.55 });
    markTransient(ghost, { materials: [material] });

    playerGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.name === "ink-shell") return;
      const clone = new THREE.Mesh(child.geometry, material);
      child.getWorldPosition(clone.position);
      child.getWorldQuaternion(clone.quaternion);
      child.getWorldScale(clone.scale);
      ghost.add(clone);
    });

    return ghost;
  }

  /**
   * Tactical laser sight extending from Kai's muzzle to the first cover/enemy hit.
   */
  createLaserSight(): { group: THREE.Group; beam: THREE.Mesh; dot: THREE.Mesh; beamMaterial: THREE.MeshBasicMaterial; dotMaterial: THREE.MeshBasicMaterial } {
    const group = new THREE.Group();
    const beamMaterial = new THREE.MeshBasicMaterial({ color: COMIC.electric, transparent: true, opacity: 0.52 });
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xe6ffff, transparent: true, opacity: 0.95 });
    const beamGeo = this.own(new THREE.CylinderGeometry(0.014, 0.014, 1, 6));
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, 0.5);
    const beam = new THREE.Mesh(beamGeo, beamMaterial);
    const dot = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.085, 8, 6)), dotMaterial);
    group.add(beam, dot);
    return { group, beam, dot, beamMaterial, dotMaterial };
  }

  /**
   * Layered 3D plasma-comic fireball explosion (core flash + blazing shell + shock ring).
   */
  createFireballExplosion(radius = 2.6, color = COMIC.fire): THREE.Group {
    const group = new THREE.Group();
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff8d6, transparent: true, opacity: 0.96 });
    const outerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    markTransient(group, { materials: [coreMat, outerMat, ringMat] });

    const core = new THREE.Mesh(this.cachedGeometry("fireball-core", () => new THREE.IcosahedronGeometry(0.65, 1)), coreMat);
    core.position.y = 0.7;
    group.add(core);

    const outer = new THREE.Mesh(this.cachedGeometry("fireball-outer", () => new THREE.IcosahedronGeometry(1.15, 1)), outerMat);
    outer.position.y = 0.85;
    group.add(outer);

    const puffGeo = this.cachedGeometry("fireball-puff", () => new THREE.IcosahedronGeometry(0.45, 0));
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      const puff = new THREE.Mesh(puffGeo, outerMat);
      puff.position.set(Math.cos(a) * 0.75, 0.55 + (i % 2) * 0.45, Math.sin(a) * 0.75);
      group.add(puff);
    }

    const ring = new THREE.Mesh(
      this.cachedGeometry(`fireball-ring:${radius.toFixed(1)}`, () => new THREE.RingGeometry(radius * 0.65, radius, 32)),
      ringMat,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    group.add(ring);

    group.userData.baseScale = Math.max(0.7, radius / 2.6);
    return group;
  }

  createShellCasing(): THREE.Mesh {
    return new THREE.Mesh(
      this.cachedGeometry("shell-casing", () => new THREE.CylinderGeometry(0.022, 0.022, 0.11, 6)),
      this.cachedMaterial("shell-casing", () => this.palette.flat(0xffd260)),
    );
  }

  createFragGrenade(): THREE.Group {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      this.cachedGeometry("frag-body", () => new THREE.IcosahedronGeometry(0.22, 0)),
      this.cachedMaterial("frag-body", () => this.palette.toon(0x303f49)),
    );
    const band = new THREE.Mesh(
      this.cachedGeometry("frag-band", () => new THREE.TorusGeometry(0.2, 0.045, 6, 12)),
      this.cachedMaterial("frag-band", () => this.palette.flat(0xff5226)),
    );
    band.rotation.x = Math.PI / 2;
    group.add(body, band);
    return group;
  }

  /** Blazing plasma crescent arc for Cyber-Blade Slash & Teleport-Execute. */
  createBladeSlashArc(isExecute = false): THREE.Group {
    const group = new THREE.Group();
    const outerColor = isExecute ? COMIC.gold : COMIC.electric;
    const outerMat = new THREE.MeshBasicMaterial({ color: outerColor, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    markTransient(group, { materials: [outerMat, coreMat] });

    const radius = isExecute ? 3.2 : 2.6;
    const arcOuter = new THREE.Mesh(
      this.cachedGeometry(`blade-arc:${radius}`, () => new THREE.RingGeometry(radius * 0.56, radius, 26, 1, -Math.PI * 0.62, Math.PI * 1.24)),
      outerMat,
    );
    arcOuter.rotation.x = -Math.PI / 2;
    arcOuter.position.y = 1.05;
    group.add(arcOuter);

    const arcCore = new THREE.Mesh(
      this.cachedGeometry(`blade-core:${radius}`, () => new THREE.RingGeometry(radius * 0.78, radius * 0.94, 24, 1, -Math.PI * 0.52, Math.PI * 1.04)),
      coreMat,
    );
    arcCore.rotation.x = -Math.PI / 2;
    arcCore.position.y = 1.07;
    group.add(arcCore);

    return group;
  }

  /** Pulsing golden execution ring shown under wounded enemies ready to be teleport-slashed. */
  createExecuteMarker(radius: number): THREE.Group {
    const group = new THREE.Group();
    const key = radius.toFixed(2);
    const ring = new THREE.Mesh(
      this.cachedGeometry(`exec-ring:${key}`, () => new THREE.RingGeometry(radius * 0.95, radius * 1.18, 28)),
      this.cachedMaterial("exec-ring", () => this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.95, side: THREE.DoubleSide })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    group.add(ring);

    const pip = new THREE.Mesh(
      this.cachedGeometry("exec-pip", () => new THREE.OctahedronGeometry(0.22, 0)),
      this.cachedMaterial("exec-pip", () => this.palette.flat(COMIC.gold)),
    );
    pip.position.y = 2.15;
    pip.name = "exec-pip";
    group.add(pip);
    return group;
  }

  /** Deployable Twin-Barrel Orbital Auto-Turret with rotating head and laser eye. */
  createAutoTurret(): THREE.Group {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const base = new THREE.Mesh(
      this.cachedGeometry("turret-base", () => new THREE.CylinderGeometry(0.55, 0.72, 0.42, 8)),
      this.cachedMaterial("turret-base", () => this.palette.toon(COMIC.steel)),
    );
    base.position.y = 0.21;
    inkInPlace(base, ink, 0.05);
    group.add(base);

    const ring = new THREE.Mesh(
      this.cachedGeometry("turret-ring", () => new THREE.RingGeometry(0.75, 0.88, 24)),
      this.cachedMaterial("turret-ring", () => this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.75, side: THREE.DoubleSide })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);

    const head = new THREE.Group();
    head.name = "turret-head";
    head.position.y = 0.72;

    const housing = new THREE.Mesh(
      this.cachedGeometry("turret-head", () => new RoundedBoxGeometry(0.68, 0.48, 0.85, 2, 0.06)),
      this.cachedMaterial("turret-head", () => this.palette.toon(0x284354)),
    );
    inkInPlace(housing, ink, 0.05);
    head.add(housing);

    const barrelGeo = this.cachedGeometry("turret-barrel", () => new THREE.CylinderGeometry(0.06, 0.06, 0.82, 8));
    const barrelMat = this.cachedMaterial("turret-barrel", () => this.palette.toon(0x9fb8c9));
    for (const side of [-0.18, 0.18]) {
      const barrel = new THREE.Mesh(barrelGeo, barrelMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(side, 0.04, 0.65);
      head.add(barrel);
    }

    const sensor = new THREE.Mesh(
      this.cachedGeometry("turret-eye", () => new THREE.BoxGeometry(0.28, 0.14, 0.12)),
      this.cachedMaterial("turret-eye", () => this.palette.flat(COMIC.electric)),
    );
    sensor.position.set(0, 0.24, 0.32);
    head.add(sensor);

    group.add(head);
    return group;
  }

  /** Deployable Tesla Shock Pylon that arcs lightning and links laser fences to nearby pylons. */
  createTeslaPylon(): THREE.Group {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();

    const base = new THREE.Mesh(
      this.cachedGeometry("pylon-base", () => new THREE.CylinderGeometry(0.45, 0.65, 0.4, 8)),
      this.cachedMaterial("pylon-base", () => this.palette.toon(COMIC.steel)),
    );
    base.position.y = 0.2;
    inkInPlace(base, ink, 0.05);
    group.add(base);

    const spire = new THREE.Mesh(
      this.cachedGeometry("pylon-spire", () => new THREE.CylinderGeometry(0.14, 0.24, 1.85, 8)),
      this.cachedMaterial("pylon-spire", () => this.palette.toon(0x273d4d)),
    );
    spire.position.y = 1.15;
    inkInPlace(spire, ink, 0.05);
    group.add(spire);

    const coilGeo = this.cachedGeometry("pylon-coil", () => new THREE.TorusGeometry(0.32, 0.055, 6, 16));
    const coilMat = this.cachedMaterial("pylon-coil", () => this.palette.flat(COMIC.electric));
    for (const y of [0.9, 1.35, 1.8]) {
      const coil = new THREE.Mesh(coilGeo, coilMat);
      coil.rotation.x = Math.PI / 2;
      coil.position.y = y;
      group.add(coil);
    }

    const orb = new THREE.Mesh(
      this.cachedGeometry("pylon-orb", () => new THREE.OctahedronGeometry(0.3, 1)),
      this.cachedMaterial("pylon-orb", () => this.palette.flat(0xb8ffff)),
    );
    orb.position.y = 2.25;
    orb.name = "pylon-orb";
    group.add(orb);

    const aura = new THREE.Mesh(
      this.cachedGeometry("pylon-aura", () => new THREE.RingGeometry(0.65, 0.78, 24)),
      this.cachedMaterial("pylon-aura", () => this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.7, side: THREE.DoubleSide })),
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.04;
    group.add(aura);

    return group;
  }

  /** Glowing dual-rail electric laser fence linking two Tesla Pylons. */
  createLaserFenceBeam(from: THREE.Vector3, to: THREE.Vector3): THREE.Group {
    const group = new THREE.Group();
    const delta = to.clone().sub(from);
    const length = Math.max(0.1, delta.length());
    const midpoint = from.clone().add(to).multiplyScalar(0.5);
    const angle = Math.atan2(delta.x, delta.z);

    const railMat = this.cachedMaterial("fence-rail", () => this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.92 }));
    const wallMat = this.cachedMaterial("fence-wall", () => this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.22, side: THREE.DoubleSide }));

    const railGeo = new THREE.CylinderGeometry(0.045, 0.045, length, 6);
    railGeo.rotateX(Math.PI / 2);
    const wallGeo = new THREE.PlaneGeometry(length, 1.35);
    wallGeo.rotateY(Math.PI / 2);
    markTransient(group, { geometries: [railGeo, wallGeo] });

    for (const y of [0.6, 1.35, 2.0]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.y = y;
      group.add(rail);
    }
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 1.25;
    group.add(wall);

    group.position.set(midpoint.x, 0, midpoint.z);
    group.rotation.y = angle;
    return group;
  }

  /** Dramatic sky-column laser telegraph + descending orbital drop pod. */
  createOrbitalSkyBeam(color: number): THREE.Group {
    const group = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    markTransient(group, { materials: [beamMat, ringMat] });

    const beam = new THREE.Mesh(this.cachedGeometry("orbital-beam", () => new THREE.CylinderGeometry(0.45, 1.15, 24, 14, 1, true)), beamMat);
    beam.position.y = 12;
    group.add(beam);

    const ring = new THREE.Mesh(this.cachedGeometry("orbital-ring", () => new THREE.RingGeometry(1.5, 1.85, 32)), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    group.add(ring);
    return group;
  }

  createOrbitalDropPod(color: number): THREE.Group {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();
    const pod = new THREE.Mesh(
      this.cachedGeometry("orbital-pod", () => new THREE.CylinderGeometry(0.72, 0.95, 1.65, 8)),
      this.cachedMaterial("orbital-pod", () => this.palette.toon(0x283a47)),
    );
    pod.position.y = 0.82;
    inkInPlace(pod, ink, 0.04);
    group.add(pod);

    const glowMat = new THREE.MeshBasicMaterial({ color });
    markTransient(group, { materials: [glowMat] });
    const beacon = new THREE.Mesh(this.cachedGeometry("orbital-pod-cap", () => new THREE.OctahedronGeometry(0.42, 0)), glowMat);
    beacon.position.y = 1.95;
    beacon.name = "pod-beacon";
    group.add(beacon);

    const halo = new THREE.Mesh(
      this.cachedGeometry("orbital-pod-halo", () => new THREE.RingGeometry(1.15, 1.38, 28)),
      this.cachedMaterial("orbital-pod-halo", () => this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.85, side: THREE.DoubleSide })),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);
    return group;
  }

  /** Massive hyper-velocity screen-splitting Railcannon beam. */
  createRailgunBeam(from: THREE.Vector3, to: THREE.Vector3, color = COMIC.electric): THREE.Group {
    const group = new THREE.Group();
    const delta = to.clone().sub(from);
    const length = Math.max(0.2, delta.length());
    const coreGeo = new THREE.CylinderGeometry(0.11, 0.11, length, 8);
    coreGeo.rotateX(Math.PI / 2);
    const glowGeo = new THREE.CylinderGeometry(0.34, 0.34, length, 8);
    glowGeo.rotateX(Math.PI / 2);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98 });
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.65 });
    markTransient(group, { geometries: [coreGeo, glowGeo], materials: [coreMat, glowMat] });

    const core = new THREE.Mesh(coreGeo, coreMat);
    const glow = new THREE.Mesh(glowGeo, glowMat);
    group.add(glow, core);
    group.position.copy(from).addScaledVector(delta, 0.5);
    group.lookAt(to);
    group.userData.muzzle = true; // prevent radial scaling on updateEffects
    return group;
  }

  /** Spinning glowing Ripper Sawblade projectile. */
  createSawbladeProjectile(): THREE.Group {
    const group = new THREE.Group();
    const disc = new THREE.Mesh(
      this.cachedGeometry("sawblade-disc", () => new THREE.CylinderGeometry(0.52, 0.52, 0.08, 12)),
      this.cachedMaterial("sawblade-disc", () => this.palette.flat(COMIC.gold)),
    );
    const core = new THREE.Mesh(
      this.cachedGeometry("sawblade-core", () => new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8)),
      this.cachedMaterial("sawblade-core", () => this.palette.flat(0xffffff)),
    );
    group.add(disc, core);
    return group;
  }

  /**
   * 3D atmospheric particle field tailored per arena (fire embers, storm rain, welding sparks, ash).
   */
  createWeatherField(identity: ArenaTheme["identity"]): THREE.Points {
    const count = 150;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 38;
      positions[i * 3 + 1] = Math.random() * 9 + 0.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 38;
    }
    const geometry = this.own(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const color =
      identity === "floodbay"
        ? 0x7ae8ff
        : identity === "garage"
          ? 0xffbd4a
          : identity === "rooftop"
            ? 0xd6c8bc
            : 0xff8c38;
    const material = new THREE.PointsMaterial({
      color,
      size: identity === "floodbay" ? 0.11 : 0.14,
      transparent: true,
      opacity: identity === "floodbay" ? 0.55 : 0.78,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.userData.weatherIdentity = identity;
    return points;
  }

  // ------------------------------------------------------------------ decals

  addBloodDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.addDecal(scene, position, scale * 1.9, this.bloodMaterial);
  }

  addAcidDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.addDecal(scene, position, scale * 2.2, this.acidMaterial);
  }

  addScorchDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.addDecal(scene, position, scale * 2.8, this.scorchMaterial);
  }

  private addDecal(scene: THREE.Scene, position: THREE.Vector3, size: number, material: THREE.Material) {
    const decal = new THREE.Mesh(this.decalGeometry, material);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    decal.scale.set(size, size, 1);
    decal.position.set(position.x, 0.04 + this.decals.length * 0.0006, position.z);
    decal.renderOrder = 1;
    scene.add(decal);
    this.decals.push(decal);

    // Cap the decal count so long runs don't accumulate unbounded draw calls.
    while (this.decals.length > 48) {
      const oldest = this.decals.shift();
      oldest?.removeFromParent();
    }
  }

  /** Wipe the gore. Called when the arena changes, so the floor of the new
   *  layout does not inherit the last one's splatter at the same coordinates. */
  clearDecals() {
    for (const decal of this.decals) decal.removeFromParent();
    this.decals = [];
  }

  // ----------------------------------------------------------------- cleanup

  /**
   * Detach an object and free whatever it owns outright.
   *
   * Shared geometry and materials are left alone; only resources tagged with
   * `markTransient` are disposed, since those were made for this one object.
   */
  disposeObject(root: THREE.Object3D) {
    root.removeFromParent();
    root.traverse((child) => {
      const owned = child.userData.transient as TransientResources | undefined;
      if (!owned) return;
      for (const geometry of owned.geometries ?? []) geometry.dispose();
      for (const material of owned.materials ?? []) material.dispose();
      delete child.userData.transient;
    });
  }

  dispose(scene: THREE.Scene) {
    if (this.disposed) return;
    this.disposed = true;
    this.decals = [];
    scene.clear();
    this.characters.dispose();
    this.environment.dispose();
    this.palette.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.textures = [];
    this.geometries = [];
    this.geometryCache.clear();
    this.materialCache.clear();
    this.decalGeometry.dispose();
    void this.renderer;
  }
}

export type { CharacterKind };
