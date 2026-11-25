/** One consistent line weight for functional game symbols. */
const paths: Record<string, string> = {
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z",
  vitality: "M9 4h6v5h5v6h-5v5H9v-5H4V9h5Z",
  mobility: "m13 3-9 11h7l-1 7 10-12h-8Z",
  magnet: "M5 4v9a7 7 0 0 0 14 0V4h-5v9a2 2 0 0 1-4 0V4ZM5 8h5m4 0h5",
  piercing: "M3 12h17m-6-6 6 6-6 6M7 4v16",
  ricochet: "m3 19 8-9 4 3 6-9m-7 0h7v7",
  shrapnel: "M12 9v6M9 12h6M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3",
  high_caliber: "M9 20V8l3-5 3 5v12ZM9 16h6",
  tesla_arcs: "m13 3-8 10h6l-1 8 9-11h-7Z",
  incendiary: "M13 3c1 5-4 5-2 10 2-1 3-3 3-5 7 6 4 13-2 13S2 15 7 9c-1 4 1 5 2 5-1-5 4-5 4-11Z",
  cryo_frost: "M12 3v18M4 7l16 10M4 17 20 7m-11-3 3 3 3-3M9 20l3-3 3 3",
  acid_dash: "M12 3s7 9 7 12a7 7 0 0 1-14 0c0-3 7-12 7-12Zm-4 13 3 2 5-6",
  kinetic_impact: "M12 7v10M7 12h10M4 8v8m16-8v8M8 4h8M8 20h8",
  phantom_reflex: "M5 20V10a7 7 0 0 1 14 0v10l-4-3-3 3-3-3ZM9 10v2m6-2v2",
  vampiric_leech: "m4 5 8 15 8-15-8 5ZM8 4l4 6 4-6",
  adrenaline_surge: "M2 12h5l3-8 4 16 3-8h5",
  beacon: "M8 16h8l2 5H6Zm4 0V6m-4 4a6 6 0 0 1 8 0M4 6a12 12 0 0 1 16 0",
  overdrive: "M13 2 4 14h7l-1 8 10-12h-7l0-8ZM3 7l3 1M18 16l3 1",
  grenade: "M9 3h6l1 3H8l1-3ZM8 8h8a4 4 0 0 1 2 3.5V16a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-4.5A4 4 0 0 1 8 8Zm4-2v2M7 13h10",
  blade: "M19 3 7 15m0 0-3 6 6-3m-3-3 3 3m4-10 3 3",
  turret: "M6 19h12M9 19v-5h6v5M7 9h8v5H7Zm8 1h6M15 13h5",
  pylon: "M8 20h8M10 20l2-14 2 14M7 10h10M8 14h8M12 3a2 2 0 1 0 0 .01Z",
  superconductor: "M12 2v20M5 6l14 12M19 6 5 18M12 7l2 5h-4l2 5",
  napalm_wake: "M12 2c2 5-3 6-1 11 2-1 3-3 3-5 6 5 3 13-2 13s-9-6-4-12c-1 3 1 4 2 4-1-5 2-6 2-11ZM4 20h16",
  rail_bounce: "M3 18 10 6l5 8 6-10M16 4h5v5M3 18h6",
  blood_nova: "M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11ZM3 12h3m12 0h3M12 1v2",
};
export function GameIcon({ name, className = "" }: { name: string; className?: string }) {
  return <svg className={`game-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.shield} /></svg>;
}
