import { describe, it, expect } from 'vitest';
import { GcodeError, heightAt, levelProgram } from '../src/gcode.js';
import type { HeightMap } from '../../shared/protocol.js';

/** A map where the surface height is a plane: h = ax + by + c, sampled on a grid. */
function planeMap(a: number, b: number, c = 0, cols = 5, rows = 4, x0 = 0, x1 = 40, y0 = 0, y1 = 30): HeightMap {
  const z: number[][] = [];
  for (let j = 0; j < rows; j++) {
    z.push([]);
    for (let i = 0; i < cols; i++) {
      const x = x0 + ((x1 - x0) * i) / (cols - 1), y = y0 + ((y1 - y0) * j) / (rows - 1);
      z[j].push(a * x + b * y + c);
    }
  }
  return { cols, rows, minX: x0, maxX: x1, minY: y0, maxY: y1, z, scannedAt: 0 };
}

const plane = (x: number, y: number) => 0.01 * x - 0.02 * y + 0.1;
const MAP = planeMap(0.01, -0.02, 0.1);

/** Parse `G1 X.. Y.. Z..` output lines into numbers */
const pt = (l: string) => ({
  g: /^G(\d)/.exec(l)![1],
  x: Number(/X(-?[\d.]+)/.exec(l)?.[1]), y: Number(/Y(-?[\d.]+)/.exec(l)?.[1]), z: Number(/Z(-?[\d.]+)/.exec(l)?.[1]),
});

describe('heightAt', () => {
  it('is exact on grid nodes and reproduces a plane everywhere (bilinear)', () => {
    for (const [x, y] of [[0, 0], [40, 30], [13.7, 22.1], [40, 0], [0, 30], [39.99, 29.99]]) {
      const h = heightAt(MAP, x, y);
      expect(h.z).toBeCloseTo(plane(x, y), 9);
      expect(h.outside).toBe(false);
    }
  });
  it('clamps outside the scanned area and reports it', () => {
    const h = heightAt(MAP, 50, -5);
    expect(h.outside).toBe(true);
    expect(h.z).toBeCloseTo(plane(40, 0), 9);
  });
});

describe('levelProgram', () => {
  it('adds the surface height to Z at every point of a straight cut, splitting long moves', () => {
    const r = levelProgram(['G21', 'G90', 'G0 X0 Y0 Z2', 'G1 Z-0.1 F100', 'G1 X40 Y30 F300'], MAP);
    const moves = r.lines.filter((l) => /^G[01] /.test(l)).map(pt);
    expect(pt(r.lines[2]).z).toBeCloseTo(2 + plane(0, 0), 3); // the rapid is corrected too
    const cut = moves.slice(2); // after the rapid and the plunge
    expect(cut.length).toBeGreaterThanOrEqual(10); // 50 mm diagonal at 5 mm steps
    for (const m of cut) expect(m.z).toBeCloseTo(-0.1 + plane(m.x, m.y), 3);
    const last = cut[cut.length - 1];
    expect([last.x, last.y]).toEqual([40, 30]); // end point is exact
    expect(r.lines[0]).toBe('G21');
    expect(r.lines[1]).toBe('G90');
  });

  it('corrects a Z-only plunge at the current XY and keeps the feed word', () => {
    const r = levelProgram(['G0 X10 Y10 Z2', 'G1 Z-0.2 F60'], MAP);
    const plunge = r.lines[r.lines.length - 1];
    expect(plunge).toMatch(/F60$/);
    expect(pt(plunge).z).toBeCloseTo(-0.2 + plane(10, 10), 3);
    expect([pt(plunge).x, pt(plunge).y]).toEqual([10, 10]);
  });

  it('carries modal Z and feed across lines that omit them', () => {
    const r = levelProgram(['G0 X0 Y0 Z1', 'G1 Z-0.05 F200', 'X10', 'Y10'], MAP);
    const moves = r.lines.filter((l) => /^G1 /.test(l)).map(pt);
    for (const m of moves) expect(m.z).toBeCloseTo(-0.05 + plane(m.x, m.y), 3);
    expect(r.lines.filter((l) => l.includes('F200')).length).toBe(1);
  });

  it('turns arcs into line segments that stay on the circle and follow the surface', () => {
    // CCW half circle radius 10 about (20,15) starting at (10,15)
    const r = levelProgram(['G0 X10 Y15 Z0', 'G3 X30 Y15 I10 J0 F100'], MAP);
    const seg = r.lines.slice(1).map(pt);
    expect(seg.length).toBeGreaterThan(8);
    for (const p of seg) {
      expect(Math.hypot(p.x - 20, p.y - 15)).toBeCloseTo(10, 1);
      expect(p.z).toBeCloseTo(plane(p.x, p.y), 3);
    }
    // CCW from the left: passes through the bottom (y < 15) on the way to (30,15)
    expect(Math.min(...seg.map((p) => p.y))).toBeLessThan(6);
    expect([seg[seg.length - 1].x, seg[seg.length - 1].y]).toEqual([30, 15]);
    expect(seg.every((p) => p.g === '1')).toBe(true);
  });

  it('CW arcs go the other way, and a same-point arc is a full circle', () => {
    const cw = levelProgram(['G0 X10 Y15 Z0', 'G2 X30 Y15 I10 J0'], MAP).lines.slice(1).map(pt);
    expect(Math.max(...cw.map((p) => p.y))).toBeGreaterThan(24);
    const full = levelProgram(['G0 X10 Y15 Z0', 'G2 X10 Y15 I5 J0'], MAP).lines.slice(1).map(pt);
    expect(full.length).toBeGreaterThan(20);
    expect(Math.max(...full.map((p) => p.x))).toBeGreaterThan(19.9);
  });

  it('keeps arc mode from leaking: later plain lines are emitted with their own G word', () => {
    const r = levelProgram(['G0 X10 Y15 Z0', 'G3 X30 Y15 I10 J0', 'X35 Y15'], MAP);
    const last = r.lines[r.lines.length - 1];
    expect(last).toMatch(/^G1 X35 Y15/); // still an arc in the source: full-circle-ish arc, all G1 segments
  });

  it('re-emits M/S words and leaves comments, blank lines and feed-only lines alone', () => {
    const src = ['(header)', '', 'F150', 'M3 S12000', 'G0 X1 Y1 Z1', 'G1 X2 Y2 Z0 M8'];
    const r = levelProgram(src, MAP);
    expect(r.lines.slice(0, 4)).toEqual(['(header)', '', 'F150', 'M3 S12000']);
    expect(r.lines).toContain('M8'); // moved ahead of the move it shared a line with
  });

  it('leaves the initial Z lift alone and reports it, then corrects everything after', () => {
    const r = levelProgram(['G0 Z5', 'G0 X5 Y5', 'G1 Z-0.1'], MAP);
    expect(r.lines[0]).toBe('G0 Z5');
    expect(r.stats.uncorrected).toBe(1);
    expect(pt(r.lines[1]).z).toBeCloseTo(5 + plane(5, 5), 3);
  });

  it('counts cutting points outside the scanned area but not rapids', () => {
    const r = levelProgram(['G0 X100 Y100 Z1', 'G1 X0 Y0 Z0'], MAP);
    expect(r.stats.outside).toBeGreaterThan(0);
    const rapidOnly = levelProgram(['G0 X100 Y100 Z1', 'G0 X0 Y0'], MAP);
    expect(rapidOnly.stats.outside).toBe(0);
  });

  it('reports the size of the correction', () => {
    const r = levelProgram(['G0 X0 Y0 Z1', 'G1 X40 Y30'], MAP);
    expect(r.stats.minDelta).toBeCloseTo(plane(40, 30) < plane(0, 0) ? plane(40, 30) : plane(0, 0), 3);
    expect(r.stats.maxDelta).toBeGreaterThan(r.stats.minDelta);
  });

  it.each([
    ['G91', ['G91', 'G0 X1']],
    ['inches', ['G20', 'G0 X1 Y1 Z1']],
    ['R arcs', ['G0 X0 Y0 Z0', 'G2 X10 Y0 R5']],
    ['other plane', ['G18', 'G0 X1 Y1 Z1']],
    ['G92', ['G0 X0 Y0 Z0', 'G92 X0']],
    ['G10 offsets', ['G10 L20 P1 X0']],
    ['G53', ['G53 G0 Z0']],
    ['probe inside the program', ['G0 X0 Y0 Z1', 'G38.2 Z-5 F10']],
    ['XY undefined', ['G0 X5', 'G1 Z0']],
  ])('refuses %s instead of levelling it wrongly', (_n, src) => {
    expect(() => levelProgram(src, MAP)).toThrow(GcodeError);
  });

  it('names the offending line', () => {
    expect(() => levelProgram(['G21', 'G90', 'G91'], MAP)).toThrow(/Line 3/);
  });

  it('analyses bounds without rewriting when no map is given', () => {
    const src = ['G0 X-50 Y-50 Z5', 'G0 X10 Y20', 'G1 Z-1', 'G1 X30 Y5', 'G0 X0 Y0'];
    const r = levelProgram(src, null);
    expect(r.lines).toEqual(src);
    expect(r.bounds).toEqual({ minX: 10, maxX: 30, minY: 5, maxY: 20 }); // cutting moves only
  });

  it('finds bounds of arcs, not just their end points', () => {
    const r = levelProgram(['G0 X10 Y15 Z0', 'G3 X30 Y15 I10 J0'], null);
    expect(r.bounds!.minY).toBeLessThan(6);
    expect(r.bounds!.maxX).toBeCloseTo(30, 3);
  });
});
