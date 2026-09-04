# Deadwave review — September 4, 2026

The review covered the simulation, controls, combat, pickups, progression, profile persistence, rendering loop, audio, and desktop/mobile UI. Fixes are in the local project.

## Fixed issues

| Area | Issue | Result |
| --- | --- | --- |
| Dash | A stationary dash consumed its cooldown without moving; releasing movement interrupted dash travel. | Dash follows its captured direction for the duration, including when started from rest. |
| Touch movement | Every nonzero stick input was normalized to full speed. | Partial stick movement produces proportional speed; diagonals remain capped. |
| Touch targeting | A target handoff could depend on enemy spawn order. | The nearest challenger is compared against the original lock once, retaining the existing 30% hysteresis. |
| Touch gestures | React touch handlers tried to cancel passive events, producing browser errors and failing to claim the gesture. | A native non-passive listener claims gestures for the complete control pad. |
| Bullet collision | Endpoint-only checks missed grazing hits and thin cover; collision order could favor enemies behind the closest target. | The full projectile path is checked and contacts resolve in travel order. Piercing remains supported. |
| Ricochets | Homing mutated the direction vector's length and overwrote projectile speed. | Direction stays normalized, speed is preserved, and homing selects targets on the exposed side of cover. |
| Cover collision | Actors embedded in cover had a zero collision normal and could remain stuck. | Actors are pushed toward the nearest box face or out of cylindrical cover; tangential movement is preserved. |
| Pickups | Full health/ammo still consumed supplies; health text overstated partial healing. | Unneeded supplies remain during the wave, and healing text reports the amount restored. |
| Wave completion | The victory screen could open before final-boss salvage was collected. | Extraction and victory bank all remaining salvage. |
| Wave transitions | Old shots, hazards, effects, and supplies could carry into a fresh encounter or changed arena. | New waves clear these transient objects and reset combo/hit-stop state. |
| Death | A simulation tick could continue into pickup collection after a fatal event. | Processing stops at terminal transitions and health packs cannot revive a dead operator. |
| HUD/loadout | Dash progress used a fixed cooldown despite upgrades; equipment changes could leave the old weapon model visible. | Progress uses the actual cooldown, and equipment changes synchronize the displayed weapon. |

## Responsiveness and workload

- Slow frames retain up to eight 60 Hz simulation steps, replacing the 50 ms elapsed-time clamp. A 100 ms frame now advances six steps. Work after a long stall remains bounded.
- Coin collections in a single tick produce one profile commit, avoiding a save and update for each individual coin.
- Salvage-only profile changes skip audio reconfiguration, perk application, weapon synchronization, and forced HUD updates.
- Profile persistence and engine callbacks run outside React's replayable state updater.
- Damage popups reuse viewport dimensions measured during resize, avoiding layout reads after each popup insertion.
- Removed a per-frame scene traversal for an ambient-dust object that does not exist.
- Unchanged music intensity no longer schedules repeated audio parameter automation.
- Projectile sweeps reuse scratch vectors, and collision checks only take square roots when needed.

The game is single-player and simulates locally. Network conditions mainly affect initial code/model loading, rather than combat round trips. These changes reduce unnecessary work and correct slow-frame behavior; no before/after FPS gain is claimed.

## Verification

- Type checking and ESLint passed.
- 93 unit/regression tests passed, including 22 added during this review.
- 27 browser tests passed across desktop Chromium, Android Chrome emulation, and iPhone WebKit emulation.
- Browser coverage includes stationary dashes, touch gestures, firing/reload, pause/resume, storage restrictions, armory purchases, redeployment, extraction, and campaign victory.
- A normal rendered wave-eight session exercised combat, combos, automatic targeting, reloads, and salvage collection. This complemented the campaign tests that use local QA shortcuts to clear waves.
- Production build passed. The existing warning for the approximately 707 kB minified Three.js chunk remains; the renderer is already loaded through dynamic imports.

Physical-device frame-rate and battery measurements remain outside this browser-emulated review. The art direction and campaign structure are preserved; gameplay changes focus on control consistency, dependable collisions, supplies, and clean transitions.
