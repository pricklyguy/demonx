import { EventEmitter } from 'node:events';
import type { Transport } from './transport.js';

interface Move { x: number; y: number; z: number; feed: number; rapid: boolean }

const PLANNER_SIZE = 15;
const RAPID_RATE = 3000; // mm/min

/**
 * A tiny fake GRBL 1.1 controller used for development and tests, so the whole
 * stack can be exercised without a machine. It models what matters to a sender:
 * real-time commands, a bounded planner (ok is withheld when it is full, which
 * exercises the character-counting streamer), hold/resume, jog and work offsets.
 */
export class SimulatorTransport extends EventEmitter implements Transport {
  private pos = { x: 0, y: 0, z: 0 };
  private wco = { x: 0, y: 0, z: 0 };
  private planner: Move[] = [];
  private deferredOk = 0;
  private held = false;
  private alarm = false;
  private jogging = false;
  private relative = false;
  private feed = 0;
  private spindle = 0;
  private modalFeed = 500;
  private rxBuf = '';
  private timer?: NodeJS.Timeout;
  private ov = { feed: 100, rapid: 100, spindle: 100 };
  private statusCount = 0;

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
    this.rxBuf = ''; this.spindle = 0;
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
    if (l === '$H') { this.pos = { x: 0, y: 0, z: 0 }; this.alarm = false; return this.out('ok'); }
    if (l === '$X') { this.alarm = false; return this.out('ok'); }
    if (this.alarm) return this.out('error:9');
    if (l.startsWith('$J=')) return this.gcode(l.slice(3), true);
    if (l.startsWith('$')) return this.out('ok');
    this.gcode(l, false);
  }

  private gcode(l: string, jog: boolean) {
    if (l.includes('G91')) this.relative = true;
    if (l.includes('G90')) this.relative = false;
    const num = (axis: string) => {
      const m = new RegExp(axis + '(-?\\d*\\.?\\d+)').exec(l);
      return m ? Number(m[1]) : undefined;
    };
    const s = num('S'); if (s !== undefined) this.spindle = /M5/.test(l) ? 0 : s;
    if (/M3|M4/.test(l) && s === undefined) this.spindle = this.spindle || 1000;
    if (/M5/.test(l)) this.spindle = 0;

    if (/G10L20/.test(l)) {
      const set = (k: 'x' | 'y' | 'z', a: string) => {
        const v = num(a); if (v !== undefined) this.wco[k] = this.pos[k] - v;
      };
      set('x', 'X'); set('y', 'Y'); set('z', 'Z');
      return this.out('ok');
    }

    const f = num('F'); if (f !== undefined) this.modalFeed = f;
    const hasMove = /X|Y|Z/.test(l.replace(/\$J=/, '')) && /G0|G1|G00|G01|^\$?J|X|Y|Z/.test(l) && (jog || /G0?[01](?!\d)|^[XYZ]/.test(l) || this.lastMotion);
    if (/G0?1(?!\d)/.test(l)) this.lastMotion = 1; else if (/G0?0(?!\d)/.test(l)) this.lastMotion = 0;
    const axes = ['X', 'Y', 'Z'].map((a) => num(a));
    if (!hasMove || axes.every((v) => v === undefined)) return this.out('ok');

    const base = this.planner.length ? this.planner[this.planner.length - 1] : { ...this.pos };
    const tgt = { x: base.x, y: base.y, z: base.z };
    (['x', 'y', 'z'] as const).forEach((k, i) => {
      const v = axes[i];
      if (v === undefined) return;
      const rel = jog ? this.relative : this.relative;
      tgt[k] = rel ? base[k] + v : v + this.wco[k];
    });
    const rapid = !jog && this.lastMotion === 0;
    this.planner.push({ ...tgt, feed: rapid ? RAPID_RATE : this.modalFeed, rapid });
    if (jog) this.jogging = true;
    if (this.planner.length <= PLANNER_SIZE) this.out('ok');
    else this.deferredOk++;
  }
  private lastMotion = 0;

  private tick(dt: number) {
    const cur = this.planner[0];
    if (!cur || this.held) return;
    const rate = cur.feed * (cur.rapid ? this.ov.rapid : this.ov.feed) / 100;
    this.feed = rate;
    let budget = (rate / 60) * dt * this.speed;
    const dx = cur.x - this.pos.x, dy = cur.y - this.pos.y, dz = cur.z - this.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= budget) {
      this.pos = { x: cur.x, y: cur.y, z: cur.z };
      this.planner.shift();
      if (this.jogging && !this.planner.length) this.jogging = false;
      if (this.deferredOk > 0) { this.deferredOk--; this.out('ok'); }
      budget -= dist;
    } else {
      const k = budget / dist;
      this.pos = { x: this.pos.x + dx * k, y: this.pos.y + dy * k, z: this.pos.z + dz * k };
    }
    if (!this.planner.length) this.feed = 0;
  }

  private emitStatus() {
    const busy = this.planner.length > 0;
    let state = this.alarm ? 'Alarm' : this.held ? 'Hold:0' : this.jogging ? 'Jog' : busy ? 'Run' : 'Idle';
    const f = (n: number) => n.toFixed(3);
    const mp = `MPos:${f(this.pos.x)},${f(this.pos.y)},${f(this.pos.z)}`;
    let s = `<${state}|${mp}|FS:${Math.round(this.feed)},${this.spindle}`;
    if (this.statusCount++ % 5 === 0) {
      s += `|WCO:${f(this.wco.x)},${f(this.wco.y)},${f(this.wco.z)}|Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}`;
    }
    this.out(s + '>');
  }
}
