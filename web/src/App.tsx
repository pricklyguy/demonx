import { useEffect, useRef, useState } from 'react';
import type { Machine } from './useMachine';
import { useMachine } from './useMachine';
import type { AutolevelParams, HeightMap, JogAxis, ProbeKind, ProbeSettings } from '../../shared/protocol';

const fmt = (n: number) => n.toFixed(3);
const savedNum = (key: string, fallback: number) => Number(localStorage.getItem(key)) || fallback;
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function App() {
  const m = useMachine();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <div className="app">
      <Header m={m} theme={theme} setTheme={setTheme} />
      <main className="grid">
        <ConnectPanel m={m} />
        <DroPanel m={m} />
        <JogPanel m={m} />
        <JobPanel m={m} />
        <ProbePanel m={m} />
        <AutolevelPanel m={m} />
        <OverridePanel m={m} />
        <ConsolePanel m={m} />
      </main>
      <ProbeDialog m={m} />
    </div>
  );
}

function Header({ m, theme, setTheme }: { m: Machine; theme: string; setTheme: (t: 'dark' | 'light') => void }) {
  const s = m.status.state;
  return (
    <header className="header">
      <img src="/logo.png" alt="Prickly Guy Creations" className="logo" />
      <div className="brand"><b>DemonX</b><span>CNC Controller</span></div>
      <div className={`state state-${s}`}>{m.online ? s : 'Server offline'}</div>
      <div className="spacer" />
      <div className="muted">{m.clients} client{m.clients === 1 ? '' : 's'}</div>
      <button className="btn warn" onClick={() => m.send({ type: 'hold' })} disabled={!m.connection.connected}>HOLD</button>
      <button className="btn ok" onClick={() => m.send({ type: 'resume' })} disabled={!m.connection.connected}>RESUME</button>
      <button className="btn danger" onClick={() => m.send({ type: 'reset' })} disabled={!m.connection.connected}>RESET</button>
      <button className="btn ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button>
    </header>
  );
}

function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`panel ${className}`}>
      <h2 onClick={() => setOpen(!open)}><span>{title}</span><span className="chev">{open ? '▾' : '▸'}</span></h2>
      {open && <div className="body">{children}</div>}
    </section>
  );
}

function ConnectPanel({ m }: { m: Machine }) {
  const [target, setTarget] = useState(localStorage.getItem('target') ?? '');
  const [baud, setBaud] = useState(115200);
  const c = m.connection;
  return (
    <Panel title="Connection">
      {c.connected ? (
        <>
          <div className="row"><span className="muted">Connected to</span> <b>{c.target}</b></div>
          {c.firmware && <div className="muted small">{c.firmware}</div>}
          <button className="btn danger" onClick={() => m.send({ type: 'disconnect' })}>Disconnect</button>
        </>
      ) : (
        <>
          <div className="row">
            <input list="ports" value={target} placeholder="Serial port (COM3, /dev/ttyUSB0)" onChange={(e) => setTarget(e.target.value)} />
            <datalist id="ports">
              <option value="simulator">Simulator (no hardware)</option>
              {m.ports.map((p) => <option key={p.path} value={p.path}>{p.manufacturer ?? p.description ?? ''}</option>)}
            </datalist>
            <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
              {[115200, 250000, 57600, 9600].map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>
          <div className="row">
            <button className="btn" onClick={() => m.send({ type: 'listPorts' })}>Refresh ports</button>
            <button className="btn primary" disabled={!target || !m.online} onClick={() => { localStorage.setItem('target', target); m.send({ type: 'connect', target, baud }); }}>Connect</button>
          </div>
          <div className="muted small">Ports listed are on the server, not this computer. Type "simulator" to try the UI without a machine.</div>
        </>
      )}
    </Panel>
  );
}

function DroPanel({ m }: { m: Machine }) {
  const { wpos, mpos } = m.status;
  const off = !m.connection.connected;
  const axes: { a: JogAxis; k: 'x' | 'y' | 'z' }[] = [{ a: 'X', k: 'x' }, { a: 'Y', k: 'y' }, { a: 'Z', k: 'z' }];
  return (
    <Panel title="Position" className="dro">
      {axes.map(({ a, k }) => (
        <div className="dro-row" key={a}>
          <span className="axis">{a}</span>
          <span className="wpos">{fmt(wpos[k])}</span>
          <span className="mpos">{fmt(mpos[k])}</span>
          <button className="btn small" disabled={off} onClick={() => m.send({ type: 'zero', axes: [a] })}>Zero</button>
        </div>
      ))}
      <div className="row">
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'zero', axes: ['X', 'Y'] })}>Zero XY</button>
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'zero', axes: ['X', 'Y', 'Z'] })}>Zero All</button>
        <button className="btn home" disabled={off} onClick={() => m.send({ type: 'home' })}>Home</button>
        <button className="btn warn" disabled={off} onClick={() => m.send({ type: 'unlock' })}>Unlock</button>
      </div>
      <div className="row">
        {/* Same feeds as the jog panel; Z stays slow so there is time to react */}
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'goto', target: 'z0', feed: savedNum('jogZFeed', 300) })}>Go to Z0</button>
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'goto', target: 'xy0', feed: savedNum('jogFeedXY', 3000) })}>Go to XY0</button>
      </div>
      <div className="muted small">Large = work position · small = machine position · Feed {Math.round(m.status.feed)} · Spindle {Math.round(m.status.spindle)}</div>
    </Panel>
  );
}

const XY_STEPS = [0.01, 0.1, 1, 10, 50];
const Z_STEPS = [0.01, 0.1, 1, 5, 10, 20];
const MAX_Z_JOG = 20; // mm, also enforced on the server

/** Persist a small per-browser setting (jog step, feed). */
function useSaved(key: string, initial: number): [number, (n: number) => void] {
  const [v, setV] = useState(() => {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : initial;
  });
  return [v, (n) => { setV(n); localStorage.setItem(key, String(n)); }];
}

// Defined at module level on purpose: a component defined inside another
// component gets a new identity on every render, which remounts the button
// and swallows clicks whenever a status update lands mid-click.
function JogBtn({ label, disabled, onJog, className = '' }: { label: string; disabled: boolean; onJog: () => void; className?: string }) {
  return <button className={`btn jog ${className}`} disabled={disabled} onClick={onJog}>{label}</button>;
}

function JogPanel({ m }: { m: Machine }) {
  const [step, setStep] = useSaved('jogStep', 1);
  const [feed, setFeed] = useSaved('jogFeedXY', 3000);
  const [zStep, setZStep] = useSaved('jogZStep', 1);
  const [zFeed, setZFeed] = useSaved('jogZFeed', 300);
  const off = !m.connection.connected || m.job.state === 'running';
  const jog = (dx = 0, dy = 0) => () => m.send({ type: 'jog', dx: dx * step, dy: dy * step, feed });
  const jogZ = (dir: number) => () => m.send({ type: 'jog', dz: dir * Math.min(zStep, MAX_Z_JOG), feed: zFeed });
  return (
    <Panel title="Jog">
      <div className="jogwrap">
        <div className="pad">
          <JogBtn label="↖" disabled={off} onJog={jog(-1, 1)} /><JogBtn label="Y+" disabled={off} onJog={jog(0, 1)} /><JogBtn label="↗" disabled={off} onJog={jog(1, 1)} />
          <JogBtn label="X−" disabled={off} onJog={jog(-1, 0)} /><JogBtn label="■" className="stopjog" disabled={off} onJog={() => m.send({ type: 'jogCancel' })} /><JogBtn label="X+" disabled={off} onJog={jog(1, 0)} />
          <JogBtn label="↙" disabled={off} onJog={jog(-1, -1)} /><JogBtn label="Y−" disabled={off} onJog={jog(0, -1)} /><JogBtn label="↘" disabled={off} onJog={jog(1, -1)} />
        </div>
        <div className="zpad">
          <JogBtn label="Z+" disabled={off} onJog={jogZ(1)} />
          <JogBtn label="Z−" disabled={off} onJog={jogZ(-1)} />
        </div>
      </div>
      <div className="row wrap">
        <span className="muted lbl">XY step</span>
        {XY_STEPS.map((s) => <button key={s} className={`btn small ${s === step ? 'primary' : ''}`} onClick={() => setStep(s)}>{s}</button>)}
      </div>
      <div className="row">
        <span className="muted lbl">XY feed</span>
        <input type="number" value={feed} min={1} onChange={(e) => setFeed(Number(e.target.value))} /> <span className="muted">mm/min</span>
      </div>
      <div className="row wrap zrow">
        <span className="muted lbl">Z step</span>
        {Z_STEPS.map((s) => <button key={s} className={`btn small ${s === zStep ? 'primary' : ''}`} onClick={() => setZStep(s)}>{s}</button>)}
      </div>
      <div className="row">
        <span className="muted lbl">Z feed</span>
        <input type="number" value={zFeed} min={1} onChange={(e) => setZFeed(Number(e.target.value))} /> <span className="muted">mm/min</span>
      </div>
      <div className="muted small">Z jog is capped at {MAX_Z_JOG} mm per press.</div>
    </Panel>
  );
}

function JobPanel({ m }: { m: Machine }) {
  const j = m.job;
  const file = useRef<HTMLInputElement>(null);
  const pct = j.totalLines ? Math.round((j.doneLines / j.totalLines) * 100) : 0;
  const running = j.state === 'running' || j.state === 'paused';
  const load = async (f: File) => m.send({ type: 'jobLoad', name: f.name, content: await f.text() });
  return (
    <Panel title="Job" className="job">
      <div className="row">
        <input ref={file} type="file" accept=".nc,.gcode,.gc,.ngc,.tap,.txt,.cnc" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        <button className="btn" disabled={running} onClick={() => file.current?.click()}>Open G-code…</button>
        <b>{j.name || 'No file loaded'}</b>
      </div>
      {j.leveled
        ? <div className="badge badge-ok">AUTOLEVELLED · Z corrected {j.leveled.minDelta.toFixed(2)} to {j.leveled.maxDelta.toFixed(2)} mm</div>
        : m.heightmap && j.state !== 'none' && <div className="badge badge-warn">A height map exists but is NOT applied to this program</div>}
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="row muted small">
        <span>{j.state.toUpperCase()}</span><span>{j.doneLines}/{j.totalLines} lines ({pct}%)</span><span>{fmtTime(j.elapsedMs)}</span>
      </div>
      {j.error && <div className="err">{j.error}</div>}
      <div className="row">
        <button className="btn primary" disabled={!m.connection.connected || running || j.state === 'none'} onClick={() => m.send({ type: 'jobStart' })}>Start</button>
        <button className="btn warn" disabled={j.state !== 'running'} onClick={() => m.send({ type: 'jobPause' })}>Pause</button>
        <button className="btn ok" disabled={j.state !== 'paused'} onClick={() => m.send({ type: 'jobResume' })}>Resume</button>
        <button className="btn danger" disabled={!running} onClick={() => m.send({ type: 'jobStop' })}>Stop</button>
      </div>
    </Panel>
  );
}

function OverridePanel({ m }: { m: Machine }) {
  const off = !m.connection.connected;
  const row = (label: string, kind: 'feed' | 'spindle', value: number) => (
    <div className="row" key={kind}>
      <span className="ovlabel">{label} <b>{value}%</b></span>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'minus10' })}>−10</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'minus1' })}>−1</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'reset' })}>100</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'plus1' })}>+1</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'plus10' })}>+10</button>
    </div>
  );
  return (
    <Panel title="Overrides">
      {row('Feed', 'feed', m.status.ov.feed)}
      {row('Spindle', 'spindle', m.status.ov.spindle)}
      <div className="row">
        <span className="ovlabel">Rapid <b>{m.status.ov.rapid}%</b></span>
        {(['reset', 'half', 'quarter'] as const).map((a) => (
          <button key={a} className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind: 'rapid', action: a })}>{a === 'reset' ? '100' : a === 'half' ? '50' : '25'}</button>
        ))}
      </div>
    </Panel>
  );
}

function ConsolePanel({ m }: { m: Machine }) {
  const [cmd, setCmd] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [m.log]);
  return (
    <Panel title="Console" className="console">
      <div className="log" ref={box}>
        {m.log.map((l, i) => <div key={i} className={`log-${l.kind}`}>{l.kind === 'tx' ? '> ' : ''}{l.text}</div>)}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (cmd) { m.send({ type: 'send', line: cmd }); setCmd(''); } }}>
        <input value={cmd} placeholder="Send command (e.g. $$ or G0 X0)" onChange={(e) => setCmd(e.target.value)} disabled={!m.connection.connected} />
        <button className="btn" disabled={!m.connection.connected}>Send</button>
      </form>
    </Panel>
  );
}

// ---------------- Probing ----------------

const PROBE_DEFAULTS = {
  plateZ_z: 25.05, plateZ_xyz: 22, plateX: 7, plateY: 7, endmill: 6.35,
  feedFast: 75, feedFine: 45, maxZ: 25, maxXY: 25, retract: 2, clearance_z: 10, clearance_pcb: 5, clearance_xyz: 10,
};
type ProbeForm = typeof PROBE_DEFAULTS;

const PROBE_FIELDS: { key: keyof ProbeForm; label: string; unit: string }[] = [
  { key: 'plateZ_z', label: 'Z plate height', unit: 'mm' },
  { key: 'plateZ_xyz', label: 'XYZ block height', unit: 'mm' },
  { key: 'plateX', label: 'XYZ block wall X', unit: 'mm' },
  { key: 'plateY', label: 'XYZ block wall Y', unit: 'mm' },
  { key: 'endmill', label: 'Endmill diameter', unit: 'mm' },
  { key: 'feedFast', label: 'Fast feed', unit: 'mm/min' },
  { key: 'feedFine', label: 'Fine feed', unit: 'mm/min' },
  { key: 'maxZ', label: 'Max Z travel', unit: 'mm' },
  { key: 'maxXY', label: 'Max XY travel', unit: 'mm' },
  { key: 'retract', label: 'Retract between passes', unit: 'mm' },
  { key: 'clearance_z', label: 'Z probe: end height', unit: 'mm' },
  { key: 'clearance_pcb', label: 'PCB probe: end height', unit: 'mm' },
  { key: 'clearance_xyz', label: 'XYZ probe: end height', unit: 'mm' },
];

function loadProbeForm(): ProbeForm {
  try { return { ...PROBE_DEFAULTS, ...JSON.parse(localStorage.getItem('probeForm') ?? '{}') }; } catch { return PROBE_DEFAULTS; }
}

function useProbeForm(): [ProbeForm, (k: keyof ProbeForm, v: number) => void] {
  const [f, setF] = useState<ProbeForm>(loadProbeForm);
  const set = (k: keyof ProbeForm, v: number) => {
    const next = { ...f, [k]: v };
    setF(next);
    localStorage.setItem('probeForm', JSON.stringify(next));
  };
  return [f, set];
}

function toSettings(f: ProbeForm, kind: ProbeKind): ProbeSettings {
  return {
    plateZ: kind === 'xyz' ? f.plateZ_xyz : kind === 'z' ? f.plateZ_z : 0,
    plateX: f.plateX, plateY: f.plateY, endmill: f.endmill,
    feedFast: f.feedFast, feedFine: f.feedFine, maxZ: f.maxZ, maxXY: f.maxXY, retract: f.retract,
    clearance: kind === 'xyz' ? f.clearance_xyz : kind === 'z' ? f.clearance_z : f.clearance_pcb,
  };
}

function ProbePanel({ m }: { m: Machine }) {
  const [form, setForm] = useProbeForm();
  const busy = m.probe.phase !== 'idle';
  const ready = m.connection.connected && m.status.state === 'Idle' && !busy && m.job.state !== 'running' && m.job.state !== 'paused';
  const start = (kind: ProbeKind) => m.send({ type: 'probeStart', kind, settings: toSettings(form, kind) });
  return (
    <Panel title="Probe">
      <div className="row">
        <button className="btn" disabled={!ready} onClick={() => start('z')}>▼ Z probe</button>
        <button className="btn" disabled={!ready} onClick={() => start('xyz')}>⊕ XYZ</button>
        <button className="btn" disabled={!ready} onClick={() => start('pcb')}>◎ PCB Z</button>
      </div>
      <div className="muted small">
        Each probe asks you to confirm the probe is connected before it moves, and to confirm it is removed before anything else can run.
      </div>
      <details>
        <summary className="muted small">Probe settings</summary>
        <div className="pform">
          {PROBE_FIELDS.map((fld) => (
            <label key={fld.key}>
              <span>{fld.label}</span>
              <input type="number" step="any" value={form[fld.key]} onChange={(e) => setForm(fld.key, Number(e.target.value))} />
              <span className="muted">{fld.unit}</span>
            </label>
          ))}
        </div>
      </details>
    </Panel>
  );
}

const REMOVE_TEXT: Record<ProbeKind, string> = {
  z: 'Remove the probe clip from the bit and take the plate off the work surface.',
  pcb: 'Remove the ground clip from the bit.',
  xyz: 'Remove the probe clip from the bit and take the touch block off the work surface.',
  autolevel: 'Remove the ground clip from the bit before cutting.',
};

function ProbeDialog({ m }: { m: Machine }) {
  const p = m.probe;
  if (p.phase === 'idle') return null;
  const triggered = m.status.pins.includes('P');
  const confirm = () => m.send({ type: 'probeConfirm', id: p.id, phase: p.phase });
  const results = p.result && Object.entries(p.result).map(([k, v]) => `${k.toUpperCase()} ${(v as number).toFixed(3)}`).join('   ');

  return (
    <div className="overlay">
      <div className={`dialog ${p.phase === 'confirmRemove' ? (p.success ? 'dlg-amber' : 'dlg-red') : 'dlg-amber'}`} role="alertdialog" aria-modal="true">
        <div className="dlg-kind">{p.title}</div>

        {p.phase === 'confirmConnect' && (
          <>
            <h3>{p.kind === 'pcb' || p.kind === 'autolevel' ? 'IS YOUR GROUND CONNECTED?' : 'IS THE PROBE CONNECTED?'}</h3>
            <ul>{p.checklist?.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className={`pin ${triggered ? 'pin-on' : ''}`}>
              Probe input: <b>{triggered ? 'TRIGGERED' : 'OPEN'}</b>
              <span className="small"> Touch the bit to the {p.kind === 'pcb' || p.kind === 'autolevel' ? 'board' : 'plate'} to test the connection: it should read TRIGGERED, then OPEN again when released.</span>
            </div>
            <div className="row end">
              <button className="btn" onClick={() => m.send({ type: 'probeCancel', id: p.id })}>Cancel</button>
              <button className="btn primary" onClick={confirm}>Yes, it is connected. Start probing</button>
            </div>
          </>
        )}

        {p.phase === 'running' && (
          <>
            <h3>PROBING…</h3>
            <div className="dlg-step">{p.step}</div>
            {p.progress && <div className="bar"><div style={{ width: `${Math.round((p.progress.current / p.progress.total) * 100)}%` }} /></div>}
            {results && <div className="mono">{results}</div>}
            <div className="muted small">Keep your hand near the stop button. The machine is moving.</div>
            <div className="row end">
              <button className="btn danger" onClick={() => m.send({ type: 'probeCancel', id: p.id })}>STOP</button>
            </div>
          </>
        )}

        {p.phase === 'confirmRemove' && (
          <>
            {p.success
              ? <div className="ok-line">Probing complete{results ? `: ${results}` : ''}</div>
              : <div className="err">Probe failed: {p.error}</div>}
            <h3>REMOVE THE PROBE NOW</h3>
            <div>{p.kind && REMOVE_TEXT[p.kind]}</div>
            {!p.success && <div className="muted small">If the machine is in alarm after you confirm, use Unlock to clear it, then check your position before continuing.</div>}
            <div className="row end">
              <button className="btn primary" onClick={confirm}>Probe removed. Continue</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- Autolevel ----------------

const AL_DEFAULTS = { minX: 0, maxX: 50, minY: 0, maxY: 50, cols: 5, rows: 5, safeZ: 2, depth: 2 };
type AlForm = typeof AL_DEFAULTS;
const AL_FIELDS: { key: keyof AlForm; label: string; unit: string; step?: string }[] = [
  { key: 'minX', label: 'X from', unit: 'mm' }, { key: 'maxX', label: 'X to', unit: 'mm' },
  { key: 'minY', label: 'Y from', unit: 'mm' }, { key: 'maxY', label: 'Y to', unit: 'mm' },
  { key: 'cols', label: 'Points in X', unit: '', step: '1' }, { key: 'rows', label: 'Points in Y', unit: '', step: '1' },
  { key: 'safeZ', label: 'Travel height above Z0', unit: 'mm' }, { key: 'depth', label: 'Max probe depth below Z0', unit: 'mm' },
];

function HeatGrid({ map }: { map: HeightMap }) {
  const flat = map.z.flat();
  const lo = Math.min(...flat), hi = Math.max(...flat), span = hi - lo || 1;
  const rows = [...Array(map.rows).keys()].reverse(); // Y increases upward, like the machine
  return (
    <div className="heat" style={{ gridTemplateColumns: `repeat(${map.cols}, 1fr)` }}>
      {rows.flatMap((j) => [...Array(map.cols).keys()].map((i) => {
        const z = map.z[j][i];
        const t = (z - lo) / span;
        const x = map.minX + ((map.maxX - map.minX) * i) / (map.cols - 1);
        const y = map.minY + ((map.maxY - map.minY) * j) / (map.rows - 1);
        return (
          <div key={`${i}-${j}`} className="cell" title={`X${x.toFixed(1)} Y${y.toFixed(1)}  ${z.toFixed(3)} mm`}
            style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, var(--panel2))`, color: t > 0.55 ? 'var(--accent-text)' : 'var(--text)' }}>
            {z.toFixed(2)}
          </div>
        );
      }))}
    </div>
  );
}

function AutolevelPanel({ m }: { m: Machine }) {
  const [form, setForm] = useState<AlForm>(() => {
    try { return { ...AL_DEFAULTS, ...JSON.parse(localStorage.getItem('alForm') ?? '{}') }; } catch { return AL_DEFAULTS; }
  });
  const [loadErr, setLoadErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof AlForm, v: number) => {
    const next = { ...form, [k]: v };
    setForm(next);
    localStorage.setItem('alForm', JSON.stringify(next));
  };
  const j = m.job;
  const jobBusy = j.state === 'running' || j.state === 'paused';
  const ready = m.connection.connected && m.status.state === 'Idle' && m.probe.phase === 'idle' && !jobBusy;
  const hm = m.heightmap;
  const flat = hm?.z.flat() ?? [];
  const useBounds = () => {
    if (!j.bounds) return;
    const b = j.bounds, r = (n: number) => Math.round(n * 100) / 100;
    const next = { ...form, minX: r(b.minX), maxX: r(b.maxX), minY: r(b.minY), maxY: r(b.maxY) };
    setForm(next);
    localStorage.setItem('alForm', JSON.stringify(next));
  };
  const scan = () => {
    const a: AutolevelParams = { ...form };
    m.send({ type: 'probeStart', kind: 'autolevel', settings: toSettings(loadProbeForm(), 'pcb'), autolevel: a });
  };
  const load = async (f: File) => {
    try { m.send({ type: 'heightmapLoad', map: JSON.parse(await f.text()) }); setLoadErr(''); } catch { setLoadErr('That file is not a height map (invalid JSON)'); }
  };
  const points = form.cols * form.rows;

  return (
    <Panel title="Autolevel" className="autolevel">
      <div className="muted small">
        Scan the board surface, then apply the height map to your G-code. The result is a new levelled program you can inspect, download and run.
      </div>
      <details open={!hm}>
        <summary className="muted small">1. Scan settings ({points} points)</summary>
        <div className="pform">
          {AL_FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input type="number" step={f.step ?? 'any'} value={form[f.key]} onChange={(e) => set(f.key, Number(e.target.value))} />
              <span className="muted">{f.unit}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" disabled={!j.bounds} onClick={useBounds} title={j.bounds ? '' : 'Load a G-code file first'}>Use loaded G-code area</button>
        </div>
      </details>
      <div className="row">
        <button className="btn primary" disabled={!ready} onClick={scan}>Start scan</button>
        <span className="muted small">Work zero must be on the board surface.</span>
      </div>

      {hm && (
        <>
          <div className="muted small">
            2. Height map: {hm.cols} × {hm.rows} points, {new Date(hm.scannedAt).toLocaleString()}.
            Surface varies <b>{(Math.max(...flat) - Math.min(...flat)).toFixed(3)} mm</b> (low {Math.min(...flat).toFixed(3)}, high {Math.max(...flat).toFixed(3)}).
          </div>
          <HeatGrid map={hm} />
          <div className="row wrap">
            <a className="btn small" href="/api/heightmap.json" download="heightmap.json">Download</a>
            <button className="btn small" onClick={() => file.current?.click()}>Load…</button>
            <button className="btn small" onClick={() => m.send({ type: 'heightmapClear' })}>Clear</button>
          </div>
        </>
      )}
      {!hm && <div className="row wrap"><button className="btn small" onClick={() => file.current?.click()}>Load a saved height map…</button></div>}
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
      {loadErr && <div className="err">{loadErr}</div>}

      <div className="row wrap">
        <button className="btn primary" disabled={!hm || j.state === 'none' || jobBusy || m.probe.phase !== 'idle'} onClick={() => m.send({ type: 'jobLevel' })}>
          3. Apply to G-code
        </button>
        <button className="btn" disabled={!j.leveled || jobBusy} onClick={() => m.send({ type: 'jobRevert' })}>Use original</button>
        {j.leveled && <a className="btn" href="/api/job.nc" download>Download levelled G-code</a>}
      </div>
      {j.levelError && <div className="err">Not applied: {j.levelError}</div>}
      {j.leveled && (
        <div className="lvl">
          <div><b>{j.name}</b>: {j.leveled.linesBefore} → {j.leveled.linesAfter} lines. Z corrected by {j.leveled.minDelta.toFixed(3)} to {j.leveled.maxDelta.toFixed(3)} mm.</div>
          {j.bounds && <div className="muted small">Program area X {j.bounds.minX.toFixed(1)} to {j.bounds.maxX.toFixed(1)}, Y {j.bounds.minY.toFixed(1)} to {j.bounds.maxY.toFixed(1)} mm</div>}
          {j.leveled.warnings.map((w) => <div key={w} className="warn-line">⚠ {w}</div>)}
        </div>
      )}
    </Panel>
  );
}
