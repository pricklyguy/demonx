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

const PORT = Number(process.env.PORT ?? 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

const controller = new GrblController();
const probe = new ProbeManager(controller);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
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
controller.on('log', (d) => broadcast({ type: 'log', data: d }));

// keep job elapsed time ticking for all clients
setInterval(() => { if (controller.job.state === 'running') broadcast({ type: 'job', data: { ...controller.job, elapsedMs: Date.now() - (controller.job.startedAt ?? Date.now()) } }); }, 1000);

wss.on('connection', (ws) => {
  send(ws, {
    type: 'snapshot',
    data: {
      connection: controller.connection, status: controller.status, job: controller.job, probe: probe.info,
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
          const t = msg.target === 'simulator'
            ? new SimulatorTransport(Number(process.env.SIM_SPEED ?? 1))
            : new SerialTransport(msg.target, msg.baud ?? 115200);
          return await controller.connect(t, msg.target);
        }
        case 'disconnect': return await controller.disconnect();
        case 'probeStart': return probe.start(msg.kind, msg.settings);
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
