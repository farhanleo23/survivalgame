# Deadwave

Deadwave is a single-player top-down 3D zombie survival shooter for desktop browsers. Defend an abandoned evacuation depot through ten waves, recover salvage, buy persistent weapons and perks between waves, and defeat the Juggernaut boss. Its bespoke procedural art direction uses charcoal depot surfaces, acid-green objectives, orange danger lighting, distinct enemy silhouettes, and scalable tactical effects.

## Play

- `WASD` — move
- Mouse — aim
- Left click — fire
- `R` — reload
- `Shift` or `Space` — dash
- `Q`, `1`, `2` — switch weapons
- `Escape` — pause

Progress is stored locally in the browser. Weapons, upgrades, perks, settings, completed levels, and banked salvage survive refreshes and failed runs.

Graphics quality can be cycled between Low, Medium, and High from the command screen or pause menu. Quality presets adjust resolution, shadows, decals, particles, dust, and character shadow budgets without removing combat telegraphs.

## Development

Requires Node.js 22.13 or newer. The repository includes an `.nvmrc`, so nvm users can run `nvm use` before installing dependencies.

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

The game uses vinext/Vite, React, Three.js, and Rapier 3D. Gameplay configuration lives in `game/config.ts`; rendering, physics, combat, enemies, pickups, and wave progression live in `game/GameEngine.ts`.

## Visual QA

- `/?visualqa=1` — deploy into the visual systems gallery containing every operator weapon, zombie archetype, pickup, decal family, environment material, and lighting treatment.
- `/?stress=1` — deploy into a stable 36-hostile scene used to profile draw calls, triangles, frame time, silhouettes, and telegraphs.

The legacy Mixamo Soldier, early concept characters, and the first asphalt source are retained under `art-reference/` for provenance but are no longer shipped to players.
