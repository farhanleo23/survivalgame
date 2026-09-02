import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { COMIC, ComicPalette, inkInPlace, inkOutline } from "./comic";
import { CharacterFactory, type CharacterKind, type CharacterRig } from "./characters";
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

  constructor(private renderer: THREE.WebGLRenderer) {
    this.characters = new CharacterFactory(this.palette);
    this.bloodMaterial = this.palette.flat(COMIC.blood, { transparent: true, opacity: 0.9 });
    this.bloodMaterial.map = this.track(this.createSplatTexture("#d11a4a", "#8c0f30"));
    this.acidMaterial = this.palette.flat(COMIC.acid, { transparent: true, opacity: 0.9 });
    this.acidMaterial.map = this.track(this.createSplatTexture("#6dff2f", "#2f9410"));
    this.bloodMaterial.depthWrite = false;
    this.acidMaterial.depthWrite = false;
  }

  /** Resolves once every character model is decoded and cached. */
  async ready() {
    try {
      await this.characters.preload();
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

  /** Painted concrete: bright slab colour with inked seams and speckle. */
  private createFloorTexture(theme: ArenaTheme): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = theme.floorLight;
      ctx.fillRect(0, 0, 256, 256);

      ctx.fillStyle = theme.floorDark;
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillRect(128, 128, 128, 128);

      // Bold slab seams — the comic equivalent of grout lines.
      ctx.strokeStyle = theme.seam;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(128, 0);
      ctx.lineTo(128, 256);
      ctx.moveTo(0, 128);
      ctx.lineTo(256, 128);
      ctx.stroke();

      ctx.fillStyle = theme.speckle;
      for (let i = 0; i < 90; i += 1) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        ctx.fillRect(x, y, 2 + Math.random() * 3, 2 + Math.random() * 3);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(11, 11);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** Diagonal hazard stripes, used on every barrier and kerb in the depot. */
  private createHazardTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffc61e";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#191324";
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

  // ------------------------------------------------------------------ ground

  createGround(theme: ArenaTheme) {
    const group = new THREE.Group();

    const floorMaterial = this.palette.toon(0xffffff);
    floorMaterial.map = this.track(this.createFloorTexture(theme));
    const floor = new THREE.Mesh(this.own(new THREE.PlaneGeometry(46, 46)), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    // Painted centre pad. Full-strength paint, not the old 8%-opacity ghosting.
    const padOuter = new THREE.Mesh(
      this.own(new THREE.RingGeometry(6.8, 7.2, 64)),
      this.palette.flat(theme.paint, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    padOuter.rotation.x = -Math.PI / 2;
    padOuter.position.y = 0.02;
    group.add(padOuter);

    const padInner = new THREE.Mesh(
      this.own(new THREE.RingGeometry(3.5, 3.78, 48)),
      this.palette.flat(COMIC.hazardStripe, { transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    padInner.rotation.x = -Math.PI / 2;
    padInner.position.y = 0.021;
    group.add(padInner);

    const tickMaterial = this.palette.flat(COMIC.paper, { transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const tickGeometry = this.own(new THREE.PlaneGeometry(0.42, 1.9));
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * Math.PI) / 2;
      const tick = new THREE.Mesh(tickGeometry, tickMaterial);
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = angle;
      tick.position.set(Math.cos(angle) * 5.3, 0.022, Math.sin(angle) * 5.3);
      group.add(tick);
    }

    // Hazard kerbs marking the playable boundary.
    const hazardMaterial = this.palette.flat(0xffffff, { side: THREE.DoubleSide });
    hazardMaterial.map = this.track(this.createHazardTexture());
    hazardMaterial.map.repeat.set(24, 1);
    const stripeGeometry = this.own(new THREE.PlaneGeometry(37, 0.9));
    for (const [x, z, rotation] of [
      [0, -18.2, 0],
      [0, 18.2, 0],
      [-18.2, 0, Math.PI / 2],
      [18.2, 0, Math.PI / 2],
    ] as const) {
      const stripe = new THREE.Mesh(stripeGeometry, hazardMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = rotation;
      stripe.position.set(x, 0.023, z);
      group.add(stripe);
    }

    // Lane guides give the eye some structure across the open middle.
    const laneMaterial = this.palette.flat(COMIC.paper, { transparent: true, opacity: 0.28 });
    const laneGeometry = this.own(new THREE.PlaneGeometry(0.16, 2.6));
    for (let i = -3; i <= 3; i += 1) {
      for (let j = -2; j <= 2; j += 1) {
        if (Math.abs(i) < 2 && Math.abs(j) < 2) continue;
        const lane = new THREE.Mesh(laneGeometry, laneMaterial);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(i * 4.6, 0.019, j * 6.2);
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
    const ink = this.palette.outlineMaterial();

    // Distant silhouetted skyline: flat unlit blocks that read as backdrop art.
    const skylineMaterial = this.palette.flat(theme.skyline);
    const skylineGeometry = this.own(new THREE.BoxGeometry(1, 1, 1));
    for (let i = 0; i < 26; i += 1) {
      const angle = (i / 26) * Math.PI * 2;
      const distance = 30 + Math.random() * 9;
      const height = 6 + Math.random() * 15;
      const building = new THREE.Mesh(skylineGeometry, skylineMaterial);
      building.position.set(Math.cos(angle) * distance, height / 2, Math.sin(angle) * distance);
      building.scale.set(3 + Math.random() * 4, height, 3 + Math.random() * 4);
      building.rotation.y = Math.random() * Math.PI;
      scene.add(building);
    }

    // Overhead gantry frames the arena and casts long graphic shadows.
    const beamMaterial = this.palette.toon(COMIC.rust);
    const beamGeometry = this.own(new RoundedBoxGeometry(40, 0.55, 0.55, 2, 0.06));
    for (const z of [-13, 13]) {
      const beam = new THREE.Mesh(beamGeometry, beamMaterial);
      beam.position.set(0, 7.4, z);
      inkInPlace(beam, ink, 0.05);
      scene.add(beam);
    }
  }

  // ------------------------------------------------------------------- props

  createDepotStructure(width: number, depth: number, colorVariant = COMIC.steel) {
    const group = new THREE.Group();
    const ink = this.palette.outlineMaterial();
    const height = 2.3;

    const shell = inkOutline(
      this.own(new RoundedBoxGeometry(width, height, depth, 3, 0.08)),
      this.palette.toon(colorVariant),
      ink,
      0.022,
    );
    shell.position.y = height / 2;
    group.add(shell);

    const roof = new THREE.Mesh(
      this.own(new RoundedBoxGeometry(width * 1.08, 0.28, depth * 1.08, 2, 0.05)),
      this.palette.toon(COMIC.hazardStripe),
    );
    roof.position.y = height + 0.1;
    inkInPlace(roof, ink, 0.03);
    group.add(roof);

    // Lit windows punch holes in the mass so it doesn't read as a solid slab.
    const windowMaterial = this.palette.flat(COMIC.hazardYellow);
    const windowGeometry = this.own(new THREE.PlaneGeometry(0.42, 0.55));
    for (let i = -1; i <= 1; i += 1) {
      const pane = new THREE.Mesh(windowGeometry, windowMaterial);
      pane.position.set(i * width * 0.28, height * 0.62, depth / 2 + 0.01);
      group.add(pane);
    }

    return group;
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
      this.own(new THREE.CylinderGeometry(0.42, 0.42, 1.12, 14)),
      this.palette.toon(COMIC.hazardStripe),
    );
    body.position.y = 0.56;
    inkInPlace(body, ink, 0.05);
    group.add(body);

    const bandGeometry = this.own(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14));
    const bandMaterial = this.palette.toon(COMIC.hazardYellow);
    for (const y of [0.28, 0.84]) {
      const band = new THREE.Mesh(bandGeometry, bandMaterial);
      band.position.y = y;
      group.add(band);
    }

    // Hazard diamond marks it as shootable.
    const mark = new THREE.Mesh(this.own(new THREE.PlaneGeometry(0.3, 0.3)), this.palette.flat(COMIC.ink));
    mark.position.set(0, 0.6, 0.43);
    mark.rotation.z = Math.PI / 4;
    group.add(mark);
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

    const lens = new THREE.Mesh(this.own(new THREE.PlaneGeometry(0.8, 0.5)), this.palette.flat(color));
    lens.position.set(0, 4.9, 0.44);
    lens.rotation.x = 0.45;
    group.add(lens);
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

    const fire = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.5, 1.0, 9)), this.palette.flat(COMIC.fire));
    fire.position.y = 2.75;
    group.add(fire);

    const flameTip = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.26, 0.6, 8)), this.palette.flat(COMIC.hazardYellow));
    flameTip.position.y = 2.95;
    group.add(flameTip);
    return group;
  }

  createSlimePool(radius = 1.4) {
    const group = new THREE.Group();
    const key = radius.toFixed(2);

    const pool = new THREE.Mesh(
      this.cachedGeometry(`slime:${key}`, () => new THREE.CircleGeometry(radius, 20)),
      this.cachedMaterial("slime-fill", () => this.palette.flat(COMIC.acid, { transparent: true, opacity: 0.85 })),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.03;
    group.add(pool);

    // Darker inner blob gives the puddle an inked edge instead of a soft one.
    const core = new THREE.Mesh(
      this.cachedGeometry(`slime-core:${key}`, () => new THREE.CircleGeometry(radius * 0.62, 16)),
      this.cachedMaterial("slime-core", () => this.palette.flat(0x2f9410, { transparent: true, opacity: 0.9 })),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.032;
    group.add(core);
    return group;
  }

  createExtractionZone() {
    const group = new THREE.Group();

    const ring = new THREE.Mesh(
      this.own(new THREE.RingGeometry(2.5, 3.2, 40)),
      this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    const innerRing = new THREE.Mesh(
      this.own(new THREE.RingGeometry(1.2, 1.6, 32)),
      this.palette.flat(COMIC.electric, { transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.052;
    group.add(innerRing);

    // Beam pillars mark the zone from across the arena.
    const pillarGeometry = this.own(new THREE.CylinderGeometry(0.14, 0.14, 5.5, 8));
    const pillarMaterial = this.palette.flat(COMIC.gold, { transparent: true, opacity: 0.5 });
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
      pillar.position.set(Math.cos(angle) * 2.85, 2.75, Math.sin(angle) * 2.85);
      group.add(pillar);
    }
    return group;
  }

  // -------------------------------------------------------------- characters

  createPlayer(): CharacterRig {
    const rig = this.characters.createCharacter("player");

    // Bright selection ring — the fastest way to find yourself in a crowd.
    const ring = new THREE.Mesh(
      this.own(new THREE.RingGeometry(0.72, 0.94, 32)),
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

  disposeCharacter(rig: CharacterRig) {
    if (rig.disposed) return;
    rig.disposed = true;
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
  createTelegraphCircle(radius = 4.5): THREE.Group {
    const group = new THREE.Group();
    const key = radius.toFixed(3);

    const fill = new THREE.Mesh(
      this.cachedGeometry(`tele-fill:${key}`, () => new THREE.CircleGeometry(radius, 32)),
      // Kept low: a dozen overlapping discs in a swarm must not become a soup.
      this.cachedMaterial("tele-fill", () =>
        this.palette.flat(COMIC.juggernaut, { transparent: true, opacity: 0.19, side: THREE.DoubleSide }),
      ),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.05;
    group.add(fill);

    const rim = new THREE.Mesh(
      this.cachedGeometry(`tele-rim:${key}`, () => new THREE.RingGeometry(radius * 0.82, radius, 32)),
      this.cachedMaterial("tele-rim", () =>
        this.palette.flat(COMIC.hazardYellow, { transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      ),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.06;
    group.add(rim);

    const ink = new THREE.Mesh(
      this.cachedGeometry(`tele-ink:${key}`, () => new THREE.RingGeometry(radius, radius * 1.09, 32)),
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

  // ------------------------------------------------------------------ decals

  addBloodDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.addDecal(scene, position, scale * 1.9, this.bloodMaterial);
  }

  addAcidDecal(scene: THREE.Scene, position: THREE.Vector3, scale = 1) {
    this.addDecal(scene, position, scale * 2.2, this.acidMaterial);
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
