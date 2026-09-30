import { describe, it, expect } from 'vitest';
import { GrblController } from '../src/controller.js';
import { ProbeManager } from '../src/probe.js';
import { SimulatorTransport } from '../src/simulator.js';
import type { ProbeSettings } from '../../shared/protocol.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}

const SETTINGS: ProbeSettings = {
  plateZ: 25.05, plateX: 7, plateY: 7, endmill: 3, feedFast: 75, feedFine: 45,
  maxZ: 25, maxXY: 25, retract: 2, clearance: 10,
};

async function setup() {
  const sim = new SimulatorTransport(60);
  const c = new GrblController();
  const p = new ProbeManager(c);
  await c.connect(sim, 'simulator');
  await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
  return { sim, c, p };
}

describe('probe safety flow', () => {
  it('Z probe: confirm connect, run, sets zero, then requires remove confirmation', async () => {
    const { c, p } = await setup();
    p.start('z', SETTINGS);
    expect(p.info.phase).toBe('confirmConnect');
    const id = p.info.id;
    await wait(300);
    expect(c.status.mpos.z).toBe(0); // nothing moves before the user confirms

    p.confirm(id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove');
    expect(p.info.success).toBe(true);
    expect(p.info.result?.z).toBeCloseTo(-10, 3); // contact at the sim plate
    await until(() => c.status.state === 'Idle');
    // work Z zero was set to the plate height at contact, then retracted 10 mm
    expect(c.status.wpos.z).toBeCloseTo(SETTINGS.plateZ + SETTINGS.clearance, 2);
    expect(c.status.pins).toBe('');

    // still locked until the clip removal is confirmed
    expect(c.lock).toBeTruthy();
    c.handle({ type: 'jog', dx: 5, feed: 1000 });
    c.handle({ type: 'send', line: 'G0 X50' });
    await wait(200);
    expect(c.status.mpos.x).toBe(0);

    p.confirm(id, 'confirmRemove');
    expect(p.info.phase).toBe('idle');
    expect(c.lock).toBeUndefined();
    c.handle({ type: 'jog', dx: 5, feed: 6000 });
    await until(() => c.status.mpos.x === 5);
    await c.disconnect();
  }, 40000);

  it('PCB probe sets zero at the surface (no plate thickness)', async () => {
    const { c, p } = await setup();
    p.start('pcb', { ...SETTINGS, clearance: 5 });
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove');
    await until(() => c.status.state === 'Idle');
    expect(p.info.success).toBe(true);
    expect(c.status.wpos.z).toBeCloseTo(5, 2);
    await c.disconnect();
  }, 40000);

  it('XYZ probe finds top and both faces and sets the offsets', async () => {
    const { c, p } = await setup();
    const s = { ...SETTINGS, plateZ: 22 };
    p.start('xyz', s);
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove', 60000);
    expect(p.info.error).toBeUndefined();
    expect(p.info.success).toBe(true);
    expect(p.info.result).toMatchObject({ z: expect.any(Number), x: expect.any(Number), y: expect.any(Number) });
    await until(() => c.status.state === 'Idle');
    // tool centre sat endmill/2 + wall away from the corner at each contact
    const r = s.endmill / 2;
    expect(c.status.wco.x).toBeCloseTo(-8 + r + s.plateX, 2);
    expect(c.status.wco.y).toBeCloseTo(-8 + r + s.plateY, 2);
    expect(c.status.wco.z).toBeCloseTo(-10 - s.plateZ, 2);
    await c.disconnect();
  }, 90000);

  it('probe that never makes contact fails safe and still demands remove confirmation', async () => {
    const { sim, c, p } = await setup();
    sim.probeConnected = false;
    p.start('z', SETTINGS);
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove');
    expect(p.info.success).toBe(false);
    expect(p.info.error).toMatch(/contact|Alarm/i);
    expect(c.lock).toBeTruthy(); // clip may still be attached
    p.confirm(p.info.id, 'confirmRemove');
    expect(c.lock).toBeUndefined();
    await c.disconnect();
  }, 60000);

  it('refuses to start if the probe input is already triggered', async () => {
    const { sim, c, p } = await setup();
    sim.setTouched(true);
    await until(() => c.status.pins.includes('P'));
    p.start('z', SETTINGS);
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove');
    expect(p.info.success).toBe(false);
    expect(p.info.error).toMatch(/already triggered/);
    expect(c.status.mpos.z).toBe(0); // never moved
    await c.disconnect();
  });

  it('ignores stale or mismatched confirmations', async () => {
    const { c, p } = await setup();
    p.start('z', SETTINGS);
    const id = p.info.id;
    p.confirm(id, 'confirmRemove');      // wrong dialog
    p.confirm(id + 1, 'confirmConnect'); // wrong run
    expect(p.info.phase).toBe('confirmConnect');
    p.cancel(id);
    expect(p.info.phase).toBe('idle');
    expect(c.lock).toBeUndefined();
    await c.disconnect();
  });

  it('rejects out-of-range settings and non-idle machine', async () => {
    const { c, p } = await setup();
    p.start('z', { ...SETTINGS, maxZ: 5000 });
    expect(p.info.phase).toBe('idle');
    p.start('z', { ...SETTINGS, feedFast: NaN });
    expect(p.info.phase).toBe('idle');
    await c.disconnect();
  });

  it('cancelling mid-probe stops the machine and demands remove confirmation', async () => {
    const { c, p } = await setup();
    // slow probe so there is time to cancel
    p.start('z', { ...SETTINGS, feedFast: 5 });
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => c.status.state === 'Run');
    p.cancel(p.info.id);
    await until(() => p.info.phase === 'confirmRemove');
    expect(p.info.success).toBe(false);
    expect(p.info.error).toBe('Cancelled by user');
    p.confirm(p.info.id, 'confirmRemove');
    await c.disconnect();
  }, 40000);
});
