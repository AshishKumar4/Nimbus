#!/usr/bin/env bun
// X.5-26b functional — the parallel preamble's __REJECT_INSTALL Map
// MUST mirror src/wasm-swap-registry.ts:REJECT_INSTALL. The X.5-26b
// adds (@tailwindcss/oxide, lightningcss) appear in both files.
//
// We extract the preamble's Map literal via regex (the preamble is a
// raw string consumed by the install pipeline; importing it as a
// module would not exec the body in our test scope).
//
// PRE-FIX: red (entries absent in preamble). POST-FIX: green.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');
const preambleSrc = fs.readFileSync(
  path.join(REPO, 'src', 'loaders', 'npm-resolve-preamble.ts'),
  'utf8',
);

function preambleHas(name, transitive) {
  // The Map literal has lines of shape:
  //   ['<name>', { from: '<name>', reason: '…', transitive: '<t>' }],
  // We're lenient about whitespace + reason text.
  const re = new RegExp(
    `\\['${name.replace(/[/@-]/g, c => '\\' + c)}'\\s*,\\s*\\{[\\s\\S]*?from:\\s*'${name.replace(/[/@-]/g, c => '\\' + c)}'[\\s\\S]*?transitive:\\s*'${transitive}'`,
    'm',
  );
  return re.test(preambleSrc);
}

group('preamble mirrors @tailwindcss/oxide entry', () => {
  const r = reg.lookupReject('@tailwindcss/oxide');
  ok('canonical registry has @tailwindcss/oxide', !!r);
  if (r) eq('  transitive matches', r.transitive, 'fail');
  ok('preamble has @tailwindcss/oxide w/ transitive=fail',
    preambleHas('@tailwindcss/oxide', 'fail'));
});

group('preamble mirrors lightningcss entry', () => {
  const r = reg.lookupReject('lightningcss');
  ok('canonical registry has lightningcss', !!r);
  if (r) eq('  transitive matches', r.transitive, 'fail');
  ok('preamble has lightningcss w/ transitive=fail',
    preambleHas('lightningcss', 'fail'));
});

group('preamble has every transitive=fail entry from canonical registry', () => {
  // Every REJECT_INSTALL entry with transitive='fail' (sharp, prisma,
  // bcrypt, etc.) must be in the preamble. This is the cross-wave
  // invariant that x5z3 / x5z5 / etc. all assumed.
  const failEntries = reg.REJECT_INSTALL.filter(e => e.transitive === 'fail');
  for (const e of failEntries) {
    ok(`preamble mirrors fail-tier '${e.from}'`, preambleHas(e.from, 'fail'));
  }
});

summary('x526b preamble-mirror-sync');
