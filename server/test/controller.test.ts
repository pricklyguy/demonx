import { describe, it, expect } from 'vitest';
import { parseStatus, cleanGcode } from '../src/parser.js';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}

describe('parser', () => {
  it('parses status with MPos and derives WPos from WCO', () => {
    const s = parseStatus('<Run|MPos:10.000,20.000,-1.000|FS:500,8000|WCO:5,5,0|Ov:90,100,100>')!;
    expect(s.state).toBe('Run');
    expect(s.wpos).toEqual({ x: 5, y: 15, z: -1 });
    expect(s.feed).toBe(500);
    expect(s.ov.feed).toBe(90);
  });
  it('carries WCO forward when omitted', () => {
    const a = parseStatus('<Idle|MPos:1,1,1|WCO:1,0,0>')!;
    const b = parseStatus('<Idle|MPos:3,1,1>', a)!;
    expect(b.wpos.x).toBe(2);
  });
  it('parses hold substate and rejects non-status', () => {
    expect(parseStatus('<Hold:0|MPos:0,0,0>')!.substate).toBe(0);
    expect(parseStatus('ok')).toBeNull();
  });
  it('cleans gcode', () => {
    expect(cleanGcode('g1 x1.0 (move) y2 ; hi')).toBe('G1X1.0Y2');
    expect(cleanGcode('; only comment')).toBe('');
  });
});

describe('controller + simulator', () => {
  async function setup(speed = 50) {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(speed), 'simulator');
    await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
    return c;
  }

  it('streams a job larger than the RX buffer and completes', async () => {
    const c = await setup();
    const lines = ['G21', 'G90', 'G0 X0 Y0', ...Array.from({ length: 200 }, (_, i) => `G1 X${i % 20} Y${(i * 3) % 20} F1000`)];
    c.loadJob('test.nc', lines.join('\n'));
    c.startJob();
    await until(() => c.job.state === 'done', 20000);
    expect(c.job.doneLines).toBe(203);
    await c.disconnect();
  }, 30000);

  it('jogs and zeroes', async () => {
    const c = await setup();
    c.handle({ type: 'jog', dx: 10, feed: 6000 });
    await until(() => c.status.mpos.x === 10);
    c.handle({ type: 'zero', axes: ['X'] });
    await until(() => c.status.wpos.x === 0 && c.status.wco.x === 10);
    await c.disconnect();
  });

  it('pauses, resumes and stops a job', async () => {
    const c = await setup(1);
    c.loadJob('slow.nc', 'G21\nG90\nG1 X100 F600\nG1 X0 F600');
    c.startJob();
    await until(() => c.status.state === 'Run');
    c.handle({ type: 'jobPause' });
    await until(() => c.status.state === 'Hold');
    expect(c.job.state).toBe('paused');
    c.handle({ type: 'jobResume' });
    await until(() => c.status.state === 'Run');
    await c.stopJob();
    expect(c.job.state).toBe('loaded');
    await until(() => c.status.state === 'Idle');
    await c.disconnect();
  }, 20000);

  it('blocks manual commands during a job', async () => {
    const c = await setup(1);
    c.loadJob('a.nc', 'G21\nG1 X50 F600');
    c.startJob();
    c.sendLine('G0 X1');
    expect(c.logBuffer.some((l) => l.text.includes('blocked'))).toBe(true);
    await c.stopJob();
    await c.disconnect();
  }, 15000);
});
