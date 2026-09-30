# DemonX CNC Controller

A lightweight, browser-based CNC controller for **FluidNC** machines. Built as a single HTML file served by a small Node.js server — no cloud, no subscriptions, no install. Open Chrome on any device on your network and control your machine.

![Private](https://img.shields.io/badge/status-private%20beta-orange)
![FluidNC](https://img.shields.io/badge/firmware-FluidNC-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)

---

## Features

- **Multi-client** — control from one browser, monitor from any other device on the network simultaneously
- **Draggable, resizable panels** — arrange your workspace exactly how you want, layout saved per browser
- **Collapsible panels** — hide what you don't need, screen real estate preserved
- **Dark / Light theme**

### Machine Control
- Real-time DRO (Digital Readout) — Work and Machine positions
- Per-axis Home and Zero buttons
- Feed and Spindle override controls (real-time GRBL bytes)
- Jog panel with cardinal + diagonal directions, hold-to-jog, configurable step and feed
- HOLD / RESUME / RESET in toolbar

### Probing
- Z-only probe (2-pass fast/slow)
- 3-axis XYZ probe (2-pass each axis)
- PCB Z probe (2-pass, direct surface contact)
- Configurable plate thickness, feeds, and travel per probe type
- **PCB Fixture Home** — saves a machine coordinate position, one button moves and zeros XY every time

### Autolevel (PCB milling)
- Configurable grid scan (cols × rows)
- Border offset — keep-out zone for clamps or board edges
- Real-time height map display
- Save and reload scan as JSON
- Applies Z correction in real-time during G-code job

### File & Visualizer
- Load G-code files
- Job time estimate on load
- G-code visualizer with zoom and pan
- Progress tracking during job run

### Spindle
- CW on/off with configurable RPM
- Speed presets (1k / 5k / 10k / 18k / 24k)
- Live RPM readout

### Camera
- RTSP stream via server-side MJPEG proxy (requires ffmpeg)
- Reolink camera presets (main/sub stream)

### Config
- FluidNC `$$` settings viewer with filter and inline edit
- Runtime-editable settings only (config.yaml settings are read-only by FluidNC design)

### Home Assistant Integration
- `/api/status` endpoint — REST sensor compatible
- Exposes: state, work position XYZ, feed rate, spindle RPM, connected clients

---

## Requirements

| Component | Requirement |
|-----------|-------------|
| Node.js | v18.0.0 or higher |
| Chrome / Edge | Required for Web Serial (local mode) |
| Any browser | For network monitoring clients |
| ffmpeg | Optional — only needed for IP camera proxy |
| FluidNC | Tested on FluidNC v3.x |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/pricklyguy/demonx.git
cd demonx
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

**Linux / Mac:**
```bash
bash start.sh
```

**Windows:**
```
start.bat
```

**Or directly:**
```bash
node server.js
```

The server starts on port **8080** by default. Open your browser to:
```
http://localhost:8080          (on the server machine)
http://YOUR_SERVER_IP:8080     (from any device on the network)
```

---

## Autostart on Linux (PM2)

To start DemonX automatically on boot and open Chrome on login:

```bash
bash setup-autostart.sh
```

This installs PM2, registers DemonX as a system service, and adds a desktop autostart entry for Chrome.

**Useful PM2 commands:**
```bash
pm2 status              # check if running
pm2 restart demonx      # restart after updating files
pm2 logs demonx         # view server logs
pm2 stop demonx         # stop the server
```

---

## Usage

1. Plug the CNC controller USB into the **server machine only**
2. Open `http://YOUR_SERVER_IP:8080` in Chrome on any device
3. In the **Connection** panel, select the serial port and click **Connect**
4. The serial connection is shared — additional browsers can monitor without disconnecting the active session

---

## Home Assistant Integration

Add to your `configuration.yaml`:

```yaml
rest:
  - resource: http://YOUR_SERVER_IP:8080/api/status
    scan_interval: 10
    sensor:
      - name: "DemonX State"
        value_template: "{{ value_json.state }}"
      - name: "DemonX Feed Rate"
        value_template: "{{ value_json.feed }}"
        unit_of_measurement: "mm/min"
      - name: "DemonX Spindle RPM"
        value_template: "{{ value_json.rpm }}"
        unit_of_measurement: "RPM"
    binary_sensor:
      - name: "DemonX Online"
        value_template: "{{ value_json.connected }}"
        device_class: connectivity
```

See `demonx-ha.yaml` for the full sensor configuration.

---

## Project Structure

```
demonx/
├── demonx.html          # Complete UI — single file, no build step
├── server.js            # Node.js server — serial bridge + MJPEG proxy + HA API
├── package.json
├── setup-autostart.sh   # PM2 autostart setup for Linux
├── start.sh             # Quick start for Linux/Mac
├── start.bat            # Quick start for Windows
└── demonx-ha.yaml       # Home Assistant configuration
```

---

## Updating

Drop in the new `demonx.html` and/or `server.js`, then:

```bash
pm2 restart demonx
```

Refresh your browser with **F5**. No rebuild needed.

---

## Contributing

Private beta — not yet open for public contributions. Stay tuned.

---

## License

TBD — private repository, all rights reserved until public release.

---

*Built for the CNC community. Designed to actually work at the machine.*
