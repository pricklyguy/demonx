import { EventEmitter } from 'node:events';
import type { Transport } from './transport.js';

interface Vec { x: number; y: number; z: number }
interface Move extends Vec { feed: number; rapid: boolean; probe?: { axis: 'x' | 'y' | 'z'; dir: 1 | -1 } }

const PLANNER_SIZE = 15;
const RAPID_RATE = 3000; // mm/min
/** How far below the block's top edge the tool must be to reach its side faces */
const SIDE_MARGIN = 2;

/**
 * A virtual corner block the simulated probe can touch, in machine coordinates.
 * The block is solid where x >= xFace, y >= yFace and z <= zTop, so the top
 * plate, the left face and the front face are all reachable like on a real
 * XYZ touch block, and moving beside it triggers nothing.
 */
export interface SimSurfaces { zTop: number; xFace: number; yFace: number }

/**
 * A tiny fake GRBL 1.1 controller used for development and tests, so the whole
 * stack can be exercised without a machine. It models what matters to a sender:
 * real-time commands, a bounded planner (ok is withheld when it is full, which
 * exercises the character-counting streamer), hold/resume, jog, work offsets,
 * and G38.2 probing against configurable virtual surfaces.
 */
export class SimulatorTransport extends EventEmitter implements Transport {
  private pos: Vec = { x: 0, y: 0, z: 0 };
  private wco: Vec = { x: 0, y: 0, z: 0 };
  private planner: Move[] = [];
  private deferredOk = 0;
  private held = false;
  private alarm = false;
  private jogging = false;
  private relative = false;
  private motion: 0 | 1 = 0;
  private feed = 0;
  private spindle = 0;
  private modalFeed = 500;
  private rxBuf = '';
  private timer?: NodeJS.Timeout;
  private ov = { feed: 100, rapid: 100, spindle: 100 };
  private statusCount = 0;
  private touched = false; // simulated user touching the probe (via $SIM=TOUCH)

  /** Whether the probe is wired up. When false it never triggers. */
  probeConnected = true;
  surfaces: SimSurfaces = { zTop: -10, xFace: -8, yFace: -8 };
  /** When set, the probe touches this surface (machine Z at machine x,y) instead of the corner block. */
  surfaceFn?: (x: number, y: number) => number;

  /** speed multiplier so tests do not have to run in real time */
  constructor(private speed = 1) { super(); }

  async open() {
    this.timer = setInterval(() => this.tick(0.02), 20);
    setTimeout(() => this.emit('data', "\r\nGrbl 1.1h ['$' for help]\r\n"), 20);
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emit('close');
  }

  /** Test hook: pretend a user is touching the probe to the bit. */
  setTouched(on: boolean) { this.touched = on; }

  write(data: string | Buffer) {
    const s = typeof data === 'string' ? data : data.toString('latin1');
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (ch === '?') this.emitStatus();
      else if (ch === '!') { if (this.planner.length || this.jogging) this.held = true; }
      else if (ch === '~') this.held = false;
      else if (code === 0x18) this.softReset();
      else if (code === 0x85) { if (this.jogging) { this.planner = []; this.jogging = false; this.held = false; } }
      else if (code >= 0x90 && code <= 0x9d) this.override(code);
      else { this.rxBuf += ch; if (ch === '\n') { this.line(this.rxBuf.trim()); this.rxBuf = ''; } }
    }
  }

  private out(s: string) { setImmediate(() => this.emit('data', s + '\r\n')); }

  private softReset() {
    this.planner = []; this.deferredOk = 0; this.held = false; this.jogging = false;
    this.rxBuf = ''; this.spindle = 0; this.alarm = false; this.relative = false; this.motion = 0;
    this.out("\r\nGrbl 1.1h ['$' for help]");
  }

  private override(code: number) {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    if (code === 0x90) this.ov.feed = 100;
    else if (code === 0x91) this.ov.feed = clamp(this.ov.feed + 10, 10, 200);
    else if (code === 0x92) this.ov.feed = clamp(this.ov.feed - 10, 10, 200);
    else if (code === 0x93) this.ov.feed = clamp(this.ov.feed + 1, 10, 200);
    else if (code === 0x94) this.ov.feed = clamp(this.ov.feed - 1, 10, 200);
    else if (code === 0x95) this.ov.rapid = 100;
    else if (code === 0x96) this.ov.rapid = 50;
    else if (code === 0x97) this.ov.rapid = 25;
    else if (code === 0x99) this.ov.spindle = 100;
    else if (code === 0x9a) this.ov.spindle = clamp(this.ov.spindle + 10, 10, 200);
    else if (code === 0x9b) this.ov.spindle = clamp(this.ov.spindle - 10, 10, 200);
  }

  private line(raw: string) {
    const l = raw.replace(/\s+/g, '').toUpperCase();
    if (!l) return this.out('ok');
    if (l === '$SIM=TOUCH') { this.touched = true; return this.out('ok'); }
    if (l === '$SIM=RELEASE') { this.touched = false; return this.out('ok'); }
    if (l === '$H') { this.pos = { x: 0, y: 0, z: 0 }; this.alarm = false; return this.out('ok'); }
    if (l === '$X') { this.alarm = false; return this.out('ok'); }
    if (this.alarm) return this.out('error:9');
    if (l.startsWith('$J=')) return this.gcode(l.slice(3), true);
    if (l.startsWith('$')) return this.out('ok');
    this.gcode(l, false);
  }

  private gcode(l: string, jog: boolean) {
    const words = [...l.matchAll(/([A-Z])(-?\d*\.?\d+)/g)].map((m) => ({ c: m[1], v: Number(m[2]), raw: m[2] }));
    const val = (c: string) => words.find((w) => w.c === c)?.v;
    const g = (n: number) => words.some((w) => w.c === 'G' && w.v === n);

    if (g(90)) this.relative = false;
    if (g(91)) this.relative = true;
    const s = val('S'); if (s !== undefined) this.spindle = s;
    if (words.some((w) => w.c === 'M' && (w.v === 3 || w.v === 4)) && s === undefined) this.spindle = this.spindle || 1000;
    if (words.some((w) => w.c === 'M' && w.v === 5)) this.spindle = 0;
    const f = val('F'); if (f !== undefined) this.modalFeed = f;

    const axes = { x: val('X'), y: val('Y'), z: val('Z') };
    const anyAxis = axes.x !== undefined || axes.y !== undefined || axes.z !== undefined;

    if (g(10) && words.some((w) => w.c === 'L' && w.v === 20)) {
      for (const k of ['x', 'y', 'z'] as const) {
        const v = axes[k]; if (v !== undefined) this.wco[k] = this.pos[k] - v;
      }
      this.statusCount = 0; // like GRBL: report the changed WCO on the very next status
      return this.out('ok');
    }

    // G38.2 straight probe
    if (words.some((w) => w.c === 'G' && Math.abs(w.v - 38.2) < 1e-6)) return this.probeCycle(axes);

    if (g(0) && !g(1)) this.motion = 0;
    if (g(1)) this.motion = 1;
    if (!anyAxis) return this.out('ok');

    const base: Vec = this.planner.length ? { ...this.planner[this.planner.length - 1] } : { ...this.pos };
    const tgt: Vec = { x: base.x, y: base.y, z: base.z };
    for (const k of ['x', 'y', 'z'] as const) {
      const v = axes[k]; if (v === undefined) continue;
      tgt[k] = this.relative ? base[k] + v : v + this.wco[k];
    }
    const rapid = !jog && this.motion === 0;
    this.planner.push({ ...tgt, feed: rapid ? RAPID_RATE : this.modalFeed, rapid });
    if (jog) this.jogging = true;
    if (this.planner.length <= PLANNER_SIZE) this.out('ok');
    else this.deferredOk++;
  }

  private probeCycle(axes: { x?: number; y?: number; z?: number }) {
    const given = (['x', 'y', 'z'] as const).filter((k) => axes[k] !== undefined);
    if (given.length !== 1) return this.out('error:33'); // this sim only does single-axis probes
    if (this.probeTriggered()) { this.alarm = true; this.out('ALARM:4'); return this.out('ok'); }
    const axis = given[0];
    const dist = axes[axis]!;
    const base: Vec = this.planner.length ? { ...this.planner[this.planner.length - 1] } : { ...this.pos };
    const tgt = { ...base };
    tgt[axis] = this.relative ? base[axis] + dist : dist + this.wco[axis];
    this.planner.push({ ...tgt, feed: this.modalFeed, rapid: false, probe: { axis, dir: tgt[axis] >= base[axis] ? 1 : -1 } });
    this.out('ok');
  }

  /** Is the probe input currently closed (tool point touching or inside the block)? */
  private probeTriggered(at: Vec = this.pos): boolean {
    if (!this.probeConnected) return false;
    if (this.touched) return true;
    if (this.surfaceFn) return at.z <= this.surfaceFn(at.x, at.y) + 1e-9;
    const e = 1e-6;
    const { zTop, xFace, yFace } = this.surfaces;
    return at.x >= xFace - e && at.y >= yFace - e && at.z <= zTop + e;
  }

  /**
   * Clamp a probe move to the block surface it is travelling into, if it made contact.
   * The side faces only exist below the top edge: a tool travelling sideways at
   * (or above) the top height rides over the block and touches nothing.
   */
  private contact(axis: 'x' | 'y' | 'z', p: Vec): Vec | undefined {
    if (!this.probeTriggered(p)) return undefined;
    if (this.surfaceFn) return axis === 'z' ? { ...p, z: this.surfaceFn(p.x, p.y) } : undefined;
    const { zTop, xFace, yFace } = this.surfaces;
    if (axis !== 'z' && p.z > zTop - SIDE_MARGIN) return undefined;
    return { ...p, [axis]: axis === 'z' ? zTop : axis === 'x' ? xFace : yFace };
  }

  private tick(dt: number) {
    const cur = this.planner[0];
    if (!cur || this.held) return;
    const rate = cur.feed * (cur.rapid ? this.ov.rapid : this.ov.feed) / 100;
    this.feed = rate;
    const budget = (rate / 60) * dt * this.speed;
    const dx = cur.x - this.pos.x, dy = cur.y - this.pos.y, dz = cur.z - this.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    const arrived = dist <= budget;
    const next: Vec = arrived ? { x: cur.x, y: cur.y, z: cur.z }
      : { x: this.pos.x + dx * budget / dist, y: this.pos.y + dy * budget / dist, z: this.pos.z + dz * budget / dist };

    if (cur.probe) {
      const hit = this.contact(cur.probe.axis, next);
      if (hit) { this.pos = hit; this.finishProbe(true); return; }
      if (arrived) { this.pos = next; this.finishProbe(false); return; }
    }

    this.pos = next;
    if (arrived) {
      this.planner.shift();
      if (this.jogging && !this.planner.length) this.jogging = false;
      if (this.deferredOk > 0) { this.deferredOk--; this.out('ok'); }
    }
    if (!this.planner.length) this.feed = 0;
  }

  private finishProbe(success: boolean) {
    this.planner.shift();
    const f = (n: number) => n.toFixed(3);
    this.out(`[PRB:${f(this.pos.x)},${f(this.pos.y)},${f(this.pos.z)}:${success ? 1 : 0}]`);
    if (!success) { this.planner = []; this.alarm = true; this.out('ALARM:5'); }
    if (!this.planner.length) this.feed = 0;
  }

  private emitStatus() {
    const busy = this.planner.length > 0;
    const state = this.alarm ? 'Alarm' : this.held ? 'Hold:0' : this.jogging ? 'Jog' : busy ? 'Run' : 'Idle';
    const f = (n: number) => n.toFixed(3);
    let s = `<${state}|MPos:${f(this.pos.x)},${f(this.pos.y)},${f(this.pos.z)}|FS:${Math.round(this.feed)},${this.spindle}`;
    if (this.statusCount++ % 5 === 0) {
      s += `|WCO:${f(this.wco.x)},${f(this.wco.y)},${f(this.wco.z)}|Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}`;
    }
    if (this.probeTriggered()) s += '|Pn:P';
    this.out(s + '>');
  }
}
