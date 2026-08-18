"use client";

import { useEffect, useRef } from "react";

/**
 * Dev-only character sheet: every archetype lined up under the game's real
 * lighting and post-process, walking on the spot. Faster to judge silhouettes
 * here than by chasing enemies around a live run.
 *
 * Route: /characters
 */
const KINDS = ["player", "shambler", "runner", "spitter", "boomer", "brute", "juggernaut"] as const;

export function CharacterSheet() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let frame = 0;

    void (async () => {
      const THREE = await import("three");
      const { COMIC, ComicPalette } = await import("@/game/comic");
      const { CharacterFactory } = await import("@/game/characters");
      const { ComicPostProcess } = await import("@/game/postfx");
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.domElement.style.display = "block";
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(COMIC.sky);

      // Same light rig as the arena so what you see here is what ships.
      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6b7799, 0.5));
      const key = new THREE.DirectionalLight(0xfff6e2, 0.72);
      key.position.set(-8, 16, 10);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      // Must cover the whole ground plane: anything outside the shadow
      // frustum samples as fully shadowed and renders black.
      key.shadow.camera.left = -32;
      key.shadow.camera.right = 32;
      key.shadow.camera.top = 32;
      key.shadow.camera.bottom = -32;
      key.shadow.bias = -0.0002;
      key.shadow.normalBias = 0.035;
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x8ecbff, 0.16);
      fill.position.set(10, 8, 12);
      scene.add(fill);

      const palette = new ComicPalette();
      const factory = new CharacterFactory(palette);
      // Models load async; wait so nothing pops in mid-capture.
      await factory.preload();
      if (disposed) return;

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(44, 44),
        palette.toon(0x8f9db8),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      const rigs = KINDS.map((kind, index) => {
        const rig = factory.createCharacter(kind);
        rig.root.position.set((index - (KINDS.length - 1) / 2) * 2.75, 0, 0);
        // Characters are authored facing +Z, and the camera sits on +Z, so
        // zero rotation already looks down the barrel at us.
        rig.root.rotation.y = 0;
        scene.add(rig.root);
        return rig;
      });

      const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 0.1, 110);
      camera.position.set(0, 2.8, 15.5);
      camera.lookAt(0, 1.5, 0);

      const post = new ComicPostProcess(renderer);
      post.setSize(mount.clientWidth, mount.clientHeight);

      const clock = new THREE.Clock();
      const animate = () => {
        if (disposed) return;
        frame = requestAnimationFrame(animate);
        const dt = Math.min(0.05, clock.getDelta());
        const t = clock.getElapsedTime();
        // Cycle idle → walk → attack so every pose gets shown.
        const speed = (t % 8) < 3 ? 0 : 3.2;
        const attacking = (t % 8) > 6;
        for (const rig of rigs) factory.animate(rig, dt, speed, attacking, 0);
        post.render(scene, camera);
      };
      animate();

      const onResize = () => {
        if (!mount) return;
        camera.aspect = mount.clientWidth / mount.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        post.setSize(mount.clientWidth, mount.clientHeight);
      };
      window.addEventListener("resize", onResize);

      return () => {
        window.removeEventListener("resize", onResize);
        post.dispose();
        factory.dispose();
        palette.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <main style={{ margin: 0, background: "#12101c", color: "#f4ead6", fontFamily: "system-ui, sans-serif" }}>
      <div ref={mountRef} style={{ width: "100vw", height: "70vh" }} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${KINDS.length}, 1fr)`,
          padding: "1rem 0",
          textAlign: "center",
          letterSpacing: "0.12em",
          fontSize: "0.75rem",
          textTransform: "uppercase",
        }}
      >
        {KINDS.map((kind) => (
          <span key={kind}>{kind}</span>
        ))}
      </div>
    </main>
  );
}
