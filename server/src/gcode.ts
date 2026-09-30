import type { Bounds, HeightMap } from '../../shared/protocol.js';

/** Thrown for programs that cannot be levelled correctly. The message names the line. */
export class GcodeError extends Error {}

const TAU = Math.PI * 2;
const OUTSIDE_TOL = 0.01; // mm
const ARC_TOL = 0.005;    // mm, max chord error when arcs are split into lines

/** Surface height (work coordinates) at x,y by bilinear interpolation; clamped to the scanned area. */
export function heightAt(map: HeightMap, x: number, y: number): { z: number; outside: boolean } {
  const { cols, rows, minX, maxX, minY, maxY, z } = map;
  const outside = x < minX - OUTSIDE_TOL || x > maxX + OUTSIDE_TOL || y < minY - OUTSIDE_TOL || y > maxY + OUTSIDE_TOL;
  const cx = Math.min(maxX, Math.max(minX, x));
  const cy = Math.min(maxY, Math.max(minY, y));
  const fx = ((cx - minX) / (maxX - minX)) * (cols - 1);
  const fy = ((cy - minY) / (maxY - minY)) * (rows - 1);
  const i = Math.min(Math.floor(fx), cols - 2);
  const j = Math.min(Math.floor(fy), rows - 2);
  const tx = fx - i, ty = fy - j;
  const h = (1 - tx) * (1 - ty) * z[j][i] + tx * (1 - ty) * z[j][i + 1]
          + (1 - tx) * ty * z[j + 1][i] + tx * ty * z[j + 1][i + 1];
  return { z: h, outside };
}

export interface LevelStats {
  minDelta: number;
  maxDelta: number;
  /** Cutting endpoints outside the scanned area */
  outside: number;
  /** Z moves before any XY position was known: left as written */
  uncorrected: number;
}

export interface LevelResult {
  lines: string[];
  /** XY extent of the cutting moves (or of all moves if there are none) */
  bounds?: Bounds;
  stats: LevelStats;
}

const WORD = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
const num = (v: number) => String(Number(v.toFixed(4)));

// G-codes that would silently invalidate a height map if passed through.
const REFUSED_G: Record<number, string> = {
  10: 'G10 changes work offsets mid-program',
  20: 'inches (G20): levelling supports millimetres only',
  28: 'G28 moves to a stored position',
  30: 'G30 moves to a stored position',
  53: 'G53 moves in machine coordinates',
  92: 'G92 changes the coordinate offset mid-program',
  38: 'probing (G38.x) inside the program',
};

/**
 * Walk a G-code program, and when a height map is given, rewrite every move so
 * its Z includes the surface height under it. Long lines and arcs are split into
 * short segments so the correction follows the surface along the whole move.
 *
 * Anything that cannot be handled exactly (relative mode, inches, radius-format
 * arcs, other planes, offset changes) is refused with the line number rather
 * than passed through, because a program that is only partly levelled would cut
 * at the wrong depth without any sign of it.
 *
 * With map === null nothing is rewritten; the program is only analysed.
 */
export function levelProgram(source: string[], map: HeightMap | null): LevelResult {
  const step = map ? Math.max(0.5, Math.min((map.maxX - map.minX) / (map.cols - 1), (map.maxY - map.minY) / (map.rows - 1)) / 2) : 1;
  const out: string[] = [];
  const stats: LevelStats = { minDelta: Infinity, maxDelta: -Infinity, outside: 0, uncorrected: 0 };

  // Programmed (uncorrected) position; undefined until the program establishes it.
  let px: number | undefined, py: number | undefined, pz: number | undefined;
  let motion: 0 | 1 | 2 | 3 = 0; // GRBL powers up in G0
  let cutBounds: Bounds | undefined;
  let allBounds: Bounds | undefined;

  const grow = (b: Bounds | undefined, x: number, y: number): Bounds =>
    b ? { minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minY: Math.min(b.minY, y), maxY: Math.max(b.maxY, y) }
      : { minX: x, maxX: x, minY: y, maxY: y };

  source.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const fail = (why: string): never => { throw new GcodeError(`Line ${lineNo}: ${why} (${raw.trim()})`); };
    const clean = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const words = [...clean.matchAll(WORD)].map((m) => ({ c: m[1], v: Number(m[2]) }));
    if (!words.length) { out.push(raw); return; }

    // ---- modal codes ----
    const other: string[] = []; // words re-emitted ahead of the move (M, S, T, G21...)
    for (const w of words) {
      if (w.c === 'G') {
        const g = w.v;
        if (g === 0 || g === 1 || g === 2 || g === 3) { motion = g as 0 | 1 | 2 | 3; continue; }
        if (g === 91) fail('relative mode (G91) is not supported by autolevel');
        if (g === 18 || g === 19) fail('only the XY plane (G17) is supported by autolevel');
        if (g === 90.1) fail('absolute arc centres (G90.1) are not supported by autolevel');
        if (REFUSED_G[Math.floor(g)]) fail(REFUSED_G[Math.floor(g)]);
        other.push(`G${num(g)}`);
      } else if (!'XYZIJKRFN'.includes(w.c)) {
        other.push(`${w.c}${num(w.v)}`);
      }
    }
    const get = (c: string) => words.find((w) => w.c === c)?.v;
    const hasAxis = words.some((w) => 'XYZ'.includes(w.c));
    if (!hasAxis) {
      // No move on this line (feed, spindle, unit and mode changes...): keep verbatim.
      out.push(raw);
      return;
    }
    if ((motion === 2 || motion === 3) && get('R') !== undefined) fail('radius-format arcs (R) are not supported by autolevel; use I/J');

    // ---- target ----
    const tx = get('X') ?? px, ty = get('Y') ?? py, tz = get('Z') ?? pz;
    const feedWord = get('F');

    if (tx === undefined || ty === undefined) {
      // XY position not established yet: a Z-only move here (typically the initial
      // lift) cannot be corrected, so leave it exactly as written.
      if (get('X') === undefined && get('Y') === undefined && get('Z') !== undefined) {
        pz = get('Z');
        stats.uncorrected++;
        out.push(raw);
        return;
      }
      fail('XY position is not defined before this move; start with a move that sets both X and Y');
    }
    if (tz === undefined) fail('Z position is not defined before this move; set Z first');
    const x1 = tx as number, y1 = ty as number, z1 = tz as number;

    // ---- points along the move ----
    interface Pt { x: number; y: number; z: number }
    const pts: Pt[] = [];
    const x0 = px, y0 = py, z0 = pz;
    if (motion === 2 || motion === 3) {
      if (x0 === undefined || y0 === undefined || z0 === undefined) fail('arc without a known start position');
      const sx = x0 as number, sy = y0 as number, sz = z0 as number;
      const cx = sx + (get('I') ?? 0), cy = sy + (get('J') ?? 0);
      const r0 = Math.hypot(sx - cx, sy - cy), r1 = Math.hypot(x1 - cx, y1 - cy);
      const a0 = Math.atan2(sy - cy, sx - cx);
      let sweep = Math.atan2(y1 - cy, x1 - cx) - a0;
      if (motion === 2) { if (sweep >= -1e-9) sweep -= TAU; } else if (sweep <= 1e-9) sweep += TAU;
      const rMax = Math.max(r0, r1, ARC_TOL * 2);
      const dTheta = 2 * Math.acos(Math.max(-1, 1 - ARC_TOL / rMax));
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / dTheta), Math.ceil((Math.abs(sweep) * rMax) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n, a = a0 + sweep * t, r = r0 + (r1 - r0) * t;
        pts.push(k === n ? { x: x1, y: y1, z: z1 } : { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: sz + (z1 - sz) * t });
      }
    } else if (motion === 1 && x0 !== undefined && y0 !== undefined && z0 !== undefined) {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        pts.push(k === n ? { x: x1, y: y1, z: z1 } : { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, z: z0 + (z1 - z0) * t });
      }
    } else {
      pts.push({ x: x1, y: y1, z: z1 }); // rapid, or first move of the program
    }

    // ---- bounds (uses the programmed path, never the correction) ----
    for (const p of pts) {
      allBounds = grow(allBounds, p.x, p.y);
      if (motion !== 0) cutBounds = grow(cutBounds, p.x, p.y);
    }

    // ---- emit ----
    if (map) {
      if (other.length) out.push(other.join(' '));
      pts.forEach((p, k) => {
        const h = heightAt(map, p.x, p.y);
        if (h.outside && motion !== 0) stats.outside++;
        stats.minDelta = Math.min(stats.minDelta, h.z);
        stats.maxDelta = Math.max(stats.maxDelta, h.z);
        const g = motion === 0 ? 'G0' : 'G1'; // arcs are emitted as line segments
        let line = `${g} X${num(p.x)} Y${num(p.y)} Z${num(p.z + h.z)}`;
        if (k === 0 && feedWord !== undefined) line += ` F${num(feedWord)}`;
        out.push(line);
      });
    } else {
      out.push(raw);
    }
    px = x1; py = y1; pz = z1;
  });

  if (stats.minDelta === Infinity) { stats.minDelta = 0; stats.maxDelta = 0; }
  return { lines: out, bounds: cutBounds ?? allBounds, stats };
}
