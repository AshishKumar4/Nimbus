#!/usr/bin/env bun
// W6.5 functional: preamble parity for new entries.
//
// Extends W6's preamble-parity probe scope to cover the new REJECT entries
// added in W6.5 (sharp-wasm32, @napi-rs/canvas-wasm32-wasi, @napi-rs/canvas).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const reg = await import('../../../../src/wasm-swap-registry.ts');
const preambleSrc = readFileSync(
  path.join(ROOT, 'src', 'parallel', 'npm-resolve-preamble.ts'),
  'utf8',
);

group('every WASM_SWAPS.from appears in preamble', () => {
  for (const s of reg.WASM_SWAPS) {
    ok(`preamble has '${s.from}'`, preambleSrc.includes(`'${s.from}'`));
    ok(`preamble has '${s.to}'`, preambleSrc.includes(`'${s.to}'`));
  }
});

group('every REJECT_INSTALL.from appears in preamble', () => {
  for (const r of reg.REJECT_INSTALL) {
    // Preamble uses Map entries keyed by name; quote-styles can vary, so
    // match either single or double quoted form.
    const keyDouble = `"${r.from}"`;
    const keySingle = `'${r.from}'`;
    ok(`preamble has '${r.from}'`, preambleSrc.includes(keyDouble) || preambleSrc.includes(keySingle));
  }
});

group('preamble Map cardinality matches', () => {
  // Naive: count keys with the leading map-entry shape.
  // Swaps map: lines matching `'<from>',  { from: '<from>'`.
  const swapMatches = (preambleSrc.match(/__WASM_SWAPS[\s\S]*?\]\)/) || [''])[0];
  const rejectMatches = (preambleSrc.match(/__REJECT_INSTALL[\s\S]*?\]\)/) || [''])[0];

  ok(
    `__WASM_SWAPS section exists`,
    swapMatches.length > 0,
    `length=${swapMatches.length}`,
  );
  ok(
    `__REJECT_INSTALL section exists`,
    rejectMatches.length > 0,
    `length=${rejectMatches.length}`,
  );

  for (const s of reg.WASM_SWAPS) {
    ok(`__WASM_SWAPS contains '${s.from}'`, swapMatches.includes(`'${s.from}'`));
  }
  for (const r of reg.REJECT_INSTALL) {
    ok(`__REJECT_INSTALL contains '${r.from}'`, rejectMatches.includes(`'${r.from}'`));
  }
});

summary('preamble-parity-w6.5');
