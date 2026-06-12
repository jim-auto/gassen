# gassen

`gassen` is a browser-based realtime battle simulation prototype.

The first target is intentionally narrow:

- 50 vs 50 soldiers
- 1 commander per side
- 2 factions
- a single straight battlefield
- automatic frontline formation
- morale-driven collapse instead of HP attrition
- infantry, spear, and cavalry roles inside the same 50-unit cap
- three lightweight formations: line, wedge, and crane wing
- tactical incidents: center breakthrough, wing collapse, commander isolation, and encirclement
- commander rally to stabilize morale and pull routing units back into the line
- post-battle result snapshots and local browser battle history
- pause, 1x, and 2x simulation speed controls with automatic pause after battle end

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The Vite config uses a relative asset base so the static build can run from GitHub Pages project paths.
