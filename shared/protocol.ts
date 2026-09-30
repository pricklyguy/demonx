// Messages exchanged between the DemonX server and browser clients over WebSocket.
// Shared by server/ and web/ so both sides stay in sync.

export type MachineState =
  | 'Disconnected'
  | 'Idle'
  | 'Run'
  | 'Hold'
  | 'Jog'
  | 'Alarm'
  | 'Door'
  | 'Check'
  | 'Home'
  | 'Sleep';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MachineStatus {
  state: MachineState;
  /** GRBL sub-state, e.g. Hold:0 / Hold:1 */
  substate?: number;
  mpos: Vec3;
  wpos: Vec3;
  wco: Vec3;
  feed: number;
  spindle: number;
  /** Overrides in percent: feed, rapid, spindle */
  ov: { feed: number; rapid: number; spindle: number };
  /** Pin state letters from GRBL "Pn:" e.g. "XYZP" */
  pins: string;
  /** Planner blocks / RX bytes available, from "Bf:" */
  buffer?: { planner: number; rx: number };
}

export type JobState = 'none' | 'loaded' | 'running' | 'paused' | 'done' | 'error';

export interface JobInfo {
  state: JobState;
  name: string;
  totalLines: number;
  /** Lines sent to the controller */
  sentLines: number;
  /** Lines the controller has acknowledged (ok/error) */
  doneLines: number;
  startedAt?: number;
  elapsedMs: number;
  error?: string;
}

export interface ConnectionInfo {
  connected: boolean;
  /** e.g. "/dev/ttyUSB0", "COM3", "ws://192.168.1.50:81", "simulator" */
  target: string;
  firmware?: string;
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  description?: string;
}

export type LogKind = 'tx' | 'rx' | 'sys' | 'err';

export interface LogLine {
  t: number;
  kind: LogKind;
  text: string;
}

export type ProbeKind = 'z' | 'xyz' | 'pcb';
/**
 * idle -> confirmConnect (user must confirm the probe is connected)
 *      -> running (server drives the probe cycle)
 *      -> confirmRemove (user must confirm the probe/clip is removed)
 *      -> idle
 */
export type ProbePhase = 'idle' | 'confirmConnect' | 'running' | 'confirmRemove';

export interface ProbeSettings {
  /** Height of the touch plate/block: work Z is set to this at contact (0 for PCB) */
  plateZ: number;
  /** XYZ block wall thickness on X and Y */
  plateX: number;
  plateY: number;
  /** Endmill diameter (XYZ probe only) */
  endmill: number;
  feedFast: number;
  feedFine: number;
  maxZ: number;
  maxXY: number;
  /** Retract between the fast and fine pass */
  retract: number;
  /** Final Z retract after probing */
  clearance: number;
}

export interface ProbeInfo {
  /** Increments per probe run; confirmations must quote it so stale clicks are ignored */
  id: number;
  phase: ProbePhase;
  kind?: ProbeKind;
  title?: string;
  checklist?: string[];
  /** Current step while running */
  step?: string;
  /** Machine-position contact points recorded so far */
  result?: Partial<Vec3>;
  success?: boolean;
  error?: string;
}

export const emptyProbe = (): ProbeInfo => ({ id: 0, phase: 'idle' });

export interface Snapshot {
  connection: ConnectionInfo;
  status: MachineStatus;
  job: JobInfo;
  probe: ProbeInfo;
  clients: number;
  log: LogLine[];
}

// ---- server -> client ----
export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'status'; data: MachineStatus }
  | { type: 'job'; data: JobInfo }
  | { type: 'probe'; data: ProbeInfo }
  | { type: 'connection'; data: ConnectionInfo }
  | { type: 'clients'; data: number }
  | { type: 'log'; data: LogLine }
  | { type: 'ports'; data: PortInfo[] };

// ---- client -> server ----
export type JogAxis = 'X' | 'Y' | 'Z';

export type ClientMessage =
  | { type: 'listPorts' }
  | { type: 'connect'; target: string; baud?: number }
  | { type: 'disconnect' }
  | { type: 'send'; line: string }
  | { type: 'jog'; dx?: number; dy?: number; dz?: number; feed: number }
  | { type: 'jogCancel' }
  | { type: 'home' }
  | { type: 'unlock' }
  | { type: 'zero'; axes: JogAxis[] }
  /** Move to work Z0 or work X0 Y0 at the given feed (mm/min) */
  | { type: 'goto'; target: 'z0' | 'xy0'; feed: number }
  | { type: 'reset' }
  | { type: 'hold' }
  | { type: 'resume' }
  | { type: 'override'; kind: 'feed' | 'rapid' | 'spindle'; action: 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1' | 'half' | 'quarter' }
  | { type: 'jobLoad'; name: string; content: string }
  | { type: 'jobStart' }
  | { type: 'jobPause' }
  | { type: 'jobResume' }
  | { type: 'jobStop' }
  | { type: 'probeStart'; kind: ProbeKind; settings: ProbeSettings }
  | { type: 'probeConfirm'; id: number; phase: ProbePhase }
  | { type: 'probeCancel'; id: number };

export const emptyVec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export const emptyStatus = (): MachineStatus => ({
  state: 'Disconnected',
  mpos: emptyVec(),
  wpos: emptyVec(),
  wco: emptyVec(),
  feed: 0,
  spindle: 0,
  ov: { feed: 100, rapid: 100, spindle: 100 },
  pins: '',
});

export const emptyJob = (): JobInfo => ({
  state: 'none',
  name: '',
  totalLines: 0,
  sentLines: 0,
  doneLines: 0,
  elapsedMs: 0,
});
