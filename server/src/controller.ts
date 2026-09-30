import { EventEmitter } from 'node:events';
import type {
  ConnectionInfo, JobInfo, LogKind, LogLine, MachineStatus, ClientMessage, Vec3,
} from '../../shared/protocol.js';
import { emptyJob, emptyStatus } from '../../shared/protocol.js';
import { GRBL_ALARMS, GRBL_ERRORS, cleanGcode, parseStatus } from './parser.js';
import type { Transport } from './transport.js';

/** GRBL serial RX buffer is 128 bytes; keep one spare. FluidNC behaves the same. */
const RX_BUFFER = 127;
const POLL_MS = 200;
/** Largest single Z jog accepted from any client (protects the wasteboard). */
export const MAX_Z_JOG = 20;

export interface AckResult { ok: boolean; error?: string }
interface Pending { len: number; job: boolean; resolve?: (r: AckResult) => void }
interface Queued { line: string; resolve?: (r: AckResult) => void }
export interface ProbeHit { pos: Vec3; success: boolean }

const OVERRIDE_BYTES: Record<string, Record<string, number>> = {
  feed: { reset: 0x90, plus10: 0x91, minus10: 0x92, plus1: 0x93, minus1: 0x94 },
  rapid: { reset: 0x95, half: 0x96, quarter: 0x97 },
  spindle: { reset: 0x99, plus10: 0x9a, minus10: 0x9b, plus1: 0x9c, minus1: 0x9d },
};

/**
 * Owns the single connection to the machine. Everything that reaches the
 * controller goes through here so all browser clients share one consistent
 * state. Uses GRBL character-counting streaming for jobs.
 *
 * Events: 'status', 'job', 'connection', 'log', 'prb' (ProbeHit), 'alarm' (code), 'reset'
 */
export class GrblController extends EventEmitter {
  status: MachineStatus = emptyStatus();
  job: JobInfo = emptyJob();
  connection: ConnectionInfo = { connected: false, target: '' };
  readonly logBuffer: LogLine[] = [];

  private transport?: Transport;
  private rx = '';
  private poll?: NodeJS.Timeout;
  private pending: Pending[] = [];
  private used = 0;
  private manualQueue: Queued[] = [];
  /** When set, client commands that could move the machine are refused (e.g. mid-probe). */
  lock?: string;
  private jobLines: string[] = [];
  private jobIndex = 0;
  private stopping = false;

  // ---------- connection ----------
  async connect(transport: Transport, target: string) {
    if (this.transport) await this.disconnect();
    this.transport = transport;
    transport.on('data', (d: string) => this.onData(d));
    transport.on('error', (e: Error) => this.log('err', `Connection error: ${e.message}`));
    transport.on('close', () => this.onClosed());
    await transport.open();
    this.connection = { connected: true, target };
    this.status = { ...emptyStatus(), state: 'Idle' };
    this.emit('connection', this.connection);
    this.emit('status', this.status);
    this.log('sys', `Connected to ${target}`);
    this.poll = setInterval(() => this.transport?.write('?'), POLL_MS);
  }

  async disconnect() {
    const t = this.transport;
    if (!t) return;
    this.transport = undefined;
    await t.close().catch(() => {});
    this.onClosed(true);
  }

  private onClosed(manual = false) {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.transport = undefined;
    this.abortQueued('Connection lost');
    this.rx = '';
    if (this.job.state === 'running' || this.job.state === 'paused') {
      this.failJob('Connection lost during job');
    }
    if (this.connection.connected) this.log(manual ? 'sys' : 'err', 'Disconnected');
    this.connection = { connected: false, target: this.connection.target };
    this.status = emptyStatus();
    this.emit('connection', this.connection);
    this.emit('status', this.status);
  }

  // ---------- incoming ----------
  private onData(chunk: string) {
    this.rx += chunk;
    let i: number;
    while ((i = this.rx.indexOf('\n')) >= 0) {
      const line = this.rx.slice(0, i).trim();
      this.rx = this.rx.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    if (line.startsWith('<')) {
      const s = parseStatus(line, this.status);
      if (s) {
        this.status = s;
        this.emit('status', s);
        this.checkJobDone();
      }
      return;
    }
    if (line === 'ok') {
      this.log('rx', line);
      this.ack(false);
    } else if (line.startsWith('error:')) {
      const code = Number(line.slice(6));
      this.log('err', `${line}${GRBL_ERRORS[code] ? ` (${GRBL_ERRORS[code]})` : ''}`);
      this.ack(true);
    } else if (line.startsWith('ALARM:')) {
      const code = Number(line.slice(6));
      this.log('err', `${line}${GRBL_ALARMS[code] ? ` (${GRBL_ALARMS[code]})` : ''}`);
      if (this.job.state === 'running' || this.job.state === 'paused') this.failJob(`Alarm: ${line}`);
      this.emit('alarm', code);
    } else if (line.startsWith('[PRB:')) {
      this.log('rx', line);
      const m = /^\[PRB:([^:\]]*):(\d)\]$/.exec(line);
      if (m) {
        const [x = 0, y = 0, z = 0] = m[1].split(',').map(Number);
        this.emit('prb', { pos: { x, y, z }, success: m[2] === '1' } satisfies ProbeHit);
      }
    } else if (/^Grbl |^\[MSG:.*FluidNC|^\[VER:/i.test(line)) {
      // banner after (re)boot/reset: controller RX buffer is empty again
      this.abortPending('Controller reset');
      this.emit('reset');
      this.connection = { ...this.connection, firmware: line };
      this.emit('connection', this.connection);
      this.log('rx', line);
      this.pump();
    } else {
      this.log('rx', line);
    }
  }

  private ack(isError: boolean) {
    const p = this.pending.shift();
    if (!p) return;
    this.used -= p.len;
    p.resolve?.({ ok: !isError, error: isError ? 'controller error' : undefined });
    if (p.job) {
      this.job = { ...this.job, doneLines: this.job.doneLines + 1 };
      if (isError) {
        this.failJob(`Error on line ${this.job.doneLines}: ${this.jobLines[this.job.doneLines - 1]}`);
        return;
      }
      this.emitJob();
      // Completion is judged only from a status report that arrives after the
      // last ok; an Idle report from before it may predate the queued motion.
    }
    this.pump();
  }

  // ---------- sending ----------
  /** Queue a single line (goes ahead of job lines). */
  sendLine(line: string) {
    if (!this.connection.connected) return this.log('err', 'Not connected');
    const l = line.trim();
    if (!l) return;
    if (this.lock) return this.log('err', `Blocked: ${this.lock}`);
    if (l.startsWith('$J=') === false && (this.job.state === 'running' || this.job.state === 'paused')) {
      return this.log('err', 'Job in progress: command blocked');
    }
    this.manualQueue.push({ line: l });
    this.pump();
  }

  /**
   * Internal send for server-driven sequences (probing). Bypasses the client
   * lock. Resolves when the controller acknowledges the line; never rejects.
   */
  sendInternal(line: string): Promise<AckResult> {
    if (!this.connection.connected) return Promise.resolve({ ok: false, error: 'Not connected' });
    return new Promise((resolve) => {
      this.manualQueue.push({ line, resolve });
      this.pump();
    });
  }

  /** Resolve when the machine reports Idle; reject on alarm, disconnect or timeout. */
  waitIdle(timeoutMs = 180_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.off('status', onStatus); this.off('connection', onConn);
        err ? reject(err) : resolve();
      };
      const onStatus = (s: MachineStatus) => {
        if (s.state === 'Idle') done();
        else if (s.state === 'Alarm') done(new Error('Machine in alarm'));
      };
      const onConn = (c: ConnectionInfo) => { if (!c.connected) done(new Error('Disconnected')); };
      const timer = setTimeout(() => done(new Error('Timed out waiting for machine to stop')), timeoutMs);
      this.on('status', onStatus); this.on('connection', onConn);
    });
  }

  /** Drop everything queued or in flight, settling any awaiting callers as failed. */
  private abortQueued(reason: string) {
    const q = this.manualQueue; this.manualQueue = [];
    q.forEach((e) => e.resolve?.({ ok: false, error: reason }));
    this.abortPending(reason);
  }

  private abortPending(reason: string) {
    const p = this.pending; this.pending = []; this.used = 0;
    p.forEach((e) => e.resolve?.({ ok: false, error: reason }));
  }

  realtime(byte: string | number) {
    if (!this.transport) return;
    this.transport.write(typeof byte === 'number' ? Buffer.from([byte]) : byte);
  }

  private pump() {
    if (!this.transport) return;
    for (;;) {
      let line: string | undefined;
      let isJob = false;
      let resolve: Queued['resolve'];
      if (this.manualQueue.length) {
        line = this.manualQueue[0].line;
        resolve = this.manualQueue[0].resolve;
      } else if (this.job.state === 'running' && this.jobIndex < this.jobLines.length) {
        line = this.jobLines[this.jobIndex];
        isJob = true;
      }
      if (line === undefined) return;
      const len = line.length + 1;
      if (this.used + len > RX_BUFFER) return;
      if (isJob) { this.jobIndex++; this.job = { ...this.job, sentLines: this.jobIndex }; } else this.manualQueue.shift();
      this.pending.push({ len, job: isJob, resolve });
      this.used += len;
      this.transport.write(line + '\n');
      this.log('tx', line);
      if (isJob) this.emitJob();
    }
  }

  // ---------- commands from clients ----------
  handle(msg: ClientMessage) {
    if (this.lock && !['hold', 'reset', 'jogCancel', 'override'].includes(msg.type)) {
      return this.log('err', `Blocked: ${this.lock}`);
    }
    switch (msg.type) {
      case 'send': return this.sendLine(msg.line);
      case 'jog': {
        if (this.job.state === 'running') return this.log('err', 'Cannot jog during a job');
        const dz = msg.dz ? Math.max(-MAX_Z_JOG, Math.min(MAX_Z_JOG, msg.dz)) : 0;
        if (msg.dz && dz !== msg.dz) this.log('sys', `Z jog limited to ${MAX_Z_JOG} mm`);
        const parts = [
          msg.dx ? `X${msg.dx}` : '', msg.dy ? `Y${msg.dy}` : '', dz ? `Z${dz}` : '',
        ].join('');
        if (!parts) return;
        return this.sendLine(`$J=G21G91${parts}F${msg.feed}`);
      }
      case 'jogCancel': return this.realtime(0x85);
      case 'home': return this.sendLine('$H');
      case 'unlock': return this.sendLine('$X');
      case 'goto': {
        if (!(msg.feed > 0 && msg.feed <= 10000)) return this.log('err', 'Invalid feed for go-to move');
        if (msg.target === 'z0') return this.sendLine(`G21G90G1Z0F${msg.feed}`);
        // Never drag the tool across the work below the surface
        if (this.status.wpos.z < -0.001) {
          return this.log('err', 'Raise Z to Z0 or above before going to XY0 (the tool is below the work surface)');
        }
        return this.sendLine(`G21G90G1X0Y0F${msg.feed}`);
      }
      case 'zero': {
        const axes = msg.axes.map((a) => `${a}0`).join('');
        return axes ? this.sendLine(`G10L20P0${axes}`) : undefined;
      }
      case 'reset': return this.softReset();
      case 'hold': return this.hold();
      case 'resume': return this.resume();
      case 'override': {
        const b = OVERRIDE_BYTES[msg.kind]?.[msg.action];
        return b !== undefined ? this.realtime(b) : undefined;
      }
      case 'jobLoad': return this.loadJob(msg.name, msg.content);
      case 'jobStart': return this.startJob();
      case 'jobPause': return this.hold();
      case 'jobResume': return this.resume();
      case 'jobStop': return this.stopJob();
    }
  }

  private hold() {
    this.realtime('!');
    if (this.job.state === 'running') { this.job = { ...this.job, state: 'paused' }; this.emitJob(); }
  }

  private resume() {
    this.realtime('~');
    if (this.job.state === 'paused') { this.job = { ...this.job, state: 'running' }; this.emitJob(); this.pump(); }
  }

  softReset() {
    this.realtime(0x18);
    this.abortQueued('Machine reset');
    this.emit('reset');
    if (this.job.state === 'running' || this.job.state === 'paused') this.failJob('Machine reset during job');
  }

  // ---------- job ----------
  loadJob(name: string, content: string) {
    if (this.job.state === 'running' || this.job.state === 'paused') {
      return this.log('err', 'Cannot load a file while a job is running');
    }
    this.jobLines = content.split(/\r?\n/).map(cleanGcode).filter(Boolean);
    this.jobIndex = 0;
    this.job = { ...emptyJob(), state: 'loaded', name, totalLines: this.jobLines.length };
    this.log('sys', `Loaded ${name}: ${this.jobLines.length} lines`);
    this.emitJob();
  }

  startJob() {
    if (!this.connection.connected) return this.log('err', 'Not connected');
    if (this.job.state !== 'loaded' && this.job.state !== 'done' && this.job.state !== 'error') {
      return this.log('err', 'No job loaded');
    }
    if (this.status.state !== 'Idle') return this.log('err', `Machine is ${this.status.state}, not Idle`);
    this.jobIndex = 0;
    this.job = { ...this.job, state: 'running', sentLines: 0, doneLines: 0, startedAt: Date.now(), elapsedMs: 0, error: undefined };
    this.log('sys', `Job started: ${this.job.name}`);
    this.emitJob();
    this.pump();
  }

  /** Feed hold, wait for the machine to stop, then soft reset (spindle off). */
  async stopJob() {
    if (this.stopping) return;
    if (this.job.state !== 'running' && this.job.state !== 'paused') return;
    this.stopping = true;
    try {
      this.realtime('!');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !this.status.state.startsWith('Hold') && this.status.state !== 'Idle') {
        await new Promise((r) => setTimeout(r, 50));
      }
      this.realtime(0x18);
      this.abortQueued('Job stopped');
      this.job = { ...this.job, state: 'loaded', sentLines: 0, doneLines: 0, error: undefined };
      this.jobIndex = 0;
      this.log('sys', 'Job stopped. Machine reset: re-check position before restarting.');
      this.emitJob();
    } finally {
      this.stopping = false;
    }
  }

  private failJob(reason: string) {
    this.job = { ...this.job, state: 'error', error: reason };
    this.log('err', reason);
    this.emitJob();
  }

  private checkJobDone() {
    const j = this.job;
    if (j.state === 'running' && j.doneLines >= j.totalLines && this.status.state === 'Idle') {
      this.job = { ...j, state: 'done', elapsedMs: Date.now() - (j.startedAt ?? Date.now()) };
      this.log('sys', `Job complete in ${(this.job.elapsedMs / 1000).toFixed(1)}s`);
      this.emitJob();
    }
  }

  private emitJob() {
    if (this.job.state === 'running' && this.job.startedAt) {
      this.job = { ...this.job, elapsedMs: Date.now() - this.job.startedAt };
    }
    this.emit('job', this.job);
  }

  // ---------- log ----------
  log(kind: LogKind, text: string) {
    const entry = { t: Date.now(), kind, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 300) this.logBuffer.shift();
    this.emit('log', entry);
  }
}
