# DemonX CNC Controller

Browser-based CNC controller by Prickly Guy Creations. One server owns the machine connection; any device on the network opens the UI to monitor or control the same job. Targets GRBL (including FluidNC in GRBL mode).

> V2 rewrite in progress. The original single-file prototype lives in [`v1-archive/`](v1-archive/).

## Status: Milestone 3 (core + probing + autolevel)

- Serial connection owned by the server, shared by all browser clients
- GRBL character-counting streaming, so large files stream at full speed
- Live DRO (work and machine position), jog, zero, home, unlock
- Job: load, start, pause, resume, stop (feed hold, then reset so the spindle stops)
- Feed / rapid / spindle overrides, console, dark and light themes
- Built-in **simulator** so the whole stack runs without hardware

### Probing
- Z probe, PCB Z probe (direct contact) and 3-axis XYZ block probe, two-pass (fast then fine), ported from V1
- **"Is the probe connected?"** confirmation before anything moves, with a live probe-input indicator (touch the bit to the plate to test it)
- **"Remove the probe"** confirmation after every probe, including failed and cancelled ones
- Enforced on the server: while a probe is active nothing can jog, home, send commands or start a job, from any client
- Refuses to start if the probe input is already triggered; stale or double confirmations are ignored

### Autolevel (PCB milling)
Scan, then **write a new levelled G-code file**, then run that. The levelling is done on the server, so what runs is exactly what you can inspect and download.
- Grid scan (2 to 30 points each way) with a **Use loaded G-code area** button; same connect/remove confirmations as every probe
- Heights are measured in work coordinates (0 = your Z0), so set Z0 on the board surface first (PCB Z probe)
- Any missed point aborts the scan; nothing is ever recorded as "flat"
- Height map is saved on the server (survives restarts), and can be downloaded/loaded as JSON per board or fixture
- Apply: every move gets the surface height added; long moves and arcs are split into short segments so the correction follows the surface (bilinear interpolation)
- Programs that cannot be levelled correctly (relative mode G91, inches, R-format arcs, G92/G10/G28/G30/G53, non-XY planes) are **refused with the line number** instead of run partly levelled
- Warnings for points outside the scanned area and for a work zero that moved since the scan; a badge shows whether the loaded program is levelled
- Download the levelled program from the panel; **Use original** puts the file back

Not yet built: 3D visualizer, docking layout, Home Assistant, camera.

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
docker run -p 8080:8080 -v demonx-data:/app/data --device=/dev/ttyUSB0 demonx
```

## Layout

- `server/` Node + TypeScript: GRBL controller, streamer, simulator, WebSocket hub
- `web/` React + Vite UI
- `shared/protocol.ts` message types shared by both
- `v1-archive/` original prototype
