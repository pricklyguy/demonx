import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage, ConnectionInfo, HeightMap, JobInfo, LogLine, MachineStatus, PortInfo, ProbeInfo, ServerMessage,
} from '../../shared/protocol';
import { emptyJob, emptyProbe, emptyStatus } from '../../shared/protocol';

export interface Machine {
  online: boolean; // websocket to server is up
  connection: ConnectionInfo;
  status: MachineStatus;
  job: JobInfo;
  probe: ProbeInfo;
  heightmap: HeightMap | null;
  clients: number;
  log: LogLine[];
  ports: PortInfo[];
  send: (m: ClientMessage) => void;
}

export function useMachine(): Machine {
  const [online, setOnline] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo>({ connected: false, target: '' });
  const [status, setStatus] = useState<MachineStatus>(emptyStatus());
  const [job, setJob] = useState<JobInfo>(emptyJob());
  const [probe, setProbe] = useState<ProbeInfo>(emptyProbe());
  const [heightmap, setHeightmap] = useState<HeightMap | null>(null);
  const [clients, setClients] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => { setOnline(true); sock.send(JSON.stringify({ type: 'listPorts' })); };
      sock.onclose = () => {
        setOnline(false);
        if (!closed) retry = window.setTimeout(open, 1500);
      };
      sock.onmessage = (ev) => {
        const m: ServerMessage = JSON.parse(ev.data);
        switch (m.type) {
          case 'snapshot':
            setConnection(m.data.connection); setStatus(m.data.status); setJob(m.data.job); setProbe(m.data.probe); setHeightmap(m.data.heightmap);
            setClients(m.data.clients); setLog(m.data.log); break;
          case 'status': setStatus(m.data); break;
          case 'job': setJob(m.data); break;
          case 'probe': setProbe(m.data); break;
          case 'heightmap': setHeightmap(m.data); break;
          case 'connection': setConnection(m.data); break;
          case 'clients': setClients(m.data); break;
          case 'log': setLog((l) => [...l.slice(-299), m.data]); break;
          case 'ports': setPorts(m.data); break;
        }
      };
    };
    open();
    return () => { closed = true; window.clearTimeout(retry); ws.current?.close(); };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  }, []);

  return { online, connection, status, job, probe, heightmap, clients, log, ports, send };
}
