import * as THREE from "three";
import { CharacterFactory } from "./characters";
import { COMIC, ComicPalette } from "./comic";
import { EnvironmentAssets } from "./environment-assets";

/** Shared by the live lobby and offline menu-thumbnail renderer. */
export function createOperatorStage() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1520);
  scene.fog = new THREE.FogExp2(0x0b1520, 0.095);

  scene.add(new THREE.HemisphereLight(0x5288b0, 0x101822, 0.9));

  const key = new THREE.DirectionalLight(0xffc98b, 2.2);
  key.position.set(-3.5, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.normalBias = 0.03;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x35e6ff, 2.4);
  rim.position.set(4, 3.2, -3.5);
  scene.add(rim);

  const emberLight = new THREE.PointLight(0xff6b2b, 3.5, 11, 1.8);
  emberLight.position.set(-2.2, 1.4, -1.6);
  scene.add(emberLight);

  const palette = new ComicPalette();
  const factory = new CharacterFactory(palette);
  const environment = new EnvironmentAssets();

  const geometry = new THREE.PlaneGeometry(30, 30);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2c3e4d,
    roughness: 0.42,
    metalness: 0.28,
  });
  let disposed = false;
  const texture = new THREE.TextureLoader().load("/textures/depot-concrete.jpg", (loaded) => {
    if (disposed) loaded.dispose();
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  texture.colorSpace = THREE.SRGBColorSpace;
  material.map = texture;

  const floor = new THREE.Mesh(geometry, material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Glowing holographic operator pad under Kai
  const padGeo = new THREE.RingGeometry(0.95, 1.06, 40);
  const padMat = new THREE.MeshBasicMaterial({ color: COMIC.electric, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.02;
  scene.add(pad);

  const innerPadGeo = new THREE.CircleGeometry(0.94, 32);
  const innerPadMat = new THREE.MeshBasicMaterial({ color: COMIC.electric, transparent: true, opacity: 0.09, side: THREE.DoubleSide });
  const innerPad = new THREE.Mesh(innerPadGeo, innerPadMat);
  innerPad.rotation.x = -Math.PI / 2;
  innerPad.position.y = 0.015;
  scene.add(innerPad);

  // Drifting glowing embers in the background
  const emberCount = 48;
  const emberPositions = new Float32Array(emberCount * 3);
  for (let i = 0; i < emberCount; i += 1) {
    emberPositions[i * 3] = (Math.random() - 0.5) * 10;
    emberPositions[i * 3 + 1] = Math.random() * 4.5;
    emberPositions[i * 3 + 2] = (Math.random() - 0.5) * 8 - 1;
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute("position", new THREE.BufferAttribute(emberPositions, 3));
  const emberMat = new THREE.PointsMaterial({ color: 0xffaa44, size: 0.075, transparent: true, opacity: 0.85 });
  const embers = new THREE.Points(emberGeo, emberMat);
  scene.add(embers);

  const container = environment.create("shipping-container-a", 5.6, 2.5, 2.3, new THREE.Group());
  container.position.set(-2.3, 0, -3.5);
  container.rotation.y = 0.12;
  scene.add(container);

  const tank = environment.create("detail-tank", 1.5, 1.5, 2.2, new THREE.Group());
  tank.position.set(3, 0, -2);
  scene.add(tank);

  const rig = factory.createCharacter("player");
  rig.root.rotation.y = -0.28;
  scene.add(rig.root);

  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 40);
  camera.position.set(2.3, 2.1, 5.6);
  camera.lookAt(0, 1, 0);

  let elapsed = 0;
  return {
    scene,
    camera,
    rig,
    factory,
    ready: () => Promise.all([factory.preload(), environment.ready()]),
    animate(dt: number) {
      elapsed += dt;
      factory.animate(rig, dt, 0, false, 0);
      emberLight.intensity = 3.2 + Math.sin(elapsed * 7.5) * 0.7 + Math.sin(elapsed * 13.1) * 0.3;
      pad.rotation.z += dt * 0.45;
      const pos = emberGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < emberCount; i += 1) {
        let y = pos.getY(i) + dt * (0.45 + (i % 5) * 0.12);
        const x = pos.getX(i) + Math.sin(elapsed * 1.4 + i) * dt * 0.15;
        if (y > 4.6) y = 0.1;
        pos.setXY(i, x, y);
      }
      pos.needsUpdate = true;
    },
    dispose() {
      disposed = true;
      factory.disposeCharacter(rig);
      factory.dispose();
      environment.dispose();
      palette.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      padGeo.dispose();
      padMat.dispose();
      innerPadGeo.dispose();
      innerPadMat.dispose();
      emberGeo.dispose();
      emberMat.dispose();
    },
  };
}
