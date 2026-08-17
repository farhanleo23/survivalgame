import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ENVIRONMENT_VISUAL, GRAPHICS_BUDGETS } from "../visual-registry";
import type { GraphicsQuality } from "../types";
import { enableShadows, material, mesh, rounded, seededRandom } from "./shared";

type CanvasMaps = { albedo: THREE.CanvasTexture; detail: THREE.CanvasTexture; roughness: THREE.CanvasTexture };

export class EnvironmentVisualSystem {
  readonly groundMaterial: THREE.MeshStandardMaterial;
  private maps: CanvasMaps;
  private quality: GraphicsQuality;
  private chainTexture: THREE.CanvasTexture;

  constructor(private renderer: THREE.WebGLRenderer, quality: GraphicsQuality) {
    this.quality = quality;
    this.maps = this.createGroundMaps();
    this.chainTexture = this.createChainTexture();
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0xb8c2bb,
      map: this.maps.albedo,
      bumpMap: this.maps.detail,
      bumpScale: 0.075,
      roughnessMap: this.maps.roughness,
      roughness: 0.94,
      metalness: 0.025,
    });
  }

  setQuality(quality: GraphicsQuality) {
    this.quality = quality;
  }

  createGround() {
    const root = new THREE.Group();
    root.name = "layered-depot-ground";
    const ground = mesh(new THREE.PlaneGeometry(44, 44, 12, 12), this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);

    const concrete = new THREE.MeshStandardMaterial({ color: 0x3f4945, roughness: 0.96, metalness: 0.02, polygonOffset: true, polygonOffsetFactor: -1 });
    for (const [x, z, width, depth, rotation] of [[-11.8, 9.8, 7.4, 5.2, -0.05], [12.4, -9.3, 7.8, 4.8, 0.04]] as const) {
      const slab = rounded(width, 0.025, depth, concrete, 0.08);
      slab.position.set(x, 0.025, z);
      slab.rotation.y = rotation;
      root.add(slab);
      const seam = material(0x222927, 0.98);
      for (let i = -1; i <= 1; i += 1) {
        const line = rounded(0.035, 0.012, depth * 0.92, seam, 0.008);
        line.position.set(x + i * width / 3, 0.045, z);
        line.rotation.y = rotation;
        root.add(line);
      }
    }

    this.addEvacuationRing(root);
    this.addRoadMarkings(root);
    this.addSurfaceDecals(root);
    this.addPuddles(root);
    this.addDrain(root, -2.8, 8.3, 0.15);
    this.addDrain(root, 9.8, -6.6, -0.2);
    this.batchStaticMeshes(root);
    return root;
  }

  addPerimeter(scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name = "batched-perimeter";
    const steel = material(ENVIRONMENT_VISUAL.palette.steel, 0.42, 0.78);
    const fenceMaterial = new THREE.MeshStandardMaterial({
      color: 0x879a91,
      map: this.chainTexture,
      alphaMap: this.chainTexture,
      transparent: true,
      opacity: 0.66,
      alphaTest: 0.22,
      side: THREE.DoubleSide,
      metalness: 0.62,
      roughness: 0.5,
    });
    const sides: Array<[number, number, number]> = [[0, -20.25, 0], [0, 20.25, 0], [-20.25, 0, Math.PI / 2], [20.25, 0, Math.PI / 2]];
    for (const [x, z, rotation] of sides) {
      const panel = mesh(new THREE.PlaneGeometry(40, 3.15), fenceMaterial);
      panel.position.set(x, 1.65, z);
      panel.rotation.y = rotation;
      root.add(panel);
      for (let p = -20; p <= 20; p += 4) {
        const post = mesh(new THREE.CylinderGeometry(0.075, 0.11, 3.8, 10), steel);
        post.position.set(rotation ? x : p, 1.9, rotation ? p : z);
        post.castShadow = this.quality === "high";
        root.add(post);
      }
      const rail = rounded(rotation ? 0.09 : 40, 0.09, rotation ? 40 : 0.09, steel, 0.018);
      rail.position.set(x, 3.22, z);
      root.add(rail);
    }

    const beaconMat = material(0x5f0c08, 0.35, 0.28, ENVIRONMENT_VISUAL.palette.danger, 4);
    for (const [x, z] of [[-19.7, -19.7], [19.7, -19.7], [-19.7, 19.7], [19.7, 19.7]] as const) {
      const base = mesh(new THREE.CylinderGeometry(0.26, 0.35, 0.32, 14), steel);
      base.position.set(x, 0.16, z);
      const beacon = mesh(new THREE.SphereGeometry(0.17, 12, 8), beaconMat);
      beacon.position.set(x, 0.47, z);
      root.add(base, beacon);
    }
    this.batchStaticMeshes(root);
    scene.add(root);
  }

  createDepotStructure(width: number, depth: number, accentColor: number) {
    const root = new THREE.Group();
    root.name = "modular-utility-structure";
    const concrete = material(0x3d4945, 0.88, 0.06);
    const frame = material(0x172326, 0.38, 0.78);
    const trim = material(accentColor || 0xc38d35, 0.62, 0.2, accentColor || 0xc38d35, 0.08);
    const glass = material(0x70b4a5, 0.2, 0.34, 0x37dba9, 1.1);
    const body = rounded(width, 2.12, depth, concrete, 0.08);
    body.position.y = 1.06;
    root.add(body);
    const cap = rounded(width + 0.2, 0.18, depth + 0.2, frame, 0.035);
    cap.position.y = 2.18;
    root.add(cap);

    const longFace = width >= depth;
    const faceLength = longFace ? width : depth;
    const panelCount = Math.max(2, Math.floor(faceLength / 1.05));
    for (let i = 0; i <= panelCount; i += 1) {
      const offset = (i / panelCount - 0.5) * faceLength;
      const rib = rounded(longFace ? 0.055 : width + 0.06, 1.72, longFace ? depth + 0.06 : 0.055, frame, 0.012);
      rib.position.set(longFace ? offset : 0, 1.08, longFace ? 0 : offset);
      root.add(rib);
    }
    const door = rounded(Math.min(1.18, faceLength * 0.28), 1.55, 0.1, frame, 0.025);
    door.position.set(longFace ? width * 0.22 : depth / 2 + 0.055, 0.81, longFace ? depth / 2 + 0.055 : 0);
    if (!longFace) door.rotation.y = Math.PI / 2;
    root.add(door);
    const window = rounded(Math.min(1.5, faceLength * 0.34), 0.38, 0.07, glass, 0.035);
    window.position.set(longFace ? -width * 0.2 : depth / 2 + 0.062, 1.46, longFace ? depth / 2 + 0.062 : 0);
    if (!longFace) window.rotation.y = Math.PI / 2;
    root.add(window);
    const stripe = rounded(width + 0.05, 0.13, depth + 0.05, trim, 0.015);
    stripe.position.y = 0.38;
    root.add(stripe);

    const roofUnit = rounded(Math.min(1.35, width * 0.42), 0.38, Math.min(1, depth * 0.5), frame, 0.06);
    roofUnit.position.set(-width * 0.18, 2.43, 0);
    root.add(roofUnit);
    for (let i = -2; i <= 2; i += 1) {
      const vent = rounded(0.06, 0.22, Math.min(0.76, depth * 0.4), concrete, 0.01);
      vent.position.set(-width * 0.18 + i * 0.18, 2.56, 0);
      root.add(vent);
    }
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    return root;
  }

  createBarricade(width: number, depth: number) {
    const root = new THREE.Group();
    const steel = material(0x252f31, 0.42, 0.8);
    const warning = material(0xd2a33f, 0.7, 0.22, 0x442000, 0.18);
    const dark = material(0x191f20, 0.78, 0.28);
    for (const x of [-width * 0.4, width * 0.4]) {
      const leg = rounded(0.18, 0.92, depth * 1.9, steel, 0.035);
      leg.position.set(x, 0.42, 0);
      leg.rotation.z = x < 0 ? -0.12 : 0.12;
      root.add(leg);
    }
    const beam = rounded(width, 0.48, depth, warning, 0.045);
    beam.position.y = 0.7;
    root.add(beam);
    for (let i = -3; i <= 3; i += 1) {
      const stripe = rounded(width / 9, 0.49, depth + 0.02, dark, 0.015);
      stripe.position.set(i * width / 7, 0.705, 0);
      stripe.rotation.z = 0.46;
      root.add(stripe);
    }
    const lamp = rounded(0.22, 0.1, 0.16, material(0xffb14a, 0.3, 0.3, 0xff6a22, 2.4), 0.025);
    lamp.position.set(0, 1.02, 0);
    root.add(lamp);
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    return root;
  }

  createFloodlight(color: number) {
    const root = new THREE.Group();
    const steel = material(0x283235, 0.34, 0.86);
    const glass = material(color, 0.16, 0.18, color, 4.2);
    const base = mesh(new THREE.CylinderGeometry(0.25, 0.43, 0.3, 14), steel);
    base.position.y = 0.15;
    const pole = mesh(new THREE.CylinderGeometry(0.07, 0.11, 4.8, 12), steel);
    pole.position.y = 2.55;
    const cross = rounded(1.12, 0.1, 0.12, steel, 0.025);
    cross.position.y = 4.72;
    root.add(base, pole, cross);
    for (const x of [-0.34, 0.34]) {
      const lamp = rounded(0.5, 0.34, 0.28, steel, 0.05);
      lamp.position.set(x, 4.84, 0);
      lamp.rotation.x = -0.3;
      const face = rounded(0.37, 0.23, 0.035, glass, 0.025);
      face.position.set(x, 4.79, 0.16);
      face.rotation.x = -0.3;
      root.add(lamp, face);
    }
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    return root;
  }

  createBarrel() {
    const root = new THREE.Group();
    root.name = "volatile-barrel";
    const red = material(0x7f2720, 0.45, 0.6);
    const steel = material(0x1d2425, 0.3, 0.86);
    const warning = material(0xf2a63b, 0.46, 0.25, 0xff5a16, 0.5);
    const body = mesh(new THREE.CylinderGeometry(0.45, 0.46, 1.12, 20), red);
    body.position.y = 0.58;
    root.add(body);
    for (const y of [0.12, 0.34, 0.86, 1.08]) {
      const band = mesh(new THREE.TorusGeometry(0.46, 0.035, 7, 20), steel);
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      root.add(band);
    }
    const plate = rounded(0.69, 0.27, 0.03, warning, 0.025);
    plate.position.set(0, 0.61, 0.455);
    root.add(plate);
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    return root;
  }

  addSetDressing(scene: THREE.Scene) {
    this.addMedicalCommand(scene);
    this.addDamagedGate(scene);
    this.addVehicle(scene, 14.8, -13.4, -0.45);
    this.addGenerator(scene, -14.8, -11.8, 0.18);
    this.addCrateClusters(scene);
    this.addTires(scene);
    this.addDust(scene);
  }

  private addEvacuationRing(root: THREE.Group) {
    const glow = material(0x8fc35f, 0.54, 0.16, ENVIRONMENT_VISUAL.palette.objective, 1.5);
    const outer = mesh(new THREE.RingGeometry(5.55, 5.72, 96), glow);
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = 0.055;
    root.add(outer);
    for (let i = 0; i < 16; i += 1) {
      if (i % 4 === 3) continue;
      const angle = i / 16 * Math.PI * 2;
      const dash = rounded(0.14, 0.025, 1.02, glow, 0.018);
      dash.position.set(Math.cos(angle) * 5.05, 0.058, Math.sin(angle) * 5.05);
      dash.rotation.y = -angle;
      root.add(dash);
    }
    const core = mesh(new THREE.RingGeometry(1.1, 1.14, 56), new THREE.MeshBasicMaterial({ color: 0x9aff6d, transparent: true, opacity: 0.26, side: THREE.DoubleSide }));
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.06;
    root.add(core);
  }

  private addRoadMarkings(root: THREE.Group) {
    const paint = new THREE.MeshStandardMaterial({ color: 0xc8b66c, roughness: 0.94, transparent: true, opacity: 0.56 });
    for (let i = -4; i <= 4; i += 1) {
      const dash = rounded(0.16, 0.025, 2, paint, 0.018);
      dash.position.set(0, 0.046, i * 4.55);
      dash.rotation.y = i % 3 === 0 ? 0.015 : -0.01;
      root.add(dash);
    }
    const white = new THREE.MeshStandardMaterial({ color: 0xd8dac9, roughness: 0.95, transparent: true, opacity: 0.38 });
    const stem = rounded(0.32, 0.026, 2.15, white, 0.015);
    stem.position.set(-7, 0.05, 0.4);
    const head = mesh(new THREE.ConeGeometry(0.76, 1.36, 3), white);
    head.rotation.x = Math.PI / 2;
    head.position.set(-7, 0.064, -1.18);
    root.add(stem, head);
  }

  private addSurfaceDecals(root: THREE.Group) {
    const patchMat = new THREE.MeshStandardMaterial({ color: 0x171d1b, roughness: 0.98, transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const oilMat = new THREE.MeshPhysicalMaterial({ color: 0x0b1315, roughness: 0.18, metalness: 0.08, transparent: true, opacity: 0.5, depthWrite: false });
    const rand = seededRandom(7307);
    for (let i = 0; i < 14; i += 1) {
      const decal = mesh(new THREE.CircleGeometry(0.8 + rand() * 1.4, 9), i % 4 === 0 ? oilMat : patchMat);
      decal.rotation.x = -Math.PI / 2;
      decal.rotation.z = rand() * Math.PI;
      decal.scale.set(0.5 + rand() * 1.4, 0.3 + rand() * 0.55, 1);
      decal.position.set((rand() - 0.5) * 35, 0.052, (rand() - 0.5) * 35);
      root.add(decal);
    }
    const crackMat = new THREE.LineBasicMaterial({ color: 0x111614, transparent: true, opacity: 0.64 });
    for (let c = 0; c < 18; c += 1) {
      const points: THREE.Vector3[] = [];
      let x = (rand() - 0.5) * 34;
      let z = (rand() - 0.5) * 34;
      for (let p = 0; p < 5; p += 1) {
        points.push(new THREE.Vector3(x, 0.058, z));
        x += (rand() - 0.5) * 1.2;
        z += (rand() - 0.5) * 1.2;
      }
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), crackMat));
    }
  }

  private addPuddles(root: THREE.Group) {
    const water = new THREE.MeshPhysicalMaterial({ color: 0x152a2a, roughness: 0.14, metalness: 0.04, clearcoat: 1, clearcoatRoughness: 0.16, transparent: true, opacity: 0.62, depthWrite: false });
    const edge = new THREE.LineBasicMaterial({ color: 0x34423f, transparent: true, opacity: 0.5 });
    for (const [x, z, sx, sz, rotation] of [[-5.5, -8.2, 2.3, 0.82, 0.1], [8.2, -1.5, 1.55, 0.65, -0.3], [4.6, 9.3, 2.15, 0.74, 0.2]] as const) {
      const points = Array.from({ length: 14 }, (_, i) => {
        const angle = i / 14 * Math.PI * 2;
        const radius = 0.78 + Math.sin(i * 4.7) * 0.13 + (i % 3) * 0.045;
        return new THREE.Vector2(Math.cos(angle) * radius * sx, Math.sin(angle) * radius * sz);
      });
      const shape = new THREE.Shape(points);
      const puddle = mesh(new THREE.ShapeGeometry(shape), water);
      puddle.rotation.x = -Math.PI / 2;
      puddle.rotation.z = rotation;
      puddle.position.set(x, 0.062, z);
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, 0))), edge);
      outline.rotation.x = -Math.PI / 2;
      outline.rotation.z = rotation;
      outline.position.set(x, 0.063, z);
      root.add(puddle, outline);
    }
  }

  private addMedicalCommand(scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name = "landmark-medical-command";
    const canvas = material(0xd7d4bc, 0.92, 0.01);
    const frame = material(0x253234, 0.46, 0.72);
    const medical = material(0xb9ff67, 0.5, 0.14, 0x67ff78, 1.25);
    const floor = rounded(5.2, 0.08, 3.6, frame, 0.06);
    floor.position.y = 0.04;
    const canopy = mesh(new THREE.CylinderGeometry(2.7, 2.7, 3.3, 3, 1, false, 0, Math.PI), canvas);
    canopy.rotation.z = Math.PI / 2;
    canopy.rotation.y = Math.PI / 2;
    canopy.position.y = 1.55;
    canopy.scale.z = 1.15;
    root.add(floor, canopy);
    for (const x of [-2.35, 2.35]) for (const z of [-1.45, 1.45]) {
      const pole = mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.8, 8), frame);
      pole.position.set(x, 1.4, z);
      root.add(pole);
    }
    const crossA = rounded(0.72, 0.08, 0.22, medical, 0.025);
    const crossB = rounded(0.22, 0.08, 0.72, medical, 0.025);
    crossA.position.set(0, 0.12, 1.83);
    crossB.position.copy(crossA.position);
    root.add(crossA, crossB);
    root.position.set(-14.5, 15.8, 0);
    root.rotation.y = 0.18;
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    scene.add(root);
  }

  private addDamagedGate(scene: THREE.Scene) {
    const root = new THREE.Group();
    root.name = "landmark-damaged-gate";
    const steel = material(0x202b2d, 0.38, 0.82);
    const danger = material(0xc3412d, 0.48, 0.38, ENVIRONMENT_VISUAL.palette.danger, 1.6);
    for (const x of [-4.2, 4.2]) {
      const tower = rounded(0.66, 3.9, 0.72, steel, 0.06);
      tower.position.set(x, 1.95, 0);
      const light = rounded(0.42, 0.18, 0.48, danger, 0.035);
      light.position.set(x, 3.92, 0.08);
      root.add(tower, light);
    }
    const beam = rounded(8.7, 0.38, 0.42, steel, 0.04);
    beam.position.set(0, 3.55, 0);
    beam.rotation.z = -0.045;
    root.add(beam);
    for (const [x, rotation] of [[-1.7, -0.34], [1.75, 0.28]] as const) {
      const panel = rounded(3.25, 2.55, 0.18, steel, 0.045);
      panel.position.set(x, 1.32, 0);
      panel.rotation.z = rotation;
      root.add(panel);
    }
    root.position.set(0, 0, -20.05);
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    scene.add(root);
  }

  private addVehicle(scene: THREE.Scene, x: number, z: number, rotation: number) {
    const root = new THREE.Group();
    root.name = "damaged-evacuation-vehicle";
    const bodyMat = material(0x43514d, 0.7, 0.3);
    const dark = material(0x13191a, 0.62, 0.66);
    const glass = material(0x132d30, 0.2, 0.48, 0x1f8b79, 0.4);
    const body = rounded(4.8, 1.45, 2.1, bodyMat, 0.16);
    body.position.y = 1.06;
    const cab = rounded(1.6, 1.2, 1.9, glass, 0.12);
    cab.position.set(1.35, 1.55, 0);
    root.add(body, cab);
    for (const wx of [-1.55, 1.45]) for (const wz of [-1.05, 1.05]) {
      const wheel = mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.25, 16), dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 0.5, wz);
      root.add(wheel);
    }
    root.position.set(x, 0, z);
    root.rotation.y = rotation;
    root.rotation.z = -0.035;
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    scene.add(root);
  }

  private addGenerator(scene: THREE.Scene, x: number, z: number, rotation: number) {
    const root = new THREE.Group();
    root.name = "field-generator";
    const body = material(0x6c5834, 0.66, 0.4);
    const steel = material(0x1c2527, 0.38, 0.82);
    const glow = material(0xb8ff5a, 0.36, 0.18, 0x8dff48, 1.8);
    const caseMesh = rounded(2.1, 1.25, 1.35, body, 0.11);
    caseMesh.position.y = 0.72;
    root.add(caseMesh);
    for (let i = -3; i <= 3; i += 1) {
      const grille = rounded(0.09, 0.72, 0.04, steel, 0.01);
      grille.position.set(i * 0.21, 0.78, 0.695);
      root.add(grille);
    }
    const panel = rounded(0.52, 0.34, 0.06, steel, 0.03);
    panel.position.set(0.65, 0.85, 0.7);
    const lamp = mesh(new THREE.SphereGeometry(0.055, 8, 6), glow);
    lamp.position.set(0.72, 0.86, 0.745);
    root.add(panel, lamp);
    root.position.set(x, 0, z);
    root.rotation.y = rotation;
    enableShadows(root, this.quality === "high");
    this.batchStaticMeshes(root);
    scene.add(root);
  }

  private addCrateClusters(scene: THREE.Scene) {
    const crate = material(0x5b513b, 0.9, 0.08);
    const edge = material(0x222a2a, 0.44, 0.68);
    for (const [x, z, rotation, levels] of [[-16, 8.8, 0.2, 3], [15, -9.2, -0.35, 2], [-13.5, -12.4, 0.12, 2], [13.8, 11.2, 0.7, 3]] as const) {
      const root = new THREE.Group();
      for (let i = 0; i < levels; i += 1) {
        const box = rounded(1.08, 0.72, 0.9, crate, 0.045);
        box.position.set((i % 2) * 0.34, 0.38 + i * 0.69, (i % 2) * 0.08);
        const brace = rounded(1.15, 0.08, 0.96, edge, 0.015);
        brace.position.set(box.position.x, box.position.y + 0.35, box.position.z);
        root.add(box, brace);
      }
      root.position.set(x, 0, z);
      root.rotation.y = rotation;
      enableShadows(root, this.quality === "high");
      this.batchStaticMeshes(root);
      scene.add(root);
    }
  }

  private addTires(scene: THREE.Scene) {
    const rubber = material(0x111516, 0.78, 0.04);
    for (const [x, z] of [[-17.4, -5.4], [16.3, 3.8]] as const) {
      for (let i = 0; i < 3; i += 1) {
        const tire = mesh(new THREE.TorusGeometry(0.46, 0.15, 10, 24), rubber);
        tire.rotation.x = Math.PI / 2;
        tire.position.set(x + i * 0.08, 0.16 + i * 0.21, z + i * 0.04);
        tire.rotation.z = i * 0.3;
        tire.castShadow = this.quality === "high";
        scene.add(tire);
      }
    }
  }

  private addDust(scene: THREE.Scene) {
    const count = GRAPHICS_BUDGETS[this.quality].dustParticles;
    const positions = new Float32Array(count * 3);
    const random = seededRandom(11831);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (random() - 0.5) * 39;
      positions[i * 3 + 1] = 0.05 + random() * 2.75;
      positions[i * 3 + 2] = (random() - 0.5) * 39;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xb8c2a3, size: 0.036, transparent: true, opacity: 0.24, depthWrite: false }));
    points.name = "ambient-dust";
    scene.add(points);
  }

  private addDrain(root: THREE.Group, x: number, z: number, rotation: number) {
    const drainMat = material(0x182022, 0.4, 0.82);
    const dark = new THREE.MeshBasicMaterial({ color: 0x030706 });
    const drain = new THREE.Group();
    const frame = rounded(2.3, 0.045, 0.8, drainMat, 0.025);
    drain.add(frame);
    for (let i = -5; i <= 5; i += 1) {
      const slit = rounded(0.075, 0.02, 0.62, dark, 0.008);
      slit.position.set(i * 0.19, 0.03, 0);
      drain.add(slit);
    }
    drain.position.set(x, 0.046, z);
    drain.rotation.y = rotation;
    root.add(drain);
  }

  private batchStaticMeshes(root: THREE.Group) {
    root.updateMatrixWorld(true);
    const inverseRoot = root.matrixWorld.clone().invert();
    const buckets = new Map<THREE.Material, { geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; castShadow: boolean; receiveShadow: boolean }>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material) || object.userData.noBatch) return;
      const bucket = buckets.get(object.material) ?? { geometries: [], meshes: [], castShadow: false, receiveShadow: false };
      const localMatrix = inverseRoot.clone().multiply(object.matrixWorld);
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      geometry.applyMatrix4(localMatrix);
      bucket.geometries.push(geometry);
      bucket.meshes.push(object);
      bucket.castShadow ||= object.castShadow;
      bucket.receiveShadow ||= object.receiveShadow;
      buckets.set(object.material, bucket);
    });

    for (const [sourceMaterial, bucket] of buckets) {
      if (bucket.geometries.length < 2) {
        for (const geometry of bucket.geometries) geometry.dispose();
        continue;
      }
      const geometry = mergeGeometries(bucket.geometries, false);
      for (const part of bucket.geometries) part.dispose();
      if (!geometry) continue;
      for (const original of bucket.meshes) {
        original.removeFromParent();
        original.geometry.dispose();
      }
      const combined = new THREE.Mesh(geometry, sourceMaterial);
      combined.castShadow = bucket.castShadow;
      combined.receiveShadow = bucket.receiveShadow;
      combined.frustumCulled = false;
      root.add(combined);
    }
  }

  private createGroundMaps(): CanvasMaps {
    const size = 1024;
    const random = seededRandom(240319);
    const albedoCanvas = document.createElement("canvas");
    albedoCanvas.width = albedoCanvas.height = size;
    const color = albedoCanvas.getContext("2d");
    if (color) {
      color.fillStyle = "#252c2a";
      color.fillRect(0, 0, size, size);
      for (let i = 0; i < 5200; i += 1) {
        const gray = 28 + Math.floor(random() * 38);
        color.fillStyle = `rgba(${gray},${gray + 4},${gray + 2},${0.08 + random() * 0.2})`;
        const r = 0.5 + random() * 2.8;
        color.beginPath();
        color.arc(random() * size, random() * size, r, 0, Math.PI * 2);
        color.fill();
      }
      for (let i = 0; i < 34; i += 1) {
        const x = random() * size;
        const y = random() * size;
        const radius = 32 + random() * 120;
        const gradient = color.createRadialGradient(x, y, 0, x, y, radius);
        const mud = random() > 0.5 ? "55,52,41" : "19,28,25";
        gradient.addColorStop(0, `rgba(${mud},${0.12 + random() * 0.18})`);
        gradient.addColorStop(1, `rgba(${mud},0)`);
        color.fillStyle = gradient;
        color.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      color.lineCap = "round";
      for (let i = 0; i < 80; i += 1) {
        let x = random() * size;
        let y = random() * size;
        color.strokeStyle = `rgba(8,12,11,${0.16 + random() * 0.22})`;
        color.lineWidth = 0.6 + random() * 1.8;
        color.beginPath();
        color.moveTo(x, y);
        for (let p = 0; p < 5; p += 1) {
          x += (random() - 0.5) * 32;
          y += (random() - 0.5) * 32;
          color.lineTo(x, y);
        }
        color.stroke();
      }
    }
    const detailCanvas = document.createElement("canvas");
    detailCanvas.width = detailCanvas.height = 256;
    const detail = detailCanvas.getContext("2d");
    if (detail) {
      detail.fillStyle = "#777";
      detail.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2600; i += 1) {
        const value = 75 + Math.floor(random() * 95);
        detail.fillStyle = `rgb(${value},${value},${value})`;
        detail.fillRect(random() * 256, random() * 256, 1 + random() * 2, 1 + random() * 2);
      }
    }
    const roughCanvas = document.createElement("canvas");
    roughCanvas.width = roughCanvas.height = 512;
    const rough = roughCanvas.getContext("2d");
    if (rough) {
      rough.fillStyle = "#e6e6e6";
      rough.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 48; i += 1) {
        const x = random() * 512;
        const y = random() * 512;
        const radius = 12 + random() * 58;
        const gradient = rough.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, "rgba(80,80,80,.48)");
        gradient.addColorStop(1, "rgba(230,230,230,0)");
        rough.fillStyle = gradient;
        rough.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
    const albedo = new THREE.CanvasTexture(albedoCanvas);
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    const detailMap = new THREE.CanvasTexture(detailCanvas);
    detailMap.wrapS = detailMap.wrapT = THREE.RepeatWrapping;
    detailMap.repeat.set(18, 18);
    detailMap.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const roughness = new THREE.CanvasTexture(roughCanvas);
    roughness.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return { albedo, detail: detailMap, roughness };
  }

  private createChainTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, 128, 128);
      context.strokeStyle = "rgba(220,230,225,.9)";
      context.lineWidth = 3;
      for (let offset = -128; offset < 256; offset += 24) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset + 128, 128);
        context.stroke();
        context.beginPath();
        context.moveTo(offset + 128, 0);
        context.lineTo(offset, 128);
        context.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(13, 1.3);
    return texture;
  }
}
