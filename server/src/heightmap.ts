import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { HeightMap } from '../../shared/protocol.js';

/** Validate a height map from a file or client: shape, sizes and finite numbers. */
export function validateHeightMap(m: unknown): string | null {
  const h = m as HeightMap;
  if (!h || typeof h !== 'object') return 'not a height map';
  const ints = [h.cols, h.rows];
  if (!ints.every((v) => Number.isInteger(v) && v >= 2 && v <= 60)) return 'grid must be between 2 and 60 points each way';
  const nums = [h.minX, h.maxX, h.minY, h.maxY];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'invalid scan area';
  if (!(h.maxX > h.minX) || !(h.maxY > h.minY)) return 'scan area has no size';
  if (!Array.isArray(h.z) || h.z.length !== h.rows) return 'height rows do not match the grid';
  for (const row of h.z) {
    if (!Array.isArray(row) || row.length !== h.cols) return 'height columns do not match the grid';
    if (!row.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100)) return 'invalid height value';
  }
  return null;
}

/** Holds the current height map and keeps a copy on disk so it survives restarts. */
export class HeightMapStore extends EventEmitter {
  map: HeightMap | null = null;
  private file?: string;

  constructor(dataDir?: string) {
    super();
    if (!dataDir) return;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'heightmap.json');
    try {
      const m = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validateHeightMap(m)) this.map = m;
    } catch { /* no saved map yet */ }
  }

  set(map: HeightMap | null) {
    this.map = map;
    if (this.file) {
      try {
        if (map) fs.writeFileSync(this.file, JSON.stringify(map));
        else fs.rmSync(this.file, { force: true });
      } catch (e) { this.emit('error-save', e); }
    }
    this.emit('heightmap', map);
  }
}
