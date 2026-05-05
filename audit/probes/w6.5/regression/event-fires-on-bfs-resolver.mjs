#!/usr/bin/env bun
// W6.5 regression: supervisor BFS resolver in npm-resolver.ts emits all three event variants.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const resolverSrc = readFileSync(
  path.join(ROOT, 'src', 'npm-resolver.ts'),
  'utf8',
);

group('npm-resolver.ts imports emitRegistryEvent', () => {
  ok(
    'imports emitRegistryEvent',
    /import\s*\{[^}]*emitRegistryEvent[^}]*\}\s*from\s*['"][^'"]*wasm-swap-registry/.test(resolverSrc),
  );
});

group('BFS loop emits all three event variants', () => {
  ok(
    'emits swap event with ctx transitive',
    /emitRegistryEvent\s*\([\s\S]{0,200}?type:\s*['"]swap['"][\s\S]{0,200}?ctx:\s*['"]transitive['"]/.test(resolverSrc),
  );
  ok(
    'emits transitive-skip event',
    /emitRegistryEvent\s*\([\s\S]{0,200}?type:\s*['"]transitive-skip['"]/.test(resolverSrc),
  );
  ok(
    'emits reject event with ctx transitive',
    /emitRegistryEvent\s*\([\s\S]{0,200}?type:\s*['"]reject['"][\s\S]{0,200}?ctx:\s*['"]transitive['"]/.test(resolverSrc),
  );
});

summary('event-fires-on-bfs-resolver');
