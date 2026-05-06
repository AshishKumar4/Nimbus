#!/usr/bin/env bun
// X5M regression: shim builtins[] registration list contains all expected
// previously-known keys. Catches accidental removal during M-2 edits.

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource } from '../functional/_eval-shims.mjs';

const src = getShimSource();

const REQUIRED_BUILTINS = [
  // Core
  'fs', 'path', 'os', 'process', 'events', 'stream', 'crypto',
  'util', 'assert', 'querystring', 'string_decoder',
  'buffer', 'http', 'https', 'net', 'dns', 'tls',
  'tty', 'module', 'timers', 'zlib', 'readline',
  'perf_hooks', 'worker_threads', 'vm', 'http2', 'repl',
  'diagnostics_channel', 'async_hooks', 'url',
  // Subpath
  'fs/promises', 'node:fs/promises',
  'timers/promises', 'node:timers/promises',
];

group('Required builtins[] keys are all registered', () => {
  for (const k of REQUIRED_BUILTINS) {
    // Match either bare or quoted form
    const reBare = new RegExp(`builtins\\.${k.replace(/[^\w]/g, '\\$&')}\\s*=`);
    const reQuoted = new RegExp(`builtins\\["${k.replace(/[^\w/]/g, '\\$&')}"\\]\\s*=`);
    const present = reBare.test(src) || reQuoted.test(src);
    ok(`builtins["${k}"] registered`, present);
  }
});

summary('builtins-coverage');
