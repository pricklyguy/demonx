import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { GrblController } from './controller.js';
import { SerialTransport, listSerialPorts } from './transport.js';
import { SimulatorTransport } from './simulator.js';
import { ProbeManager } from './probe.js';
import { HeightMapStore, validateHeightMap } from './heightmap.js';

const PORT = Number(process.env.PORT ?? 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

const controller = new GrblController();
const probe = new ProbeManager(controller);
const dataDir = process.env.DEMONX_DATA ?? path.resolve(here, '../../data');
const heightmaps = new HeightMapStore(dataDir);
controller.heightMap = () => heightmaps.map;
probe.on('heightmap', (m) => heightmaps.set(m));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/job.nc') {
    const name = controller.job.name || 'job.nc';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"` });
    res.end(controller.jobText());
    return;
  }
  if (url.pathname === '/api/heightmap.json') {
    if (!heightmaps.map) { res.writeHead(404).end('No height map'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="heightmap.json"' });
    res.end(JSON.stringify(heightmaps.map));
    return;
  }
  let file = path.join(webRoot, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(webRoot)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('DemonX server running. Build the UI with: npm run build');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });
const send = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const broadcast = (m: ServerMessage) => wss.clients.forEach((c) => send(c as WebSocket, m));

controller.on('status', (d) => broadcast({ type: 'status', data: d }));
controller.on('job', (d) => broadcast({ type: 'job', data: d }));
controller.on('connection', (d) => broadcast({ type: 'connection', data: d }));
probe.on('probe', (d) => broadcast({ type: 'probe', data: d }));
heightmaps.on('heightmap', (d) => broadcast({ type: 'heightmap', data: d }));
controller.on('log', (d) => broadcast({ type: 'log', data: d }));

// keep job elapsed time ticking for all clients
setInterval(() => { if (controller.job.state === 'running') broadcast({ type: 'job', data: { ...controller.job, elapsedMs: Date.now() - (controller.job.startedAt ?? Date.now()) } }); }, 1000);

wss.on('connection', (ws) => {
  send(ws, {
    type: 'snapshot',
    data: {
      connection: controller.connection, status: controller.status, job: controller.job, probe: probe.info, heightmap: heightmaps.map,
      clients: wss.clients.size, log: controller.logBuffer.slice(-100),
    },
  });
  broadcast({ type: 'clients', data: wss.clients.size });

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case 'listPorts': return send(ws, { type: 'ports', data: await listSerialPorts() });
        case 'connect': {
          let t;
          if (msg.target === 'simulator') {
            const sim = new SimulatorTransport(Number(process.env.SIM_SPEED ?? 1));
            // SIM_BOARD=1: a tilted, gently warped board instead of the XYZ touch block, to try autolevel
            if (process.env.SIM_BOARD) sim.surfaceFn = (x, y) => -10 + 0.02 * x + 0.01 * y + 0.1 * Math.sin(x / 8) * Math.cos(y / 8);
            t = sim;
          } else t = new SerialTransport(msg.target, msg.baud ?? 115200);
          return await controller.connect(t, msg.target);
        }
        case 'disconnect': return await controller.disconnect();
        case 'probeStart': return probe.start(msg.kind, msg.settings, msg.autolevel);
        case 'heightmapLoad': {
          const bad = validateHeightMap(msg.map);
          if (bad) return controller.log('err', `Height map not loaded: ${bad}`);
          heightmaps.set(msg.map);
          return controller.log('sys', `Height map loaded (${msg.map.cols} x ${msg.map.rows} points)`);
        }
        case 'heightmapClear': heightmaps.set(null); return controller.log('sys', 'Height map cleared');
        case 'probeConfirm': return probe.confirm(msg.id, msg.phase);
        case 'probeCancel': return probe.cancel(msg.id);
        default: return controller.handle(msg);
      }
    } catch (e) {
      controller.log('err', (e as Error).message);
    }
  });
  ws.on('close', () => broadcast({ type: 'clients', data: wss.clients.size }));
});

server.listen(PORT, () => console.log(`DemonX server on http://0.0.0.0:${PORT}`));
