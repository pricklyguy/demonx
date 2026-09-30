import type { MachineState, MachineStatus, Vec3 } from '../../shared/protocol.js';
import { emptyStatus } from '../../shared/protocol.js';

const STATES: MachineState[] = ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep'];

const parseVec = (s: string): Vec3 => {
  const [x = 0, y = 0, z = 0] = s.split(',').map(Number);
  return { x, y, z };
};

/**
 * Parse a GRBL / FluidNC real-time status report such as
 * `<Idle|MPos:1.000,2.000,3.000|FS:500,12000|WCO:0,0,0|Ov:100,100,100>`.
 * GRBL only sends WCO and Ov occasionally, so values not present are carried
 * over from `prev`. Returns null if the line is not a status report.
 */
export function parseStatus(line: string, prev: MachineStatus = emptyStatus()): MachineStatus | null {
  if (!line.startsWith('<') || !line.endsWith('>')) return null;
  const fields = line.slice(1, -1).split('|');
  const [stateField, ...rest] = fields;
  const [stateName, sub] = stateField.split(':');
  if (!STATES.includes(stateName as MachineState)) return null;

  const next: MachineStatus = {
    ...prev,
    state: stateName as MachineState,
    substate: sub !== undefined ? Number(sub) : undefined,
    pins: '',
    ov: { ...prev.ov },
  };

  let mpos: Vec3 | undefined;
  let wpos: Vec3 | undefined;
  for (const f of rest) {
    const i = f.indexOf(':');
    if (i < 0) continue;
    const key = f.slice(0, i);
    const val = f.slice(i + 1);
    switch (key) {
      case 'MPos': mpos = parseVec(val); break;
      case 'WPos': wpos = parseVec(val); break;
      case 'WCO': next.wco = parseVec(val); break;
      case 'FS': {
        const [feed, spindle] = val.split(',').map(Number);
        next.feed = feed; next.spindle = spindle ?? 0;
        break;
      }
      case 'F': next.feed = Number(val); break;
      case 'Ov': {
        const [feed, rapid, spindle] = val.split(',').map(Number);
        next.ov = { feed, rapid, spindle };
        break;
      }
      case 'Pn': next.pins = val; break;
      case 'Bf': {
        const [planner, rx] = val.split(',').map(Number);
        next.buffer = { planner, rx };
        break;
      }
    }
  }

  const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  if (mpos) {
    next.mpos = mpos;
    next.wpos = sub3(mpos, next.wco);
  } else if (wpos) {
    next.wpos = wpos;
    next.mpos = add3(wpos, next.wco);
  }
  return next;
}

/** Strip comments and whitespace from a G-code line. Returns '' for empty lines. */
export function cleanGcode(line: string): string {
  return line
    .replace(/\([^)]*\)/g, '') // (parenthesised comments)
    .replace(/;.*$/, '')       // ; end-of-line comments
    .replace(/\s+/g, '')
    .toUpperCase();
}

export const GRBL_ERRORS: Record<number, string> = {
  1: 'Expected command letter', 2: 'Bad number format', 3: 'Invalid $ statement',
  4: 'Negative value', 5: 'Homing not enabled', 8: 'Not idle', 9: 'G-code locked (alarm/jog)',
  10: 'Soft limit', 15: 'Jog target exceeds travel', 20: 'Unsupported G-code command',
  21: 'Modal group violation', 22: 'Undefined feed rate', 33: 'Invalid target',
};

export const GRBL_ALARMS: Record<number, string> = {
  1: 'Hard limit triggered', 2: 'Soft limit / travel exceeded', 3: 'Reset while in motion, position lost',
  4: 'Probe fail: not in expected initial state', 5: 'Probe fail: no contact', 6: 'Homing fail: reset',
  7: 'Homing fail: door', 8: 'Homing fail: pull-off', 9: 'Homing fail: no switch found',
};
