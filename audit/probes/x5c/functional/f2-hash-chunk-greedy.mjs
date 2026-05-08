// X.5-C functional probe — greedyAddMainEntries oversamples sibling
// hash-named chunks (unbuild output pattern).
//
// Pre-fix: FAIL. greedyAddMainEntries adds only the package's main/module/
//          exports entry (e.g. dist/index.cjs). Sibling files matching the
//          unbuild hash-chunk pattern (e.g. dist/index.<hash>.cjs) and the
//          contents of dist/shared/ are missed. When the entry's content
//          contains `require('./shared/x.<hash>.cjs')`, the prefetch's
//          REQUIRE_RE catches the require — BUT the file isn't added
//          because of cap eviction OR walk-order in big trees.
// Post-fix: PASS. The greedy oversample includes hash-named siblings AND
//           walks one level into shared/ unconditionally for every package
//           it visits.
//
// Rationale: Fix #1 (ESM walker) gets us reachability via the require chain,
// but in big trees (nuxt: 516 packages, ~10k+ files) the require-resolver
// caps fire before the deep transitives are reached. Greedy oversample is
// the defensive fall-back.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-C functional/f2-hash-chunk-greedy — greedyAddMainEntries pulls hash-chunk siblings');

// To exercise greedyAddMainEntries, we have to invoke buildPrefetchBundle
// (or a stand-in). Reading the function shape reveals it's a **non-exported
// internal** of facet-manager.ts. So we exercise it via the only public
// callable: build a minimal harness that imports facet-manager and calls
// the pure helper directly.
//
// In Phase C the helper's change is internal; we don't need to export it
// for this probe — we re-implement the call inline, mirroring the function
// structure and assertions on the returned bundle. This is the same pattern
// W3.5 used for its functional/esm-in-bundle probe.

// greedyAddMainEntries is currently NOT exported from src/facet-manager.ts.
// Phase C will add a named export so this probe can drive the real impl.
// Until then we fall through to the inline emulator.

// Synthesize pathe's actual file shape (unbuild output).
const vfs = makeVfs({
  // pathe pkg
  'home/user/app/node_modules/pathe/package.json': JSON.stringify({
    name: 'pathe',
    version: '2.0.3',
    type: 'module',
    main: './dist/index.cjs',
    module: './dist/index.mjs',
    exports: {
      '.': {
        import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
      './utils': {
        import: { types: './dist/utils.d.mts', default: './dist/utils.mjs' },
        require: { types: './dist/utils.d.cts', default: './dist/utils.cjs' },
      },
    },
  }),
  // Entry files
  'home/user/app/node_modules/pathe/dist/index.cjs':
    "'use strict';\nconst _path = require('./shared/pathe.BSlhyZSM.cjs');\nmodule.exports = _path;\n",
  'home/user/app/node_modules/pathe/dist/index.mjs':
    "import { _path } from './shared/pathe.M-eThtNZ.mjs';\nexport default _path;\n",
  'home/user/app/node_modules/pathe/dist/utils.cjs':
    "'use strict';\nconst _path = require('./shared/pathe.BSlhyZSM.cjs');\nmodule.exports = _path.utils;\n",
  'home/user/app/node_modules/pathe/dist/utils.mjs':
    "import { _path } from './shared/pathe.M-eThtNZ.mjs';\nexport default _path.utils;\n",
  // Shared chunks (the unbuild output the test must catch)
  'home/user/app/node_modules/pathe/dist/shared/pathe.BSlhyZSM.cjs':
    "'use strict';\nconst _path = { sep: '/' };\nmodule.exports._path = _path;\n",
  'home/user/app/node_modules/pathe/dist/shared/pathe.M-eThtNZ.mjs':
    "const _path = { sep: '/' };\nexport { _path };\n",
});

// Inline emulation of greedyAddMainEntries with assertions on what it
// adds. Same shape as src/facet-manager.ts:593-677. We re-emit the
// function logic here so the probe is self-contained — but the IDENTITY
// we assert is the bundle membership; the post-fix shape differs only
// in how many sibling files land.
function emulateGreedy(vfs, cwd) {
  const bundle = {};
  const cwdStripped = cwd.replace(/^\/+/, '');
  const nmDir = cwdStripped + '/node_modules';
  const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];

  function addOne(p) {
    const stripped = p.replace(/^\/+/, '');
    if (stripped in bundle) return false;
    if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return false;
    bundle[stripped] = vfs.readFileString(stripped);
    return true;
  }

  function addPkgEntry(pkgDir) {
    addOne(pkgDir + '/package.json');
    let meta;
    try { meta = JSON.parse(vfs.readFileString(pkgDir + '/package.json')); } catch { meta = null; }
    const candidates = new Set();
    if (meta) {
      if (typeof meta.main === 'string') candidates.add(meta.main);
      if (typeof meta.module === 'string') candidates.add(meta.module);
      const exp = meta.exports;
      if (typeof exp === 'string') candidates.add(exp);
      else if (exp && typeof exp === 'object') {
        const dot = exp['.'];
        if (typeof dot === 'string') candidates.add(dot);
        else if (dot && typeof dot === 'object') {
          for (const k of ['require', 'node', 'default', 'import']) {
            const v = dot[k];
            if (typeof v === 'string') candidates.add(v);
            else if (v && typeof v === 'object') {
              for (const k2 of ['require', 'node', 'default', 'import']) {
                if (typeof v[k2] === 'string') candidates.add(v[k2]);
              }
            }
          }
        }
      }
    }
    if (candidates.size === 0) candidates.add('index.js');
    for (const rel of candidates) {
      const norm = rel.replace(/^\.\//, '');
      const base = pkgDir + '/' + norm;
      let landed = false;
      const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
      for (const candidate of tries) {
        if (vfs.exists(candidate.replace(/^\/+/, '')) &&
            !vfs.isDirectory(candidate.replace(/^\/+/, ''))) {
          if (addOne(candidate)) { landed = true; break; }
        }
      }
      if (landed) {
        // ─── X.5-C Fix #2 territory ───────────────────────────────────
        // After fix: scan sibling files for the unbuild hash-chunk
        // pattern AND walk one level into a `shared/` subdir. The
        // assertions below will FAIL pre-fix (entry file is the only
        // thing in the bundle) and PASS post-fix.
        // We DO NOT inline-implement the fix logic here — that would
        // make the probe self-fulfilling. Instead we just stop, and
        // rely on the assertions to characterize bundle contents.
        break;
      }
    }
  }

  try {
    for (const pkg of vfs.readdir(nmDir)) {
      if (pkg.type !== 'directory') continue;
      const pkgDir = nmDir + '/' + pkg.name;
      if (pkg.name.startsWith('@')) {
        try {
          for (const sub of vfs.readdir(pkgDir)) {
            if (sub.type === 'directory') addPkgEntry(pkgDir + '/' + sub.name);
          }
        } catch { /* ignore */ }
      } else {
        addPkgEntry(pkgDir);
      }
    }
  } catch { /* ignore */ }
  return bundle;
}

// Exercise the REAL greedyAddMainEntries through the public boundary.
// We import the buildPrefetchBundle wrapper indirectly via facet-manager
// — but that requires VFS state setup that's heavier than this probe
// needs. Instead we invoke our emulator (which mirrors the pre-fix
// behaviour exactly) and ALSO invoke the real one via a thin re-export
// that Phase C will add to facet-manager.
//
// Phase C addendum (pre-emptive): we will export greedyAddMainEntries
// from facet-manager.ts so this probe can directly verify behaviour.
// Without that export, the probe runs against the emulator.

let bundle;
let usedReal = false;
try {
  // Try to import the real one (will be added in Phase C).
  const fm = await import('../../../../src/facets/manager.ts');
  if (typeof fm.greedyAddMainEntries === 'function') {
    const b = {};
    fm.greedyAddMainEntries(vfs, '/home/user/app', b, { totalBytes: 0, fileCount: 0 });
    bundle = b;
    usedReal = true;
  }
} catch { /* fall through */ }
if (!bundle) {
  bundle = emulateGreedy(vfs, '/home/user/app');
}
console.log('  (using ' + (usedReal ? 'real greedyAddMainEntries export' : 'emulator (pre-fix shape)') + ')');

const inBundle = (p) => p.replace(/^\/+/, '') in bundle;

// (1) Entry file (baseline expectation — pre + post fix both pass)
check(
  'pathe/dist/index.cjs — entry file in bundle (baseline)',
  inBundle('home/user/app/node_modules/pathe/dist/index.cjs'),
  'main field (CJS) — always lands',
);

// (2) Hash-chunk sibling — the X.5-C assertion
check(
  'pathe/dist/shared/pathe.BSlhyZSM.cjs — hash-chunk shared sibling',
  inBundle('home/user/app/node_modules/pathe/dist/shared/pathe.BSlhyZSM.cjs'),
  'unbuild output pattern: shared/<name>.<hash>.cjs — required by index.cjs',
);

// (3) ESM hash-chunk sibling
check(
  'pathe/dist/shared/pathe.M-eThtNZ.mjs — ESM hash-chunk sibling',
  inBundle('home/user/app/node_modules/pathe/dist/shared/pathe.M-eThtNZ.mjs'),
  'ESM variant of the same shared chunk',
);

const ok = summary();
process.exit(ok ? 0 : 1);
