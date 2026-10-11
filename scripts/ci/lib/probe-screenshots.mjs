import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** PNGs the probes wrote, carried in armada's existing task output. */
export function readScreenshots(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => ({ name: entry.name, base64: readFileSync(join(dir, entry.name)).toString('base64') }));
}

/** Save a task's captures in its own directory, never overwriting an artifact. */
export function writeScreenshots(dir, screenshots) {
  for (const shot of screenshots) {
    if (typeof shot.name !== 'string' || basename(shot.name) !== shot.name || !shot.name.endsWith('.png') || typeof shot.base64 !== 'string') {
      throw new Error('invalid screenshot artifact: expected a PNG filename and base64 bytes');
    }
  }
  mkdirSync(dir, { recursive: true });
  return screenshots.map((shot) => {
    const path = join(dir, shot.name);
    writeFileSync(path, Buffer.from(shot.base64, 'base64'), { flag: 'wx' });
    return path;
  });
}
