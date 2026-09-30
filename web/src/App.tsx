import { useEffect, useRef, useState } from 'react';
import type { Machine } from './useMachine';
import { useMachine } from './useMachine';
import type { JogAxis } from '../../shared/protocol';

const fmt = (n: number) => n.toFixed(3);
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
        <OverridePanel m={m} />
        <ConsolePanel m={m} />
      </main>
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
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'home' })}>Home</button>
        <button className="btn warn" disabled={off} onClick={() => m.send({ type: 'unlock' })}>Unlock</button>
      </div>
      <div className="muted small">Large = work position · small = machine position · Feed {Math.round(m.status.feed)} · Spindle {Math.round(m.status.spindle)}</div>
    </Panel>
  );
}

const STEPS = [0.01, 0.1, 1, 10, 50];

function JogPanel({ m }: { m: Machine }) {
  const [step, setStep] = useState(1);
  const [feed, setFeed] = useState(1000);
  const off = !m.connection.connected || m.job.state === 'running';
  const jog = (dx = 0, dy = 0, dz = 0) => m.send({ type: 'jog', dx: dx * step, dy: dy * step, dz: dz * step, feed });
  const B = ({ label, dx, dy, dz }: { label: string; dx?: number; dy?: number; dz?: number }) => (
    <button className="btn jog" disabled={off} onClick={() => jog(dx, dy, dz)}>{label}</button>
  );
  return (
    <Panel title="Jog">
      <div className="jogwrap">
        <div className="pad">
          <B label="↖" dx={-1} dy={1} /><B label="Y+" dy={1} /><B label="↗" dx={1} dy={1} />
          <B label="X−" dx={-1} /><button className="btn jog stopjog" disabled={off} onClick={() => m.send({ type: 'jogCancel' })}>■</button><B label="X+" dx={1} />
          <B label="↙" dx={-1} dy={-1} /><B label="Y−" dy={-1} /><B label="↘" dx={1} dy={-1} />
        </div>
        <div className="zpad"><B label="Z+" dz={1} /><B label="Z−" dz={-1} /></div>
      </div>
      <div className="row wrap">
        <span className="muted">Step</span>
        {STEPS.map((s) => <button key={s} className={`btn small ${s === step ? 'primary' : ''}`} onClick={() => setStep(s)}>{s}</button>)}
      </div>
      <div className="row">
        <span className="muted">Feed</span>
        <input type="number" value={feed} min={1} onChange={(e) => setFeed(Number(e.target.value))} /> <span className="muted">mm/min</span>
      </div>
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
