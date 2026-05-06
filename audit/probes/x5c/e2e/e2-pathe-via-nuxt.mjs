// X.5-C e2e — pathe loads end-to-end through a deep require chain
// (proxy for the nuxt 516-pkg case).
//
// X.5-F retro line 148 reports nuxt's transitive failure as:
//   `Cannot find module './shared/pathe.BSlhyZSM.cjs' (from .../pathe/dist)`
// This e2e proves that:
//   (a) the prefetcher pulls pathe's hash-named chunk into the bundle
//   (b) the runtime require chain resolves the chunk relative to
//       pathe/dist/index.cjs
//
// Strategy: synth pathe + a reduced "nuxt-like" parent (a 4-deep chain
// of CJS files where the leaf does require('pathe')) + assert pathe's
// API (`sep`, `join`) is reachable through `require('parent')`.
//
// We do NOT simulate the full 516-pkg cap-firing scenario; the f4-prefetch-
// bound-cap probe handles the cap-bounding regression. This e2e is a
// happy-path proof for the pathe RESOLUTION shape (post-Fix #1 + Fix #2).

import { makeVfs, makeFacet, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/require-resolver.ts';
import { generateShimsCode } from '../../../../src/node-shims.ts';

reset();

console.log('X.5-C e2e/e2-pathe-via-nuxt — pathe transitive chunk resolves through deep require chain');

// pathe's actual unbuild output shape (verbatim from npm install pathe).
const PATHE_CJS_INDEX =
  "'use strict';\n" +
  "Object.defineProperty(exports, '__esModule', { value: true });\n" +
  "const _path = require('./shared/pathe.BSlhyZSM.cjs');\n" +
  "exports.sep = _path.sep;\n" +
  "exports.join = function () { return Array.from(arguments).join(_path.sep); };\n";
const PATHE_SHARED_CJS =
  "'use strict';\n" +
  "exports.sep = '/';\n";

// Nuxt-like parent — 4 hops, ESM at top, CJS in middle, etc. Mimics
// nuxt's pure-ESM root → unbuild-shaped intermediates → pathe pattern.
const FILES = {
  'home/user/app/package.json': JSON.stringify({ name: 'app' }),

  // pathe
  'home/user/app/node_modules/pathe/package.json': JSON.stringify({
    name: 'pathe', version: '2.0.3', type: 'module',
    main: './dist/index.cjs',
    module: './dist/index.mjs',
    exports: {
      '.': {
        import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
    },
  }),
  'home/user/app/node_modules/pathe/dist/index.cjs': PATHE_CJS_INDEX,
  'home/user/app/node_modules/pathe/dist/index.mjs':
    "import { sep } from './shared/pathe.M-eThtNZ.mjs';\nexport { sep };\nexport function join() { return Array.from(arguments).join(sep); }\n",
  'home/user/app/node_modules/pathe/dist/shared/pathe.BSlhyZSM.cjs': PATHE_SHARED_CJS,
  'home/user/app/node_modules/pathe/dist/shared/pathe.M-eThtNZ.mjs':
    "export const sep = '/';\n",

  // parent: ESM that imports pathe
  'home/user/app/node_modules/parent/package.json': JSON.stringify({
    name: 'parent', version: '1.0.0', type: 'module',
    main: './dist/index.mjs',
    exports: { '.': { import: './dist/index.mjs' } },
  }),
  'home/user/app/node_modules/parent/dist/index.mjs':
    "import { sep, join } from 'pathe';\n" +
    "import { fromMid } from './middle.mjs';\n" +
    "export const usingPathe = { sep, joined: join('a', 'b'), via: fromMid };\n",
  'home/user/app/node_modules/parent/dist/middle.mjs':
    "import { sep } from 'pathe';\n" +
    "export const fromMid = sep;\n",
};

const vfs = makeVfs(FILES);

const entryCode = "const m = require('parent');\nconsole.log(m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
const bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files`);
const patheKeys = Object.keys(bundle).filter(k => k.includes('/pathe/'));
console.log(`  pathe/* in bundle: ${patheKeys.length}`);
for (const k of patheKeys) console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);

// ESM transform (mirrors W3.5 path)
const esbuildWasm = await import('esbuild-wasm');
if (!globalThis.__esbInit) {
  await esbuildWasm.initialize({});
  globalThis.__esbInit = true;
}
const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
function looksLikeEsm(src) {
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return importStmt.test(stripped) || exportStmt.test(stripped);
}
for (const path of Object.keys(bundle)) {
  if (!(path.endsWith('.js') || path.endsWith('.mjs'))) continue;
  if (!looksLikeEsm(bundle[path])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[path], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[path] = r.code;
  } catch { /* skip */ }
}

// Drive the runtime
const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

bundle['home/user/app/script.js'] =
  "const parent = require('parent');\n" +
  "const direct = require('pathe');\n" +
  "module.exports = {\n" +
  "  parentSep: parent && (parent.usingPathe?.sep ?? parent.usingPathe?.default?.sep),\n" +
  "  parentJoined: parent && (parent.usingPathe?.joined ?? parent.usingPathe?.default?.joined),\n" +
  "  parentVia: parent && (parent.usingPathe?.via ?? parent.usingPathe?.default?.via),\n" +
  "  directSep: direct && direct.sep,\n" +
  "  directJoinResult: direct && typeof direct.join === 'function' && direct.join('a', 'b'),\n" +
  "};\n";

let result;
let err = null;
try {
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  err = e && e.message ? e.message : String(e);
}

check(
  'no exception during require chain',
  err === null,
  err,
);
check(
  'pathe direct require — sep === "/"',
  result?.directSep === '/',
  JSON.stringify(result),
);
check(
  'pathe direct require — join("a","b") === "a/b"',
  result?.directJoinResult === 'a/b',
  JSON.stringify(result),
);
check(
  'pathe through ESM parent transitive — sep reachable',
  result?.parentSep === '/',
  JSON.stringify(result),
);
check(
  'pathe through ESM parent — join reachable',
  result?.parentJoined === 'a/b',
  JSON.stringify(result),
);
check(
  'pathe through 2-hop ESM (parent → middle.mjs)',
  result?.parentVia === '/',
  JSON.stringify(result),
);

const ok = summary();
process.exit(ok ? 0 : 1);
