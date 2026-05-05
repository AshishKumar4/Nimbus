#!/usr/bin/env bun
// W6.5 functional: per-isolate-singleton invariant for _sink. Spawn two
// concurrent child bun processes; each sets a different sink, emits events,
// asserts no cross-contamination via stdout markers.
//
// Note: bun child processes already provide isolate isolation. This probe
// exists to assert *the assumption* and to make any future regression (e.g.
// shared-storage-backed sink) loud.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(HERE, '..', '..', '..', '..', 'src', 'wasm-swap-registry.ts');

const childCode = `
import(${JSON.stringify(REGISTRY_PATH)}).then((reg) => {
  const tag = process.env.W6_5_TAG;
  reg.setRegistryEventSink((e) => {
    process.stdout.write('TAG=' + tag + ' EVENT=' + JSON.stringify(e) + '\\n');
  });
  reg.emitRegistryEvent({ type: 'swap', from: 'orig-' + tag, to: 'tgt-' + tag, ctx: 'top' });
  reg.emitRegistryEvent({ type: 'reject', from: 'rej-' + tag, reason: 'r-' + tag, ctx: 'top' });
});
`;

function runChild(tag) {
  return new Promise((resolve) => {
    const p = spawn('bun', ['-e', childCode], {
      env: { ...process.env, W6_5_TAG: tag },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const [a, b] = await Promise.all([runChild('aaa'), runChild('bbb')]);

group('child A', () => {
  eq('exit 0', a.code, 0);
  ok('emitted swap with own tag', a.out.includes('TAG=aaa EVENT={"type":"swap","from":"orig-aaa"'));
  ok('emitted reject with own tag', a.out.includes('TAG=aaa EVENT={"type":"reject","from":"rej-aaa"'));
  ok('did NOT see tag bbb in own stdout', !a.out.includes('TAG=bbb'));
});

group('child B', () => {
  eq('exit 0', b.code, 0);
  ok('emitted swap with own tag', b.out.includes('TAG=bbb EVENT={"type":"swap","from":"orig-bbb"'));
  ok('emitted reject with own tag', b.out.includes('TAG=bbb EVENT={"type":"reject","from":"rej-bbb"'));
  ok('did NOT see tag aaa in own stdout', !b.out.includes('TAG=aaa'));
});

summary('sink-isolation');
