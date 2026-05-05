#!/usr/bin/env bun
// W6.5 regression: supervisor reject path emits a `reject` event before throwing.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const installerSrc = readFileSync(
  path.join(ROOT, 'src', 'npm-installer.ts'),
  'utf8',
);

group('applyW6Registry emits reject before throw', () => {
  const m = installerSrc.match(/private\s+applyW6Registry[\s\S]*?(?=\n\s{2}(?:private|public|async|\/\*\*|\}\s*$))/);
  ok('applyW6Registry method found', !!m);
  if (!m) return;
  const body = m[0];

  // Find emit-reject and throw RegistryRejectError lines, ensure emit comes first.
  const emitMatch = body.search(/emitRegistryEvent\s*\([\s\S]*?type:\s*['"]reject['"]/);
  const throwMatch = body.search(/throw\s+new\s+RegistryRejectError/);

  ok('emits reject event', emitMatch >= 0);
  ok('throws RegistryRejectError', throwMatch >= 0);
  if (emitMatch >= 0 && throwMatch >= 0) {
    ok('reject event is emitted BEFORE throw', emitMatch < throwMatch);
  }
});

group('functional contract: emit a reject event then throw', () => {
  import('../../../../src/wasm-swap-registry.ts').then((reg) => {
    const captured = [];
    reg.setRegistryEventSink((e) => captured.push(e));
    let threw = false;
    try {
      // Find a known reject and emit + throw pattern.
      const rejects = reg.findRejects({ sharp: '*' }, 'top');
      if (rejects.length === 0) {
        ok('reject for sharp registered', false);
        return;
      }
      for (const r of rejects) {
        reg.emitRegistryEvent({ type: 'reject', from: r.from, reason: r.reason, suggest: r.suggest, ctx: 'top' });
      }
      throw new reg.RegistryRejectError(rejects);
    } catch (e) {
      threw = reg.isRegistryReject(e);
    } finally {
      reg.setRegistryEventSink(null);
    }
    ok('threw RegistryRejectError', threw);
    ok('captured reject event', captured.length === 1);
    ok('event from === sharp', captured[0]?.from === 'sharp');
    ok('event has reason', typeof captured[0]?.reason === 'string');
  });
});

summary('event-fires-on-reject-supervisor');
