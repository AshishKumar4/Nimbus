#!/usr/bin/env bun
// X.5-Z5 functional — prefetch walker (require-resolver IMPORT_RE) catches
// the same minified ;import{ shape as looksLikeEsm.
//
// Discovered post-fix to src/facet-manager.ts looksLikeEsm: the SAME
// blind-spot exists in src/require-resolver.ts IMPORT_RE (line 79). When
// looksLikeEsm finally accepts the .mjs file but the walker has already
// failed to enqueue the transitive `;import{compile as M}from"@tailwindcss/node"`
// dep, the runtime `require('@tailwindcss/node')` throws
// "Cannot find module '@tailwindcss/node' (from .../@tailwindcss/vite/dist)".
//
// Z5 plan §3 didn't cite require-resolver:79 explicitly. This probe is the
// completion of §3's intent: the same dual-relaxation must be applied
// to the prefetch walker too, otherwise the e2e blockers don't lift.
//
// PRE-FIX: red — minified ESM specs are NOT enumerated by the walker.
// POST-FIX: green — they are.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeVfs } from '../../x5c/_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

// Synth fixture mirroring the tw-vite shape:
//   /home/user/app/script.js does `require('@tailwindcss/vite')`
//   /home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs is
//   minified ESM with `;import{compile as M}from"@tailwindcss/node"`.
//   /home/user/app/node_modules/@tailwindcss/vite/package.json points
//   to dist/index.mjs.
//   /home/user/app/node_modules/@tailwindcss/node/dist/index.js is the
//   transitive dep that the walker must enqueue.

const fixture = {
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),
  'home/user/app/script.js': "require('@tailwindcss/vite');",

  'home/user/app/node_modules/@tailwindcss/vite/package.json': JSON.stringify({
    name: '@tailwindcss/vite', version: '4.2.4',
    type: 'module',
    main: './dist/index.mjs',
    exports: { '.': { default: './dist/index.mjs' } },
  }),
  // Minified ESM: var declarations followed by `;import{...}from"..."` on
  // the same line. Same shape as @tailwindcss/vite/dist/index.mjs head.
  'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs':
    'var C=1,D=2;import{compile as M,env as _}from"@tailwindcss/node";' +
    ';import{x}from"@tailwindcss/oxide";' +
    'function f(){return 1};export{f as default};',

  'home/user/app/node_modules/@tailwindcss/node/package.json': JSON.stringify({
    name: '@tailwindcss/node', version: '4.2.4',
    main: './dist/index.js',
  }),
  'home/user/app/node_modules/@tailwindcss/node/dist/index.js':
    "module.exports = { compile: () => 'css', env: 'node' };",

  'home/user/app/node_modules/@tailwindcss/oxide/package.json': JSON.stringify({
    name: '@tailwindcss/oxide', version: '4.2.4',
    main: './dist/index.js',
  }),
  'home/user/app/node_modules/@tailwindcss/oxide/dist/index.js':
    "module.exports = { x: 'oxide' };",
};

const vfs = makeVfs(fixture);
const entry = "require('@tailwindcss/vite');";
const prefetch = prefetchForRequire(vfs, entry, '/home/user/app');
const bundle = prefetch.bundle;
const keys = Object.keys(bundle);
console.log(`# prefetched ${keys.length} files (truncated=${prefetch.truncated})`);
for (const k of keys.sort()) console.log('#  ' + k);

// PRIMARY: index.mjs reaches the bundle (this part already worked
// pre-fix because we walk via the require chain).
ok('vite/dist/index.mjs in bundle',
  'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs' in bundle);

// PRIMARY (post-fix only): minified `;import{...}from"@tailwindcss/node"`
// gets parsed and the dep is enqueued.
ok('@tailwindcss/node/dist/index.js in bundle (walker followed minified ;import{)',
  'home/user/app/node_modules/@tailwindcss/node/dist/index.js' in bundle);

// PRIMARY (post-fix only): a second `;import{...}from"@tailwindcss/oxide"`
// on the same line is also enumerated. Confirms multi-import pickup.
ok('@tailwindcss/oxide/dist/index.js in bundle (multiple ;import{ on same line)',
  'home/user/app/node_modules/@tailwindcss/oxide/dist/index.js' in bundle);

summary('v-tailwindcss-vite-prefetch-walker');
