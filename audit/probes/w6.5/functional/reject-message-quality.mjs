#!/usr/bin/env bun
// W6.5 functional: per-entry reject suggest-validation.
//
// For each REJECT_INSTALL entry, the suggest field falls into exactly one bucket:
//
//   (A) Names a candidate alternative — name OR clear hint that this is a
//       Workers-compatible direction.
//   (B) Honestly says "no Workers-compatible target" via a fixed-phrase set.
//
// When (A) names a specific alternative AND we have an audit/probes/wasm/<name>.out.txt
// for it, the probe reads that file. If known-fail markers are present
// (ENOENT, not pre-bundled, MODULE_NOT_FOUND, Cannot find module), the
// suggest must include a parenthetical caveat (per W6 retro S5 honesty).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

// The set of canonical "no alternative" phrases. Adding a new phrase requires
// updating this whitelist; removing one requires an honest commit message.
const NO_ALT_PHRASES = [
  'no Workers-compatible target',
  'no Workers-compatible swap',
];

const FAIL_MARKERS = ['ENOENT', 'not pre-bundled', 'MODULE_NOT_FOUND', 'Cannot find module', 'LOAD FAIL'];

function readOut(altName) {
  // Map @scope/name → audit/probes/wasm/<scope-name>.out.txt approximation.
  const candidates = [
    altName,
    altName.replace('/', '-'),
    altName.replace(/^@/, '').replace('/', '-'),
  ];
  for (const c of candidates) {
    const p = path.join(ROOT, 'audit', 'probes', 'wasm', c + '.out.txt');
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

const swapTos = new Set(reg.WASM_SWAPS.map((s) => s.to));

group('every REJECT entry has a suggest field with discipline', () => {
  for (const entry of reg.REJECT_INSTALL) {
    ok(`'${entry.from}' has suggest`, typeof entry.suggest === 'string' && entry.suggest.length > 0);
    if (!entry.suggest) continue;

    // Bucket-B path: suggest contains one of the no-alt phrases.
    const isNoAlt = NO_ALT_PHRASES.some((p) => entry.suggest.includes(p));

    if (isNoAlt) {
      ok(`'${entry.from}' bucket B (no-alt) phrase clean`, true);
      continue;
    }

    // Bucket-A path: probe asserts at least ONE of:
    //  - entry.suggest mentions a name in WASM_SWAPS.to (so we know it's verified-supported), OR
    //  - audit/probes/wasm/<some-alt>.out.txt has zero fail markers, OR
    //  - the suggest contains a parenthetical caveat about WHY the alt is partial
    //    (e.g. "default-export only", "after W6.5 loader fix", "verified — see ...").
    const mentionsSwapTarget = [...swapTos].some((t) => entry.suggest.includes(t));
    const hasArtifactCaveat =
      entry.suggest.includes('verified') ||
      entry.suggest.includes('see audit/probes/') ||
      entry.suggest.includes('default-export') ||
      entry.suggest.includes('after W6.5') ||
      entry.suggest.includes('loader gap') ||
      entry.suggest.includes('untested');

    ok(
      `'${entry.from}' bucket A discipline (mentions-swap=${mentionsSwapTarget}, has-caveat=${hasArtifactCaveat})`,
      mentionsSwapTarget || hasArtifactCaveat,
    );
  }
});

group('no false suggestions (alts that show fail markers in their .out.txt must be caveated)', () => {
  // Heuristic scan: for each REJECT entry, find candidate alt names by
  // matching against existing wasm probe artifacts; if the artifact shows
  // fail markers, the suggest text must indicate that fact.
  const wasmDir = path.join(ROOT, 'audit', 'probes', 'wasm');
  if (!existsSync(wasmDir)) {
    ok('audit/probes/wasm exists', false, 'directory missing — cannot run honesty check');
    return;
  }

  for (const entry of reg.REJECT_INSTALL) {
    if (!entry.suggest) continue;
    // Extract candidate alt names mentioned in the suggest. Look for tokens
    // that match a wasm probe artifact filename.
    const tokens = entry.suggest.match(/[@a-zA-Z][@a-zA-Z0-9._\-/]+/g) || [];
    for (const tok of tokens) {
      const out = readOut(tok);
      if (!out) continue; // not a known wasm artifact name
      const failMarker = FAIL_MARKERS.find((m) => out.includes(m));
      if (failMarker) {
        // Suggest must explicitly caveat. Otherwise it's a false-suggestion
        // (W6 retro S5: don't recommend a swap target that doesn't actually load).
        const caveated =
          entry.suggest.includes('default-export') ||
          entry.suggest.includes('after W6.5') ||
          entry.suggest.includes('loader gap') ||
          entry.suggest.includes('partial') ||
          entry.suggest.includes('untested') ||
          entry.suggest.includes('see audit/probes/');
        ok(
          `'${entry.from}' suggests '${tok}' (artifact has '${failMarker}') — caveated`,
          caveated,
          `suggest = ${JSON.stringify(entry.suggest)}`,
        );
      }
    }
  }
});

summary('reject-message-quality');
