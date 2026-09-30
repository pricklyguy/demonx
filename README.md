# DemonX CNC Controller

Browser-based CNC controller by Prickly Guy Creations. One server owns the machine connection; any device on the network opens the UI to monitor or control the same job. Targets GRBL (including FluidNC in GRBL mode).

> V2 rewrite in progress. The original single-file prototype lives in [`v1-archive/`](v1-archive/).

## Status: Milestone 1 (core)

- Serial connection owned by the server, shared by all browser clients
- GRBL character-counting streaming, so large files stream at full speed
- Live DRO (work and machine position), jog, zero, home, unlock
- Job: load, start, pause, resume, stop (feed hold, then reset so the spindle stops)
- Feed / rapid / spindle overrides, console, dark and light themes
- Built-in **simulator** so the whole stack runs without hardware

Not yet built: probing (with the mandatory "probe connected" / "remove clamp" confirmations), autolevel, 3D visualizer, docking layout, Home Assistant, camera.

## Run it

```bash
npm install
npm run build        # builds the UI into web/dist
npm start            # http://<server-ip>:8080
```

Open the page, type `simulator` in the port box to try it with no machine, or pick the real serial port on the server.

Development with hot reload: `npm run dev:server` and `npm run dev:web` (UI on :5173).
Tests: `npm test` (parser, streamer, pause/resume/stop against the simulator).

## Docker

```bash
docker build -t demonx .
docker run -p 8080:8080 --device=/dev/ttyUSB0 demonx
```

## Layout

- `server/` Node + TypeScript: GRBL controller, streamer, simulator, WebSocket hub
- `web/` React + Vite UI
- `shared/protocol.ts` message types shared by both
- `v1-archive/` original prototype
