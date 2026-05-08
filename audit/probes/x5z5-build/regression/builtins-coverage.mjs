#!/usr/bin/env bun
// X.5-Z5 regression: shim builtins[] registration list contains all
// expected previously-known keys. Inherited from X.5-NPQO regression
// suite (post-merge baseline). The Z5 wave does not touch builtins[],
// so this list must be unchanged.

import { ok, group, summary } from '../../w6/_tap.mjs';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';

const src = generateShimsCode();

const REQUIRED_BUILTINS = [
  // Core
  'fs', 'path', 'os', 'process', 'events', 'stream', 'crypto',
  'util', 'assert', 'querystring', 'string_decoder',
  'buffer', 'http', 'https', 'net', 'dns', 'tls',
  'tty', 'module', 'timers', 'zlib', 'readline',
  'perf_hooks', 'worker_threads', 'vm', 'http2', 'repl',
  'diagnostics_channel', 'async_hooks', 'url',
  // Subpath (existing)
  'fs/promises', 'node:fs/promises',
  'timers/promises', 'node:timers/promises',
  'dns/promises', 'node:dns/promises',
  // Subpath (X.5-Q new)
  'util/types', 'node:util/types',
];

group('Required builtins[] keys are all registered', () => {
  for (const k of REQUIRED_BUILTINS) {
    const reBare = new RegExp(`builtins\\.${k.replace(/[^\w]/g, '\\$&')}\\s*=`);
    const reQuoted = new RegExp(`builtins\\["${k.replace(/[^\w/]/g, '\\$&')}"\\]\\s*=`);
    const present = reBare.test(src) || reQuoted.test(src);
    ok(`builtins["${k}"] registered`, present);
  }
});

summary('z5-builtins-coverage');
