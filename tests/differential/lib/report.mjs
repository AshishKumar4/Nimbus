// A differential run's report (interpreter-frameworks.mjs): every process
// and thread of a run loads the same preload (a dev server may render in a
// worker thread, which a process exit ends without its 'exit' event), so
// each appends what it finds as it finds it, one JSON line per part, and
// the driver merges the lines: numbers add up, lists concatenate.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** Append `part` (counts and lists) to the report file. */
export function recordPart(file, part) {
  appendFileSync(file, `${JSON.stringify(part)}\n`);
}

/** The report file's parts, merged. */
export function readReport(file) {
  const merged = {};
  if (!existsSync(file)) return merged;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    for (const [key, value] of Object.entries(JSON.parse(line))) {
      if (typeof value === 'number') merged[key] = (merged[key] ?? 0) + value;
      else merged[key] = [...(merged[key] ?? []), ...value];
    }
  }
  return merged;
}
