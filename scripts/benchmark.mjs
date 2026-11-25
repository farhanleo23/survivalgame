import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
// Same browser, fixed seed, 36 enemies and 240 simulation ticks per run.
// Deliberately renders every frame (the fast qa=1 flow does not).
const label = process.argv[2] ?? 'after';
await mkdir('artifacts/presentation', { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
for (const mobile of [false, true]) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto('http://localhost:3000');
  const result = await page.evaluate(async ({ mobile }) => {
    const { GameEngine } = await import('/game/GameEngine.ts');
    const { createDefaultProfile } = await import('/game/profile.ts');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;z-index:99999'; document.body.appendChild(host);
    const profile = createDefaultProfile(); profile.settings.sfx = false; profile.settings.music = false;
    let seed = 19092026; Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const engine = new GameEngine(host, profile, { onHud() {}, onCoins() {}, onWaveChange() {}, onWaveComplete() {}, onDeath() {}, onVictory() {}, onPauseToggle() {} }, { inputMode: 'touch', mobileRendering: mobile, graphicsMode: 'performance' });
    engine.start(1); engine.pause(); await engine.visuals.ready();
    engine.spawnQueue.length = 0;
    for (const enemy of engine.enemies) { engine.visuals.characters?.disposeCharacter(enemy.rig); engine.scene.remove(enemy.mesh); } engine.enemies.length = 0;
    const roles = ['shambler', 'runner', 'spitter', 'brute', 'boomer', 'shambler'];
    for (let i = 0; i < 36; i++) { engine.spawnEnemy(roles[i % roles.length]); const e = engine.enemies.at(-1); e.mesh.position.set(Math.cos(i * 2.4) * (7 + i % 7), 0, Math.sin(i * 2.4) * (7 + i % 7)); e.health = e.maxHealth = 100000; }
    await engine.visuals.ready(); await new Promise(r => setTimeout(r, 800));
    engine.playerHealth = engine.maxHealth = 100000; engine.paused = false; engine.firing = true;
    const cpu = [], frame = []; let last = performance.now();
    for (let i = 0; i < 300; i++) {
      await new Promise(requestAnimationFrame); const now = performance.now();
      const start = performance.now(); engine.step(1 / 60); engine.post.render(engine.scene, engine.camera);
      if (i >= 60) { cpu.push(performance.now() - start); frame.push(now - last); } last = now;
    }
    engine.paused = true; const sort = a => a.sort((a, b) => a - b); sort(cpu); sort(frame);
    window.__benchEngine = engine;
    return { device: mobile ? 'mobile-emulation' : 'desktop', seed: 19092026, enemies: 36, frames: 240, dpr: engine.pixelRatio, cpuMedianMs: cpu[120], cpuP95Ms: cpu[228], frameMedianMs: frame[120], frameP95Ms: frame[228], calls: engine.renderer.info.render.calls, triangles: engine.renderer.info.render.triangles, geometries: engine.renderer.info.memory.geometries, textures: engine.renderer.info.memory.textures };
  }, { mobile });
  await page.screenshot({ path: `artifacts/presentation/${label}-${mobile ? 'mobile' : 'desktop'}.png` });
  results.push(result); await page.close();
}
await browser.close();
await writeFile(`artifacts/presentation/${label}-benchmark.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
