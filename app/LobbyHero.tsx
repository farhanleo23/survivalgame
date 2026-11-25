"use client";
/* eslint-disable @next/next/no-img-element -- Pre-rendered local WebP game assets; no image service needed. */
import { useEffect, useRef, useState } from "react";

/** The live operator stage costs no render loop on handheld devices. */
export function LobbyHero({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    let disposed = false; let frame = 0; let cleanup: (() => void) | undefined;
    void (async () => {
      const THREE = await import("three");
      const { createOperatorStage } = await import("@/game/operator-stage");
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer> | undefined;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
        const stage = createOperatorStage();
        const resize = () => {
          stage.camera.aspect = Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight);
          stage.camera.updateProjectionMatrix(); renderer!.setSize(mount.clientWidth, mount.clientHeight, false);
          renderer!.render(stage.scene, stage.camera);
        };
        const observer = new ResizeObserver(resize); observer.observe(mount);
        cleanup = () => { observer.disconnect(); stage.dispose(); renderer?.dispose(); renderer?.domElement.remove(); };
        mount.appendChild(renderer.domElement); resize(); await stage.ready();
        if (disposed) { cleanup(); return; }
        let previous = performance.now();
        const draw = (now: number) => {
          if (disposed) return;
          const dt = (now - previous) / 1000;
          if (dt >= 1 / 30) {
            previous = now;
            if (!reducedMotion) stage.animate(Math.min(0.05, dt));
            renderer!.render(stage.scene, stage.camera);
          }
          frame = requestAnimationFrame(draw);
        };
        stage.animate(0.016); renderer.render(stage.scene, stage.camera); setReady(true);
        if (!reducedMotion) frame = requestAnimationFrame(draw);
      } catch { cleanup?.(); renderer?.dispose(); }
    })();
    return () => { disposed = true; cancelAnimationFrame(frame); cleanup?.(); };
  }, [reducedMotion]);
  return <div className={`hero-stage ${ready ? "is-live" : ""}`}>
    <img className="hero-preview" src="/images/operator.webp" alt="" />
    <div className="hero-canvas" ref={mountRef} aria-hidden="true" />
  </div>;
}
