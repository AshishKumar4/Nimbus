#!/usr/bin/env bun
// W6.5 e2e: importing src/index.ts installs a default JSONL sink that
// writes `[w6.5/registry] {...json...}` lines to stdout.
//
// LOCAL probe (not prod-gated). Spawns a child bun process that imports
// the registry, sets/unsets the default sink, emits an event, captures stdout.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(HERE, '..', '..', '..', '..', 'src', 'wasm-swap-registry.ts');
const INDEX_PATH = path.resolve(HERE, '..', '..', '..', '..', 'src', 'index.ts');

const childCode = `
// Mimic what src/index.ts does at module top: install the default sink.
// We can't import index.ts directly because it has Workers-only side effects
// (Durable Object exports, fetch handler), so we DUPLICATE the default-sink
// install pattern here with a local import.
import(${JSON.stringify(REGISTRY_PATH)}).then((reg) => {
  // The default sink is installed in src/index.ts. For the probe we install
  // a sink mirroring its shape and emit one event of each kind.
  reg.setRegistryEventSink((e) => {
    console.log('[w6.5/registry] ' + JSON.stringify(e));
  });
  reg.emitRegistryEvent({ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', ctx: 'transitive' });
  reg.emitRegistryEvent({ type: 'transitive-skip', from: 'fsevents', reason: 'macOS-only' });
});
`;

function runChild() {
  return new Promise((resolve) => {
    const p = spawn('bun', ['-e', childCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const r = await runChild();

group('child exit + JSONL output', () => {
  ok('exit 0', r.code === 0);
  ok('stdout contains JSONL swap line', /\[w6\.5\/registry\]\s*\{"type":"swap"/.test(r.out));
  ok('stdout contains JSONL reject line', /\[w6\.5\/registry\]\s*\{"type":"reject"/.test(r.out));
  ok('stdout contains JSONL skip line', /\[w6\.5\/registry\]\s*\{"type":"transitive-skip"/.test(r.out));
});

group('JSONL is parseable', () => {
  const lines = r.out.split('\n').filter((l) => l.startsWith('[w6.5/registry]'));
  ok('captured 3 lines', lines.length === 3);
  for (const l of lines) {
    const json = l.replace(/^\[w6\.5\/registry\]\s*/, '');
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { ok(`line parses: ${l.slice(0, 60)}`, false); continue; }
    ok(`line has type: ${parsed.type}`, typeof parsed.type === 'string');
    ok(`line has from: ${parsed.from}`, typeof parsed.from === 'string');
  }
});

group('inspection: src/index.ts installs the default sink', () => {
  // Read src/index.ts and assert the default sink installation pattern.
  const fs = require('node:fs');
  const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
  ok(
    'index.ts imports setRegistryEventSink',
    /import\s*\{[^}]*setRegistryEventSink[^}]*\}\s*from/.test(indexSrc) ||
      /from\s*['"][^'"]*wasm-swap-registry/.test(indexSrc),
  );
  ok(
    'index.ts calls setRegistryEventSink with a JSONL emitter',
    /setRegistryEventSink\s*\(/.test(indexSrc) && /\[w6\.5\/registry\]/.test(indexSrc),
  );
});

summary('default-sink-emits-jsonl');
