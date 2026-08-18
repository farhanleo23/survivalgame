"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live cover art for the lobby.
 *
 * Renders the operator through the game's own cel-shading and comic post pass,
 * so the homepage cannot drift out of style with the arena — it is literally
 * the same renderer. Everything loads after first paint behind an inked
 * fallback, and the model it pulls is the one the run needs anyway, so this
 * warms the cache rather than costing extra.
 */
export function LobbyHero({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let frame = 0;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const THREE = await import("three");
        const { COMIC, ComicPalette } = await import("@/game/comic");
        const { CharacterFactory } = await import("@/game/characters");
        const { ComicPostProcess } = await import("@/game/postfx");
        if (disposed) return;

        const width = mount.clientWidth || 640;
        const height = mount.clientHeight || 420;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        renderer.domElement.style.display = "block";
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(COMIC.sky);

        // Same rig as the arena, so the shading reads identically.
        scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6b7799, 0.5));
        const key = new THREE.DirectionalLight(0xfff6e2, 0.72);
        key.position.set(-6, 12, 9);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.left = -8;
        key.shadow.camera.right = 8;
        key.shadow.camera.top = 8;
        key.shadow.camera.bottom = -8;
        key.shadow.bias = -0.0002;
        key.shadow.normalBias = 0.035;
        scene.add(key);
        const fill = new THREE.DirectionalLight(0x8ecbff, 0.16);
        fill.position.set(8, 6, 10);
        scene.add(fill);

        const palette = new ComicPalette();
        const factory = new CharacterFactory(palette);

        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(14, 14),
          palette.toon(0x8f9db8),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(ground);

        // Painted hazard ring, echoing the depot's centre pad.
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.5, 1.75, 48),
          palette.flat(COMIC.hazardYellow, { side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        scene.add(ring);

        const rig = factory.createCharacter("player");
        scene.add(rig.root);

        const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 60);
        camera.position.set(0, 1.55, 6.1);
        camera.lookAt(0, 0.95, 0);

        const post = new ComicPostProcess(renderer);
        post.setSize(width, height);

        const clock = new THREE.Clock();
        let revealed = false;

        const animate = () => {
          if (disposed) return;
          frame = requestAnimationFrame(animate);
          const dt = Math.min(0.05, clock.getDelta());
          const t = clock.getElapsedTime();

          // Slow turntable so the silhouette reads from every angle.
          rig.root.rotation.y = reducedMotion ? 0.35 : Math.sin(t * 0.28) * 0.85;
          factory.animate(rig, dt, 0, false, 0);
          post.render(scene, camera);

          // Hold the fallback until the model has actually attached, otherwise
          // the panel flashes an empty floor on slower connections.
          if (!revealed && rig.model) {
            revealed = true;
            setReady(true);
          }
        };
        animate();

        const onResize = () => {
          const w = mount.clientWidth || width;
          const h = mount.clientHeight || height;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
          post.setSize(w, h);
        };
        window.addEventListener("resize", onResize);

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          post.dispose();
          factory.dispose();
          palette.dispose();
          ground.geometry.dispose();
          ring.geometry.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch {
        // WebGL unavailable or the model failed — the inked fallback stands in.
      }
    })();

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [reducedMotion]);

  return (
    <div className={`hero-stage ${ready ? "is-live" : ""}`}>
      <div className="hero-canvas" ref={mountRef} aria-hidden="true" />
      <div className="hero-fallback" aria-hidden={ready}>
        <span className="hero-fallback-mark">DW</span>
        <span className="hero-fallback-text">Developing plate…</span>
      </div>
    </div>
  );
}
