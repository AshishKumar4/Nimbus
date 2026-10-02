// The module files a shadowed run captured (shadow-preload.mjs): each one
// imported natively and run as the interpreter's module cell, from the
// directory it was written to, and their exports compared. Reads the run's
// report (argv[2]) and appends the results to it (report.mjs).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadInterpreter } from '../../unit/lib/interpreter-load.mjs';
import { readReport, recordPart } from './report.mjs';
import { same } from './same.mjs';

const require = createRequire(import.meta.url);
const interp = loadInterpreter(process.env.NIMBUS_INTERPRETER, process.env.NIMBUS_INTERPRETER_OPS, (parent, specifier) => import(String(specifier)));
const reportFile = process.argv[2];
const report = readReport(reportFile);
const moduleResults = [];
let n = 0;
for (const { url, text } of report.modules ?? []) {
  const original = fileURLToPath(url.split('?')[0]);
  const dir = dirname(original);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `.nimbus-diff-${process.pid}-${n++}.mjs`);
  writeFileSync(file, text);
  try {
    const native = await import(pathToFileURL(file).href);
    const cell = interp.compileModule(file, text);
    const module = { exports: {}, __nimbusImportMeta: { url: pathToFileURL(file).href, dirname: dir, filename: file } };
    // The guest's require takes the file: URLs Vite writes into a bundled config; node's needs a path.
    const nodeRequire = createRequire(file);
    const require = (id) => nodeRequire(id.startsWith('file:') ? fileURLToPath(id) : id);
    await cell(module.exports, require, module, file, dir);
    const names = Object.keys(native).sort();
    const interpreted = Object.keys(module.exports).filter((k) => k !== '__esModule').sort();
    const difference = names.join(',') !== interpreted.join(',')
      ? `export names [${names}] vs [${interpreted}]`
      : names.map((k) => same(native[k], module.exports[k], k, 3, new Set())).find(Boolean) ?? null;
    moduleResults.push({ url, difference });
  } catch (e) {
    moduleResults.push({ url, difference: `threw: ${e && e.stack}` });
  } finally {
    rmSync(file, { force: true });
  }
}
recordPart(reportFile, { moduleResults });
