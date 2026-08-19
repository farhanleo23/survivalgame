# Deadwave

Deadwave is a single-player top-down 3D zombie survival shooter for desktop and mobile browsers. Defend an abandoned evacuation depot through ten waves, recover salvage, buy persistent weapons and perks between waves, and defeat the Juggernaut boss.

## Play

- `WASD` — move
- Mouse — aim
- Left click — fire
- `R` — reload
- `Shift` or `Space` — dash
- `Q`, `1`, `2` — switch weapons
- `Escape` — pause

On touch-first phones and tablets, Deadwave automatically switches to a landscape mobile layout with an analog movement stick, automatic enemy targeting, and Fire, Dash, Reload, Swap, and Pause buttons. Control mode and Automatic, Quality, or Performance graphics can be selected from the lobby or pause menu.

Progress is stored locally in the browser. Weapons, upgrades, perks, settings, completed levels, and banked salvage survive refreshes and failed runs.

## Development

Requires Node.js 22.13 or newer. The repository includes an `.nvmrc`, so nvm users can run `nvm use` before installing dependencies.

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

To test from a phone on the same Wi-Fi network, expose the development server on your LAN and open the Mac's local IP address from the phone:

```bash
npm run dev -- --hostname 0.0.0.0
```

For example, if the Mac is `192.168.1.20`, open `http://192.168.1.20:3000` on the phone and rotate to landscape after deployment.

The game uses vinext/Vite, React and Three.js. Collision is hand-rolled against a
simple obstacle list rather than a physics engine. Gameplay configuration lives in
`game/config.ts`; rendering, collision, combat, enemies, pickups and wave
progression live in `game/GameEngine.ts`.
