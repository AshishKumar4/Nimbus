#!/usr/bin/env node
/**
 * bundle-npm-cjs.mjs — Pre-bundle user-space CJS packages as ESM.
 *
 * PHASE1-BLOCKER.md Path C was to pre-bundle @vitejs/plugin-react.
 * Runtime probe revealed a deeper issue: react, react-dom, and
 * scheduler ALL ship CJS entries (`module.exports = require(...)`).
 * Browsers can't load CJS via `<script type="module">`, and
 * workerd forbids runtime `new Function(src)` / `eval()` at
 * request-handler time — so we can't transform CJS → ESM in the
 * facet on the fly.
 *
 * Solution: bundle the common CJS packages at build time into ESM
 * artifacts, emit them as LOADER modules alongside plugin-react,
 * and rewrite the Vite resolver's output so that
 *   /home/user/app/node_modules/react/index.js
 * maps to the pre-bundled
 *   cirrus-npm/react.js
 * at facet load time.
 *
 * Packages we pre-bundle (the common React dev dependencies):
 *   - react (+ jsx-runtime)
 *   - react-dom (+ client)
 *   - scheduler
 *
 * Each is bundled via esbuild with CJS-interop (`module.exports`
 * becomes `export default`, auto-detected named exports via
 * cjs-module-lexer).
 *
 * Output: src/cirrus-npm-cjs.generated.ts exporting a
 * Record<string, string> of virtual-path → ESM-bundle-string.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'cirrus-npm-cjs.generated.ts');

// Packages to pre-bundle. Each entry: { subpath, moduleSuffix } is
// an exported entry. The bundler resolves each subpath against the
// installed package and produces a separate ESM bundle.
//
// `externalPeers` is the set of peer packages that MUST be kept
// external at bundle time, so they resolve to the SHARED pre-built
// bundle (same instance) instead of inlining a private copy. Without
// this, react-dom's inlined react copy and the user-facing react
// bundle would be two separate runtime instances — the classic
// "Invalid hook call" React error.
const TARGETS = [
  {
    pkg: 'react',
    version: '^18.3.1',
    externalPeers: [],
    entries: [
      { subpath: '', moduleSuffix: '.js' },
    ],
  },
  {
    // jsx-runtime + jsx-dev-runtime live alongside react but require
    // the SAME react instance the user imports — so they get their
    // own bundle target with react marked external.
    pkg: 'react',
    version: '^18.3.1',
    externalPeers: ['react'],
    entries: [
      { subpath: 'jsx-runtime', moduleSuffix: '.js' },
      { subpath: 'jsx-dev-runtime', moduleSuffix: '.js' },
    ],
  },
  {
    pkg: 'react-dom',
    version: '^18.3.1',
    // react + scheduler are SHARED peers.
    externalPeers: ['react', 'scheduler'],
    entries: [
      { subpath: '', moduleSuffix: '.js' },
    ],
  },
  {
    // react-dom/client is a tiny wrapper around react-dom. Keep
    // `react-dom` itself external (shared with the bare react-dom
    // import) so we don't ship two copies of react-doms 980 KB
    // runtime.
    pkg: 'react-dom',
    version: '^18.3.1',
    externalPeers: ['react', 'scheduler', 'react-dom'],
    entries: [
      { subpath: 'client', moduleSuffix: '.js' },
    ],
  },
  {
    pkg: 'scheduler',
    version: '*',
    externalPeers: [],
    entries: [
      { subpath: '', moduleSuffix: '.js' },
    ],
  },
];

const NODE_BUILTINS = [
  'node:assert', 'node:buffer', 'node:child_process', 'node:crypto',
  'node:dns', 'node:events', 'node:fs', 'node:fs/promises', 'node:http',
  'node:https', 'node:module', 'node:net', 'node:os', 'node:path',
  'node:perf_hooks', 'node:process', 'node:querystring', 'node:readline',
  'node:stream', 'node:string_decoder', 'node:timers', 'node:timers/promises',
  'node:tls', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:worker_threads', 'node:zlib',
  'fs', 'path', 'url', 'util', 'os', 'net', 'crypto', 'child_process',
  'dns', 'tty', 'worker_threads', 'assert', 'process', 'v8', 'events',
  'http', 'https', 'zlib', 'stream', 'buffer', 'readline', 'module',
  'string_decoder', 'timers', 'querystring', 'perf_hooks',
];

async function ensureInstalled() {
  const SRC_DIR = path.join(ROOT, '.cirrus-npm-cjs-src');
  const haveReact = await fs.access(path.join(SRC_DIR, 'node_modules/react/package.json')).then(() => true).catch(() => false);
  const haveLexer = await fs.access(path.join(SRC_DIR, 'node_modules/cjs-module-lexer/package.json')).then(() => true).catch(() => false);
  if (haveReact && haveLexer) return SRC_DIR;
  await fs.mkdir(SRC_DIR, { recursive: true });
  await fs.writeFile(path.join(SRC_DIR, 'package.json'), JSON.stringify({
    name: 'cirrus-npm-cjs-build', private: true, version: '0.0.0',
    dependencies: {
      ...Object.fromEntries(
        TARGETS.filter((t) => t.version !== '*').map((t) => [t.pkg, t.version]),
      ),
      'cjs-module-lexer': '^2',
    },
  }, null, 2));
  const { execSync } = await import('node:child_process');
  console.log('[bundle-npm-cjs] installing react/react-dom/scheduler + cjs-module-lexer...');
  execSync('bun install', { cwd: SRC_DIR, stdio: 'inherit' });
  return SRC_DIR;
}

/**
 * Walk the CJS entry + its `require(...)` transitive closure within
 * the same package and union all their exports. Needed because react's
 * `index.js` is `module.exports = require('./cjs/react.development.js')`
 * — cjs-module-lexer parsing `index.js` finds only "default" reexport,
 * so we have to follow the chain.
 *
 * We detect `module.exports = require(...)` and follow the referenced
 * file to enumerate ITS exports (which are the real ones).
 */
async function discoverExports(srcDir, pkgName, subpath, lexer) {
  const req = createRequire(path.join(srcDir, 'package.json'));
  const spec = subpath ? `${pkgName}/${subpath}` : pkgName;
  let entryPath;
  try { entryPath = req.resolve(spec); }
  catch (e) { console.warn('[bundle-npm-cjs] cant resolve', spec, e?.message); return []; }
  return await walkExports(entryPath, lexer, new Set());
}

async function walkExports(filepath, lexer, seen) {
  if (seen.has(filepath)) return [];
  seen.add(filepath);
  let src;
  try { src = await fs.readFile(filepath, 'utf8'); }
  catch { return []; }
  let parsed;
  try { parsed = lexer.parse(src); }
  catch { return []; }
  const names = new Set([...parsed.exports]);
  // Follow re-exports (e.g. `module.exports = require('./dev.js')`).
  for (const re of parsed.reexports) {
    if (!re.startsWith('.')) continue; // bare-spec re-exports: skip
    const dir = path.dirname(filepath);
    const abs = path.resolve(dir, re);
    for (const tryPath of [abs, abs + '.js', abs + '/index.js']) {
      try { await fs.access(tryPath); 
        const nested = await walkExports(tryPath, lexer, seen);
        for (const n of nested) names.add(n);
        break;
      } catch { continue; }
    }
  }
  return [...names];
}

async function bundleEntry(srcDir, pkgName, subpath, externalPeers, lexer) {
  const exportNames = await discoverExports(srcDir, pkgName, subpath, lexer);
  const filtered = exportNames.filter(
    (n) => /^[a-zA-Z_$][\w$]*$/.test(n) && n !== 'default',
  );

  const fullSpec = subpath ? `${pkgName}/${subpath}` : pkgName;
  const stubPath = path.join(srcDir, '.stub-' + pkgName.replace(/[^a-z0-9]/gi, '_') + '-' + (subpath || 'root').replace(/[^a-z0-9]/gi, '_') + '.mjs');
  const namedLines = filtered.map(
    (n) => `export const ${n} = _mod.${n} ?? _default?.${n};`,
  ).join('\n');
  await fs.writeFile(stubPath, `
import * as _mod from ${JSON.stringify(fullSpec)};
const _default = _mod.default ?? _mod;
${namedLines}
export default _default;
`);
  try {
    // externalPeers: list of bare specifiers (e.g. 'react', 'scheduler')
    // that must NOT be inlined — they'll be served as separate
    // pre-built bundles from the same registry, ensuring a single
    // runtime instance per session.
    //
    // Precise rule: peer matches the exact name OR any subpath of it,
    // EXCEPT the current entry (we're building `pkgName/subpath`, so
    // that specifier has to resolve to its actual file, not loop back
    // to itself).
    const currentEntry = subpath ? `${pkgName}/${subpath}` : pkgName;
    const peerExternalPlugin = {
      name: 'cirrus-peer-external',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const spec = args.path;
          // Never externalize our own entry.
          if (spec === currentEntry) return null;
          for (const peer of externalPeers) {
            if (spec === peer || spec.startsWith(peer + '/')) {
              return { path: spec, external: true };
            }
          }
          return null;
        });
      },
    };
    const result = await esbuild.build({
      entryPoints: [stubPath],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
      external: NODE_BUILTINS,
      plugins: externalPeers.length > 0 ? [peerExternalPlugin] : [],
      conditions: ['module', 'import', 'browser', 'default'],
      mainFields: ['module', 'browser', 'main'],
      keepNames: true,
      minify: false,
      define: {
        'process.env.NODE_ENV': JSON.stringify('development'),
        'import.meta.url': JSON.stringify(`file:///cirrus-npm/${pkgName}${subpath ? '/' + subpath : ''}.js`),
      },
      absWorkingDir: srcDir,
      logLevel: 'warning',
    });
    if (result.errors.length) {
      console.error(`[bundle-npm-cjs] ${fullSpec} errors:`, result.errors);
      throw new Error('build failed');
    }
    let text = result.outputFiles[0].text;

    // Post-process: replace every `__require("<peer>")` call with a
    // direct reference to a module-top ESM import. esbuild emits
    // __require() calls for EXTERNAL CJS requires (e.g.
    // `var react_dom = require("react-dom")` in the source becomes
    // `var react_dom = __require("react-dom")` in the bundle). The
    // __require polyfill tries global `require`, which the browser
    // doesn't have. We rewrite to a hoisted ESM import so the
    // browser loads the shared react bundle.
    if (externalPeers.length > 0) {
      const imports = [];
      const seen = new Map();
      let counter = 0;
      const peerRe = new RegExp(
        `__require\\((["'])(${externalPeers
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')}(?:/[\\w./@-]+)?)\\1\\)`,
        'g',
      );
      text = text.replace(peerRe, (_, q, spec) => {
        if (!seen.has(spec)) {
          const name = `__cirrus_peer_${counter++}`;
          seen.set(spec, name);
          imports.push(
            `import * as ${name}_ns from ${JSON.stringify(spec)};`,
            `const ${name} = ${name}_ns.default ?? ${name}_ns;`,
          );
        }
        return seen.get(spec);
      });
      if (imports.length > 0) {
        text = imports.join('\n') + '\n' + text;
      }
    }

    return text;
  } finally {
    await fs.unlink(stubPath).catch(() => {});
  }
}

async function main() {
  const srcDir = await ensureInstalled();
  const lexerReq = createRequire(path.join(srcDir, 'package.json'));
  const lexer = lexerReq('cjs-module-lexer');
  await lexer.init();
  const bundles = {};
  const versions = {};
  let totalBytes = 0;

  for (const target of TARGETS) {
    const pkgPath = path.join(srcDir, 'node_modules', target.pkg, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      versions[target.pkg] = pkg.version;
    } catch {
      versions[target.pkg] = '(missing)';
    }
    for (const entry of target.entries) {
      const label = entry.subpath ? `${target.pkg}/${entry.subpath}` : target.pkg;
      console.log(`[bundle-npm-cjs] bundling ${label}...`);
      try {
        const text = await bundleEntry(srcDir, target.pkg, entry.subpath, target.externalPeers || [], lexer);
        const moduleName = (entry.subpath ? `${target.pkg}-${entry.subpath}` : target.pkg).replace(/[^a-z0-9]/gi, '-') + entry.moduleSuffix;
        bundles[label] = { moduleName, code: text };
        totalBytes += text.length;
        console.log(`[bundle-npm-cjs]   ${label} → ${moduleName} (${(text.length / 1024).toFixed(1)} KB)`);
      } catch (e) {
        console.error(`[bundle-npm-cjs] FAILED ${label}:`, e?.message || e);
        throw e;
      }
    }
  }

  console.log(`[bundle-npm-cjs] total: ${(totalBytes / 1024).toFixed(1)} KB across ${Object.keys(bundles).length} entries`);

  // Emit the generated TS file. Shape:
  //   CIRRUS_NPM_CJS_BUNDLES: Record<pkgEntrySpec, { moduleName, code }>
  //   CIRRUS_NPM_CJS_VERSIONS: Record<pkgName, version>
  const header = `/**
 * cirrus-npm-cjs.generated.ts — AUTO-GENERATED by
 * scripts/bundle-npm-cjs.mjs. DO NOT EDIT.
 *
 * Pre-bundled ESM artifacts for CJS packages in the React ecosystem
 * (react, react-dom, scheduler). Ships alongside cirrus-plugin-react.
 * Consumed by src/cirrus-real.ts — injected as LOADER modules, and
 * the Vite resolver's output (e.g. /home/user/app/node_modules/react/index.js)
 * is rewritten to point at one of these bundles at request time.
 */

export interface CirrusNpmCjsBundle {
  moduleName: string;
  code: string;
}

export const CIRRUS_NPM_CJS_VERSIONS: Record<string, string> = ${JSON.stringify(versions, null, 2)};

export const CIRRUS_NPM_CJS_BUNDLES: Record<string, CirrusNpmCjsBundle> = ${
    JSON.stringify(bundles, null, 2)
  };
`;
  await fs.writeFile(OUT, header, 'utf8');
  console.log(`[bundle-npm-cjs] wrote ${OUT} (${(header.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('[bundle-npm-cjs] failed:', e);
  process.exit(1);
});
