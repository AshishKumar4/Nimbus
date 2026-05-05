#!/usr/bin/env bun
// W6.5 regression: audit/probes/wasm/_SUMMARY.json reflects LOAD success, not just install success.
//
// Per W6 retro S5: the file currently records ok:true for every package even
// when the .out.txt shows the load failed (sql.js ENOENT, swc-wasm-web pre-
// bundle gap, libsql-client missing module). Phase C.4 fixes the file.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const SUMMARY_PATH = path.join(ROOT, 'audit', 'probes', 'wasm', '_SUMMARY.json');
const summary_data = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));

const FAIL_MARKERS = ['ENOENT', 'not pre-bundled', 'MODULE_NOT_FOUND', 'Cannot find module', 'LOAD FAIL'];

group('every entry that says ok:true has a clean .out.txt', () => {
  for (const entry of summary_data) {
    const name = entry.name;
    const outPath = path.join(ROOT, 'audit', 'probes', 'wasm', name + '.out.txt');
    if (!existsSync(outPath)) {
      ok(`${name}: out.txt exists`, false, `not at ${outPath}`);
      continue;
    }
    const out = readFileSync(outPath, 'utf8');
    const failMarker = FAIL_MARKERS.find((m) => out.includes(m));
    if (entry.ok === true) {
      ok(`${name}: ok:true matches clean out.txt`, !failMarker, `marker = ${failMarker || 'none'}`);
    } else {
      ok(`${name}: ok:false (load failed)`, true);
    }
  }
});

summary('summary-honesty');
