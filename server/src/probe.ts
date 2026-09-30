import { EventEmitter } from 'node:events';
import type { ProbeInfo, ProbeKind, ProbePhase, ProbeSettings, Vec3 } from '../../shared/protocol.js';
import { emptyProbe } from '../../shared/protocol.js';
import type { GrblController, ProbeHit } from './controller.js';
import { GRBL_ALARMS } from './parser.js';

/**
 * Probe cycles with two mandatory user confirmations, enforced here on the
 * server so it holds for every connected client, stale tab or remote viewer:
 *
 *   confirmConnect -> running -> confirmRemove -> idle
 *
 * While a probe is active the controller is locked against client commands, so
 * nothing can jog, home or start a job until the user has confirmed that the
 * probe clip / plate has been removed. That includes runs that fail: a failed
 * probe still ends at confirmRemove, because the clip is still on the bit.
 */

const LOCK_REASON = 'Probe in progress: confirm the probe dialog first';

// Geometry of the XYZ touch block procedure, carried over from DemonX V1.
const XYZ_LIFT = 3;         // Z lift after the top-of-block probe
const XYZ_SIDE_OFFSET = 25; // X move to the left of the block before probing X
const XYZ_DROP = 10;        // Z drop beside the block; net depth below its top = DROP - LIFT (7 mm)
const XYZ_BACKOFF = 10;     // move away from the face after setting zero
const XYZ_Y_START_X = 5;    // absolute work X used for the Y probe

const RANGES: Record<keyof ProbeSettings, [number, number]> = {
  plateZ: [0, 200], plateX: [0, 50], plateY: [0, 50], endmill: [0, 25],
  feedFast: [1, 500], feedFine: [1, 200], maxZ: [1, 60], maxXY: [1, 60],
  retract: [0.5, 10], clearance: [1, 100],
};

export function validateSettings(s: ProbeSettings): string | null {
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = (s as unknown as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      return `Probe setting "${k}" must be between ${lo} and ${hi}`;
    }
  }
  return null;
}

const KINDS: Record<ProbeKind, { title: string; checklist: string[] }> = {
  z: {
    title: 'Z Probe',
    checklist: [
      'Probe clip is attached to the bit (or the plate is wired to the probe input)',
      'Plate is flat on the work surface, directly under the bit',
      'Bit is roughly 15 mm above the plate',
    ],
  },
  pcb: {
    title: 'PCB Z Probe',
    checklist: [
      'Ground clip is attached to the bit',
      'No plate: the bit touches the board surface directly',
      'Bit is roughly 15 mm above the board, over bare copper',
    ],
  },
  xyz: {
    title: '3-Axis Probe',
    checklist: [
      'Probe clip is attached to the bit',
      'Touch block is in the corner, about 15 mm from its bottom-left',
      'Bit is roughly 15 mm above the block',
    ],
  },
};

const n = (v: number) => String(Number(v.toFixed(4)));

export class ProbeManager extends EventEmitter {
  info: ProbeInfo = emptyProbe();
  private settings?: ProbeSettings;
  private cancelled = false;

  constructor(private ctl: GrblController) {
    super();
    ctl.on('connection', (c: { connected: boolean }) => {
      // Nothing has happened to the machine yet at the first dialog: just drop it.
      if (!c.connected && this.info.phase === 'confirmConnect') this.finish();
    });
  }

  // ---------- requests from clients ----------
  start(kind: ProbeKind, settings: ProbeSettings) {
    const fail = (m: string) => this.ctl.log('err', `Probe not started: ${m}`);
    if (this.info.phase !== 'idle') return fail('a probe is already active');
    if (!KINDS[kind]) return fail('unknown probe type');
    if (!this.ctl.connection.connected) return fail('not connected');
    if (this.ctl.job.state === 'running' || this.ctl.job.state === 'paused') return fail('a job is running');
    if (this.ctl.status.state !== 'Idle') return fail(`machine is ${this.ctl.status.state}, not Idle`);
    const bad = validateSettings(settings);
    if (bad) return fail(bad);

    this.settings = { ...settings };
    this.cancelled = false;
    this.ctl.lock = LOCK_REASON;
    this.set({
      id: this.info.id + 1, phase: 'confirmConnect', kind, title: KINDS[kind].title,
      checklist: KINDS[kind].checklist, step: undefined, result: undefined, success: undefined, error: undefined,
    });
    this.ctl.log('sys', `${KINDS[kind].title}: waiting for confirmation that the probe is connected`);
  }

  confirm(id: number, phase: ProbePhase) {
    // A confirmation must name the run and the dialog it answered, so a stale
    // or double click can never confirm the next dialog by accident.
    if (id !== this.info.id || phase !== this.info.phase) {
      return this.ctl.log('sys', 'Ignored a stale probe confirmation');
    }
    if (phase === 'confirmConnect') void this.run();
    else if (phase === 'confirmRemove') {
      this.ctl.log('sys', 'Probe removal confirmed');
      this.finish();
    }
  }

  cancel(id: number) {
    if (id !== this.info.id) return;
    if (this.info.phase === 'confirmConnect') {
      this.ctl.log('sys', 'Probe cancelled');
      this.finish();
    } else if (this.info.phase === 'running') {
      this.cancelled = true;
      this.ctl.log('sys', 'Probe cancelled: stopping the machine');
      this.ctl.softReset();
    }
    // confirmRemove cannot be cancelled: the clip must be confirmed removed.
  }

  // ---------- the cycle ----------
  private async run() {
    const { kind } = this.info;
    const s = this.settings!;
    this.set({ phase: 'running', step: 'Checking probe input', result: {} });
    let moved = false;
    try {
      if (this.ctl.status.pins.includes('P')) {
        throw new Error('The probe input is already triggered. Check the clip, plate and wiring.');
      }
      if (this.ctl.status.state !== 'Idle') throw new Error(`Machine is ${this.ctl.status.state}, not Idle`);
      moved = true;
      await this.cmd('Setting millimetres', 'G21');
      await this.cmd('Setting relative mode', 'G91');
      if (kind === 'z') await this.zCycle(s, s.plateZ, s.clearance);
      else if (kind === 'pcb') await this.zCycle(s, 0, s.clearance);
      else await this.xyzCycle(s);
      await this.cmd('Restoring absolute mode', 'G90');
      this.ctl.log('sys', `${this.info.title} complete`);
      this.set({ phase: 'confirmRemove', step: undefined, success: true, error: undefined });
    } catch (e) {
      const error = this.cancelled ? 'Cancelled by user' : (e as Error).message;
      this.ctl.log('err', `${this.info.title} failed: ${error}`);
      // Return the controller's parser to defaults (G90) after an abort or alarm.
      if (moved && !this.cancelled) this.ctl.softReset();
      this.set({ phase: 'confirmRemove', step: undefined, success: false, error });
    }
  }

  /** @param finalLift how far to lift after setting Z zero */
  private async zCycle(s: ProbeSettings, plateZ: number, finalLift: number) {
    await this.probe('Z fast pass', `G38.2 Z-${n(s.maxZ)} F${n(s.feedFast)}`, s.maxZ, s.feedFast);
    await this.move('Retracting', `G0 Z${n(s.retract)}`);
    const z = await this.probe('Z fine pass', `G38.2 Z-${n(s.retract + 2)} F${n(s.feedFine)}`, s.retract + 2, s.feedFine);
    this.record({ z: z.z });
    await this.cmd('Setting Z zero', `G10 L20 P0 Z${n(plateZ)}`);
    await this.move('Retracting', `G0 Z${n(finalLift)}`);
  }

  private async xyzCycle(s: ProbeSettings) {
    // Lift only XYZ_LIFT here (not the full clearance): the drop below then leaves
    // the tool XYZ_DROP - XYZ_LIFT beside the block's side faces. Lifting the full
    // clearance first put the tool level with the block top and it rode over the edge.
    await this.zCycle(s, s.plateZ, XYZ_LIFT);
    const r = s.endmill / 2;
    const side = async (axis: 'X' | 'Y', thickness: number) => {
      await this.probe(`${axis} fast pass`, `G38.2 ${axis}${n(s.maxXY)} F${n(s.feedFast)}`, s.maxXY, s.feedFast);
      await this.move('Retracting', `G0 ${axis}-${n(s.retract)}`);
      const hit = await this.probe(`${axis} fine pass`, `G38.2 ${axis}${n(s.retract + 2)} F${n(s.feedFine)}`, s.retract + 2, s.feedFine);
      const key = axis === 'X' ? 'x' : 'y';
      this.record({ [key]: hit[key] });
      await this.cmd(`Setting ${axis} zero`, `G10 L20 P0 ${axis}-${n(r + thickness)}`);
      await this.move('Backing off', `G0 ${axis}-${n(XYZ_BACKOFF)}`);
    };
    await this.move('Moving beside block', `G0 X-${n(XYZ_SIDE_OFFSET)}`);
    await this.move('Dropping to side faces', `G0 Z-${n(XYZ_DROP)}`);
    await side('X', s.plateX);
    await this.move('Moving in front of block', `G0 Y-${n(XYZ_SIDE_OFFSET)}`);
    await this.cmd('Absolute mode', 'G90');
    await this.move('Positioning for Y', `G0 X${n(XYZ_Y_START_X)}`);
    await this.cmd('Relative mode', 'G91');
    await side('Y', s.plateY);
    await this.move('Retracting to clearance', `G0 Z${n(s.clearance)}`);
  }

  // ---------- step helpers ----------
  private step(label: string) { this.set({ step: label }); }

  private async cmd(label: string, line: string) {
    this.step(label);
    const r = await this.ctl.sendInternal(line);
    if (!r.ok) throw new Error(`${line}: ${r.error ?? 'rejected'}`);
  }

  /** Send a move and wait for the machine to finish it. */
  private async move(label: string, line: string) {
    await this.cmd(label, line);
    await this.ctl.waitIdle();
  }

  /** Run a G38.2 and return the contact position (machine coordinates). */
  private async probe(label: string, line: string, maxDist: number, feed: number): Promise<Vec3> {
    this.step(label);
    let off = () => {};
    // Listen before sending: GRBL may report [PRB] before or after "ok".
    const outcome = new Promise<ProbeHit>((resolve, reject) => {
      const onPrb = (h: ProbeHit) => resolve(h);
      const onAlarm = (code: number) =>
        reject(new Error(`Alarm ${code}${GRBL_ALARMS[code] ? `: ${GRBL_ALARMS[code]}` : ''}`));
      // A reset (user cancel, physical reset) or lost connection never produces a [PRB]
      const onReset = () => reject(new Error('Machine was reset'));
      const onConn = (c: { connected: boolean }) => { if (!c.connected) reject(new Error('Connection lost')); };
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the probe result')), (maxDist / feed) * 60_000 + 15_000);
      this.ctl.on('prb', onPrb);
      this.ctl.on('alarm', onAlarm);
      this.ctl.on('reset', onReset);
      this.ctl.on('connection', onConn);
      off = () => {
        clearTimeout(timer);
        this.ctl.off('prb', onPrb); this.ctl.off('alarm', onAlarm);
        this.ctl.off('reset', onReset); this.ctl.off('connection', onConn);
      };
    });
    outcome.catch(() => {}); // avoid an unhandled rejection if we throw before awaiting it
    try {
      const ack = await this.ctl.sendInternal(line);
      if (!ack.ok) throw new Error(`${line}: ${ack.error ?? 'rejected'}`);
      const hit = await outcome;
      if (!hit.success) throw new Error('The probe did not make contact within the travel limit');
      await this.ctl.waitIdle();
      return hit.pos;
    } finally {
      off();
    }
  }

  private record(r: Partial<Vec3>) { this.set({ result: { ...this.info.result, ...r } }); }

  private finish() {
    this.ctl.lock = undefined;
    this.set({ phase: 'idle', step: undefined });
  }

  private set(patch: Partial<ProbeInfo>) {
    this.info = { ...this.info, ...patch };
    this.emit('probe', this.info);
  }
}
