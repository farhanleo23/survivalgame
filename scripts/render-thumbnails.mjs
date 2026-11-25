import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('public/images', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage(); await page.goto('http://localhost:3000');
const images = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { createOperatorStage } = await import('/game/operator-stage.ts');
  const stage = createOperatorStage(); await stage.ready();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true; renderer.setSize(900, 760); stage.camera.aspect = 900 / 760; stage.camera.updateProjectionMatrix();
  stage.animate(0.1); renderer.render(stage.scene, stage.camera);
  const output = { operator: renderer.domElement.toDataURL('image/webp', 0.88).split(',')[1] };
  for (const [id, weapon] of stage.rig.weaponModels) {
    const scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xffffff, 0x8293a5, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 4, 5); scene.add(light);
    const model = weapon.group.clone(true); model.visible = true; model.rotation.set(0, -Math.PI / 2, 0); scene.add(model);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const camera = new THREE.PerspectiveCamera(28, 3, 0.01, 30); camera.position.set(size.x * 0.2, size.y * 1.6, size.x * 1.5); camera.lookAt(0, 0, 0);
    renderer.setSize(600, 200); renderer.setClearColor(0, 0); renderer.render(scene, camera);
    output[id] = renderer.domElement.toDataURL('image/webp', 0.9).split(',')[1];
  }
  renderer.dispose(); stage.dispose(); return output;
});
for (const [name, data] of Object.entries(images)) await writeFile(`public/images/${name}.webp`, Buffer.from(data, 'base64'));
await browser.close(); console.log('Rendered operator and four equipped weapon models.');
