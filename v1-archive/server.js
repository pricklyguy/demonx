/**
 * DemonX Server v2
 * - Serves demonx.html with no-cache headers
 * - Single shared serial connection broadcast to ALL WebSocket clients
 * - Server-side status polling (clients don't poll individually)
 * - RTSP → MJPEG proxy (unchanged)
 */

'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const url       = require('url');
const os        = require('os');
const { spawn } = require('child_process');

let SerialPort, WebSocketServer;
try {
  ({ SerialPort } = require('serialport'));
} catch(e) { console.error('ERROR: serialport not installed. Run: npm install'); process.exit(1); }
try {
  ({ WebSocketServer } = require('ws'));
} catch(e) { console.error('ERROR: ws not installed. Run: npm install'); process.exit(1); }

const PORT = parseInt(process.env.PORT || '8080', 10);
const HTML  = path.join(__dirname, 'demonx.html');

// ── SHARED SERIAL SINGLETON ──────────────────────────────────────────────────
const serial = {
  port:      null,
  portPath:  null,
  baud:      115200,
  connected: false,
  lineBuf:   '',
  poll:      null,
  lastStatus: { state:'Disconnected', mpos:[0,0,0], wpos:[0,0,0], feed:0, rpm:0, updatedAt:null },
  job: { file:null, totalLines:0, sentLines:0, progress:0, running:false, startTime:null, elapsedSec:0 },
};

// ── WEBSOCKET CLIENT REGISTRY ────────────────────────────────────────────────
const clients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
function sendTo(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ── SERIAL MANAGEMENT ────────────────────────────────────────────────────────
function serialWrite(data) {
  if (serial.port?.isOpen) {
    serial.port.write(data, err => {
      if (err) broadcast({ type: 'error', msg: err.message });
    });
  }
}

function openSerial(portPath, baud) {
  // Close existing connection first
  if (serial.port) {
    clearInterval(serial.poll); serial.poll = null;
    try { serial.port.close(); } catch(_) {}
    serial.port = null;
    serial.connected = false;
  }

  const port = new SerialPort({ path: portPath, baudRate: baud, hupcl: false });
  serial.port    = port;
  serial.portPath = portPath;
  serial.baud    = baud;
  serial.lineBuf = '';

  port.on('open', () => {
    serial.connected = true;
    console.log(`[SER] Opened ${portPath} @ ${baud} — ${clients.size} client(s) watching`);
    broadcast({ type: 'connected', port: portPath });
    // Server-side polling — one poller for all clients
    serial.poll = setInterval(() => serialWrite('?'), 250);
  });

  port.on('data', chunk => {
    serial.lineBuf += chunk.toString();
    let nl;
    while ((nl = serial.lineBuf.indexOf('\n')) !== -1) {
      const line = serial.lineBuf.slice(0, nl).trimEnd();
      serial.lineBuf = serial.lineBuf.slice(nl + 1);
      if (line) {
        // Parse status reports to keep lastStatus fresh for /api/status
        if (line.startsWith('<')) parseStatusLine(line);
        broadcast({ type: 'data', line });
      }
    }
  });

  port.on('error', e => {
    // Suppress the Linux custom-baud-rate warning when port is already open
    if (e.message.includes('custom baud rate') || e.message.includes('Input/output error')) {
      if (serial.connected) return;
    }
    console.log(`[SER] Error: ${e.message}`);
    broadcast({ type: 'error', msg: e.message });
  });

  port.on('close', () => {
    console.log(`[SER] Closed ${portPath}`);
    clearInterval(serial.poll); serial.poll = null;
    serial.connected = false;
    serial.port = null;
    broadcast({ type: 'disconnected' });
  });
}

function closeSerial() {
  clearInterval(serial.poll); serial.poll = null;
  if (serial.port) {
    try { serial.port.close(); } catch(_) {}
    serial.port      = null;
    serial.connected = false;
  }
}

// ── ACTIVE RTSP STREAMS ──────────────────────────────────────────────────────
const activeStreams = new Map();

// ── STATUS PARSER (server-side, feeds /api/status) ────────────────────────
function parseStatusLine(line) {
  try {
    const stateMatch = line.match(/^<([^|>]+)/);
    if (stateMatch) serial.lastStatus.state = stateMatch[1].split(':')[0];
    const mpos = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/);
    if (mpos) serial.lastStatus.mpos = [parseFloat(mpos[1]), parseFloat(mpos[2]), parseFloat(mpos[3])];
    const wco  = line.match(/WCO:([-\d.]+),([-\d.]+),([-\d.]+)/);
    if (wco) {
      const wco_ = [parseFloat(wco[1]), parseFloat(wco[2]), parseFloat(wco[3])];
      serial.lastStatus.wpos = serial.lastStatus.mpos.map((v,i) => v - wco_[i]);
    }
    const fs = line.match(/FS:(\d+),(\d+)/);
    if (fs) { serial.lastStatus.feed = parseInt(fs[1]); serial.lastStatus.rpm = parseInt(fs[2]); }
    serial.lastStatus.updatedAt = new Date().toISOString();
  } catch(_) {}
}

// ── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Serve main UI — always fresh
  if (pathname === '/' || pathname === '/index.html' || pathname === '/demonx.html') {
    try {
      const html = fs.readFileSync(HTML);
      res.writeHead(200, {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma':        'no-cache',
        'Expires':       '0',
      });
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('demonx.html not found next to server.js');
    }
    return;
  }

  // HA command endpoint — POST /api/command  body: {"cmd":"!"}
  // Accepts: ! (hold)  ~ (resume)  \x18 (reset)  $X\n (unlock)  $H\n (home)
  if (pathname === '/api/command' && req.method === 'POST') {
    const ALLOWED = ['!', '~', '\x18', '$X\n', '$H\n', '$HX\n', '$HY\n', '$HZ\n'];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body);
        if (!ALLOWED.includes(cmd)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Command not allowed' }));
          return;
        }
        if (!serial.connected) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Serial not connected' }));
          return;
        }
        serialWrite(cmd);
        console.log(`[API] Command from HA: ${JSON.stringify(cmd)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // HA status endpoint — poll this from Home Assistant REST sensor
  if (pathname === '/api/status') {
    const j = serial.job;
    const elapsed = j.running && j.startTime ? Math.floor((Date.now() - j.startTime) / 1000) : j.elapsedSec;
    const remaining = (j.running && j.totalLines > 0 && j.sentLines > 0)
      ? Math.floor(elapsed / j.sentLines * (j.totalLines - j.sentLines)) : 0;
    function toHMS(s){ const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
    const payload = {
      connected:  serial.connected,
      port:       serial.portPath || null,
      state:      serial.lastStatus.state,
      mpos:       serial.lastStatus.mpos,
      wpos:       serial.lastStatus.wpos,
      feed:       serial.lastStatus.feed,
      rpm:        serial.lastStatus.rpm,
      clients:    clients.size,
      updatedAt:  serial.lastStatus.updatedAt,
      job: {
        file:          j.file,
        totalLines:    j.totalLines,
        sentLines:     j.sentLines,
        remainingLines:Math.max(0, j.totalLines - j.sentLines),
        progress:      j.progress,
        running:       j.running,
        elapsedSec:    elapsed,
        remainingSec:  remaining,
        elapsed:       toHMS(elapsed),
        remaining:     toHMS(remaining),
      },
    };
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
    return;
  }

  // List serial ports
  if (pathname === '/api/ports') {
    SerialPort.list().then(ports => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ports.map(p => ({
        path: p.path,
        manufacturer:  p.manufacturer  || '',
        serialNumber:  p.serialNumber  || '',
        friendlyName:  p.friendlyName  || p.path,
      }))));
    }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // RTSP → MJPEG proxy
  if (pathname === '/cam/proxy') {
    const rtspUrl = parsed.query.url;
    if (!rtspUrl) { res.writeHead(400); res.end('Missing ?url= parameter'); return; }

    const testFfmpeg = spawn('ffmpeg', ['-version']);
    testFfmpeg.on('error', () => { res.writeHead(503); res.end('ffmpeg not found in PATH.'); });
    testFfmpeg.on('close', code => {
      if (code !== 0 && code !== 1) { res.writeHead(503); res.end('ffmpeg error'); return; }

      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=demonxframe',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'close',
      });

      const streamId = Date.now() + '_' + Math.random().toString(36).slice(2);
      console.log(`[CAM] Starting stream ${streamId}: ${rtspUrl.replace(/:[^@]+@/, ':***@')}`);

      const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp', '-i', rtspUrl,
        '-f', 'mjpeg', '-q:v', '4', '-r', '10', '-vf', 'scale=640:-2', 'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      activeStreams.set(streamId, ffmpeg);

      let buf = Buffer.alloc(0);
      ffmpeg.stdout.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        let searchFrom = 0;
        while (true) {
          let start = -1, end = -1;
          for (let i = searchFrom; i < buf.length - 1; i++) {
            if (buf[i] === 0xFF && buf[i+1] === 0xD8) { start = i; break; }
          }
          if (start === -1) break;
          for (let i = start + 2; i < buf.length - 1; i++) {
            if (buf[i] === 0xFF && buf[i+1] === 0xD9) { end = i + 2; break; }
          }
          if (end === -1) break;
          const frame = buf.slice(start, end);
          try {
            res.write(`--demonxframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write('\r\n');
          } catch(_) { break; }
          buf = buf.slice(end);
          searchFrom = 0;
        }
      });

      ffmpeg.on('error', e => { console.log(`[CAM] ffmpeg error: ${e.message}`); try { res.end(); } catch(_) {} activeStreams.delete(streamId); });
      ffmpeg.on('close',  c => { console.log(`[CAM] Stream ${streamId} ended (code ${c})`); try { res.end(); } catch(_) {} activeStreams.delete(streamId); });
      req.on('close', () => {
        console.log(`[CAM] Client disconnected, killing stream ${streamId}`);
        ffmpeg.kill('SIGTERM');
        setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch(_) {} }, 2000);
        activeStreams.delete(streamId);
      });
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WEBSOCKET BRIDGE ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws/serial' });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  clients.add(ws);
  console.log(`[WS] Client connected from ${clientIp}  (${clients.size} connected)`);
  broadcast({ type: 'clients', count: clients.size });

  // Greet new client with port list
  SerialPort.list().then(ports => {
    sendTo(ws, { type: 'ports', ports: ports.map(p => ({
      path: p.path, manufacturer: p.manufacturer || '', friendlyName: p.friendlyName || p.path,
    }))});
  }).catch(() => {});

  // If serial is already open, catch this client up immediately
  if (serial.connected) {
    sendTo(ws, { type: 'connected', port: serial.portPath });
  }

  ws.on('message', async data => {
    let msg; try { msg = JSON.parse(data); } catch(_) { return; }

    switch (msg.cmd) {
      case 'list':
        try {
          const ports = await SerialPort.list();
          sendTo(ws, { type: 'ports', ports: ports.map(p => ({
            path: p.path, manufacturer: p.manufacturer || '', friendlyName: p.friendlyName || p.path,
          }))});
        } catch(e) { sendTo(ws, { type: 'error', msg: e.message }); }
        break;

      case 'connect':
        // If already open on the same port/baud, just confirm to this client
        if (serial.connected && serial.portPath === msg.port && serial.baud === (msg.baud||115200)) {
          sendTo(ws, { type: 'connected', port: serial.portPath });
          console.log(`[WS] ${clientIp} requested connect — port already open, confirming`);
        } else {
          openSerial(msg.port, msg.baud || 115200);
        }
        break;

      case 'jobUpdate':
        // Client broadcasts job state — cache for /api/status
        serial.job = {
          file:       msg.file || null,
          totalLines: msg.totalLines || 0,
          sentLines:  msg.sentLines  || 0,
          progress:   msg.progress   || 0,
          running:    msg.running    || false,
          startTime:  msg.running && !serial.job.running ? Date.now() : (msg.running ? serial.job.startTime : null),
          elapsedSec: msg.running && serial.job.startTime ? Math.floor((Date.now() - serial.job.startTime) / 1000) : serial.job.elapsedSec,
        };
        break;

      case 'write':
        serialWrite(msg.data);
        break;

      case 'disconnect':
        closeSerial();
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected from ${clientIp}  (${clients.size} remaining)`);
    broadcast({ type: 'clients', count: clients.size });
    // Serial stays open — other clients may still be watching
  });

  ws.on('error', e => console.log(`[WS] Error: ${e.message}`));
});

// ── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           DemonX CNC Controller Server           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Listening on port ${PORT}                           ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  const nets = os.networkInterfaces();
  for (const [, ifaces] of Object.entries(nets)) {
    for (const iface of (ifaces || [])) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const addr = `http://${iface.address}:${PORT}`;
        console.log(`║  ${addr.padEnd(48)}║`);
      }
    }
  }
  console.log(`║  http://localhost:${PORT.toString().padEnd(31)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Multiple browsers can monitor simultaneously     ║');
  console.log('║  Plug Doberman USB-C into THIS machine only       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  closeSerial();
  activeStreams.forEach(ffmpeg => { try { ffmpeg.kill(); } catch(_) {} });
  process.exit(0);
});
