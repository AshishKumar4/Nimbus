#!/usr/bin/env node
/**
 * bundle-facet-workers.mjs — Produce the source strings that Nimbus
 * injects into dynamic workers.
 *
 * WHY this exists:
 *   Dynamic workers (NimbusFacetPool / NimbusIsolatePool) receive their
 *   module source as strings — they cannot import supervisor modules,
 *   and user functions cannot capture supervisor closure variables. Any
 *   TypeScript the injected code needs must therefore be esbuild-bundled
 *   into a self-contained source string at build time.
 *
 *   For the npm install facet we need the streaming tar parser
 *   (@nimbus-sh/core src/_shared/tarball-stream.ts) available as a
 *   top-level named export
 *   the user function can call. We esbuild-bundle that source file into
 *   a self-contained ES module string, and NimbusFacetPool's `preamble`
 *   option splices it into the generated module between the
 *   WorkerEntrypoint import and the user function.
 *
 *   The virtual socket kernel (src/runtime/virtual-socket-kernel.ts) is
 *   bundled the same way, but as an IIFE that installs
 *   globalThis.__nimbusVirtualSockets — python-runner and ruby-runner
 *   splice it into their socket process worker module sources.
 *
 *   The answering supervisor client (@nimbus-sh/core
 *   src/runtime/vfs-supervisor.ts answeringSupervisor) is an IIFE the same
 *   way, installing globalThis.__nimbusAnsweringSupervisor for the node
 *   bodies, which are generated text and splice it.
 *
 *   The WASI shim (src/runtime/wasi/preamble.ts) is bundled as a flat ESM
 *   body, NOT an IIFE: runners and tests append `export { __wasiInitFS, … }`
 *   to the emitted string and wasi-threads.ts is concatenated after it into
 *   the same evaluated scope, so its declarations have to stay at top level.
 *   `requiredTopLevel` below asserts exactly that.
 *
 * Output:
 *   src/loaders/generated-workers.ts — exports
 *       TAR_STREAM_PREAMBLE: string
 *       W7_FRAME_PREAMBLE: string         (W7 — streaming bulk-write encoder)
 *   @nimbus-sh/core src/runtime/virtual-socket-kernel.generated.ts — exports
 *       VIRTUAL_SOCKET_KERNEL_SRC: string
 *   @nimbus-sh/core src/runtime/supervisor-answering.generated.ts — exports
 *       SUPERVISOR_ANSWERING_SRC: string
 *   @nimbus-sh/core src/runtime/wasi-instance.generated.ts — exports
 *       WASI_INSTANCE_BODY_SRC: string
 *   @nimbus-sh/core src/runtime/bash-runner.generated.ts — exports
 *       BASH_RUNNER_BODY_SRC: string
 *   public/_assets/runtime/esbuild-cli-<buildId>.js — the `esbuild` command's
 *       runner, which only the session's esbuild facet evaluates. Staged as an
 *       asset rather than a string in the Worker bundle, like the esbuild
 *       adapter and the node shims; src/esbuild-cli-artifact.generated.ts
 *       exports ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_BUILD_ID, ESBUILD_CLI_SHA256.
 *   public/_assets/runtime/oxc-facet-<buildId>.js — the transform facet's
 *       runtime (the Oxc wasm's driver, the dynamic-import rewrite and the
 *       top-level-await lowering), staged the same way;
 *       src/oxc-facet-artifact.generated.ts exports OXC_FACET_ASSET_PATH,
 *       OXC_FACET_BUILD_ID, OXC_FACET_SHA256.
 *
 * Runs as a postinstall + predev + predeploy step via package.json.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// core's own parser dependency, reached through the workspace hoist; the
// script runs under plain node at postinstall, so nothing here is TypeScript.
import { parse } from 'acorn';

import { resolvePackageDir } from './resolve-package-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const coreRoot = join(root, '..', 'core');
const platformRoot = join(root, '..', 'platform');

/**
 * The bundle without its comments. esbuild keeps every comment that sits
 * inside an expression or object literal, plus its own `// path` module
 * markers, and nothing reads any of them: the strings are evaluated, never
 * shown, mapped or `toString()`ed. The comment ranges come from a real
 * parse of the output, so a `//` inside a string, template or regex is
 * untouched; only comments go, and a line that held nothing but a comment
 * goes with it. Every other character, identifier and line stays put.
 */
function withoutComments(text) {
  const comments = [];
  parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, onComment: comments });
  let out = '';
  let cursor = 0;
  for (const { start, end } of comments) {
    if (start < cursor) continue;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEndAt = text.indexOf('\n', end);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    const leading = text.slice(lineStart, start);
    const trailing = text.slice(end, lineEnd);
    if (leading.trim() === '' && trailing.trim() === '') {
      // The comment is the whole line (or lines): drop them, newline included.
      out += text.slice(cursor, lineStart);
      cursor = lineEndAt < 0 ? text.length : lineEnd + 1;
    } else if (trailing.trim() === '') {
      // Trailing comment: drop it and the blank that led to it.
      out += text.slice(cursor, start).replace(/[ \t]+$/, '');
      cursor = end;
    } else {
      // Mid-line block comment: one space keeps the tokens on either side apart.
      out += `${text.slice(cursor, start)} `;
      cursor = end;
    }
  }
  return out + text.slice(cursor);
}

/**
 * Bundle one TS source into a self-contained ESM string suitable for
 * inlining as a facet preamble. Strips the leading `export` on
 * declarations and the aggregate `export { ... };` block so the
 * blob is inlinable into another module without re-export errors.
 */
async function bundleAsPreamble(entryPath, label) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
    // Strip TypeScript-only imports (e.g. `import type {…}`) — esbuild
    // already drops these, but leave the option default.
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error(`[bundle-facet-workers/${label}] esbuild produced no output`);
  }
  let stripped = withoutComments(result.outputFiles[0].text);
  stripped = stripped.replace(/^export\s+(async\s+function|function|const|class)\b/gm, '$1');
  stripped = stripped.replace(/\n?export\s*\{[^}]*\}\s*;\s*$/g, '');
  return stripped;
}

/**
 * Bundle the typed virtual socket kernel into a self-contained IIFE that
 * installs globalThis.__nimbusVirtualSockets. IIFE format keeps every
 * kernel identifier scoped, so the source can be spliced into any dynamic
 * worker module without colliding with runtime preambles. No minification:
 * injected source is serialized as text, and whole-bundle minification or
 * helper renaming breaks the injection contract.
 */
async function bundleVirtualSocketKernel() {
  const result = await build({
    stdin: {
      contents: [
        "import { installVirtualSocketKernel } from './src/runtime/virtual-socket-kernel.ts';",
        'installVirtualSocketKernel();',
      ].join('\n'),
      resolveDir: coreRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/virtual-socket-kernel] esbuild produced no output');
  }
  return withoutComments(result.outputFiles[0].text);
}

/**
 * The wave writer (@nimbus-sh/platform src/wave-writer.ts) as an IIFE bound
 * to the module-local `__nimbusWaveWriter`: the facets that write W7 waves
 * (git's network facet, npm's install facet) splice it ahead of their own
 * body and publish every write through it. Scoped, so its W7 encoder never
 * meets the W7 preamble's names.
 */
async function bundleWaveWriter() {
  const result = await build({
    entryPoints: [join(platformRoot, 'src', 'wave-writer.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__nimbusWaveWriter',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/wave-writer] esbuild produced no output');
  }
  const src = withoutComments(result.outputFiles[0].text);
  if (!/^var __nimbusWaveWriter = /m.test(src)) {
    throw new Error('[bundle-facet-workers/wave-writer] the bundle no longer binds __nimbusWaveWriter');
  }
  return src;
}

/**
 * The git pack layer (src/git/pack/facet.ts) as an IIFE bound to the
 * module-local `__nimbusGitPack`, spliced into the git network facet beside
 * the wave writer. Its node:crypto and node:zlib imports resolve to the
 * facet module's own namespace imports of them (GIT_PACK_NODE_IMPORTS),
 * which an IIFE cannot make itself.
 */
async function bundleGitPack() {
  const builtins = {
    'node:crypto': ['__nimbusNodeCrypto', ['createHash']],
    'node:zlib': ['__nimbusNodeZlib', ['inflateSync', 'deflateSync', 'crc32']],
  };
  const result = await build({
    entryPoints: [join(root, 'src', 'git', 'pack', 'facet.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__nimbusGitPack',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
    plugins: [{
      name: 'facet-node-builtins',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^node:(crypto|zlib)$/ }, (args) => ({ path: args.path, namespace: 'facet-node-builtin' }));
        pluginBuild.onLoad({ filter: /.*/, namespace: 'facet-node-builtin' }, (args) => {
          const [binding, names] = builtins[args.path];
          return { contents: names.map((name) => `export const ${name} = ${binding}.${name};`).join('\n'), loader: 'js' };
        });
      },
    }],
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/git-pack] esbuild produced no output');
  }
  const src = withoutComments(result.outputFiles[0].text);
  if (!/^var __nimbusGitPack = /m.test(src)) {
    throw new Error('[bundle-facet-workers/git-pack] the bundle no longer binds __nimbusGitPack');
  }
  return src;
}

/**
 * The answering supervisor client as a self-contained IIFE that installs
 * globalThis.__nimbusAnsweringSupervisor, so a facet body that is generated
 * text runs the one implementation the bundled facets import.
 */
async function bundleAnsweringSupervisor() {
  const result = await build({
    stdin: {
      contents: [
        "import { installAnsweringSupervisor } from './src/runtime/vfs-supervisor.ts';",
        'installAnsweringSupervisor();',
      ].join('\n'),
      resolveDir: coreRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/supervisor-answering] esbuild produced no output');
  }
  return withoutComments(result.outputFiles[0].text);
}

/**
 * Symbols the emitted WASI body must declare at top level. Runners and tests
 * append `export { … }` to the string and wasi-threads is concatenated into the
 * same scope, so any of these that esbuild renamed or scoped would be a
 * ReferenceError inside the facet — visible only as a dead guest.
 */
const WASI_REQUIRED_TOP_LEVEL = [
  '__wasiInitFS',
  '__wasiMakeImports',
  '__wasiRunStart',
  '__wasiRunStartAsync',
  '__wasiAdoptSupervisor',
  'fdTable',
];

/**
 * Bundle the typed WASI shim into a flat ESM body.
 *
 * No IIFE and no minification: the declarations have to stay at top level (see
 * WASI_REQUIRED_TOP_LEVEL), and the string is spliced into another module, so
 * anything that renames identifiers breaks the injection contract.
 * `cloudflare:sockets` stays external — the shim imports it dynamically at
 * facet module-init and handles its absence.
 *
 * treeShaking is OFF, and that is load-bearing rather than cautious. This body
 * and wasi-threads.ts are concatenated into ONE evaluated scope, so a
 * declaration this file makes may be consumed by the other — `__WASI_ETIMEDOUT`
 * is declared here and used only there. Elimination is scoped to this module and
 * cannot see across that seam, so it drops such a constant and the facet raises
 * a ReferenceError from inside a suspended guest, where nothing can report it.
 * The template literal this replaced had no elimination pass either; keeping it
 * off is what makes the relocation faithful.
 */
async function bundleWasiInstance() {
  const result = await build({
    entryPoints: [join(root, 'src', 'runtime', 'wasi', 'preamble.ts')],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    external: ['cloudflare:sockets'],
    treeShaking: false,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/wasi-instance] esbuild produced no output');
  }
  let src = withoutComments(result.outputFiles[0].text);
  // The body is spliced into another module; a re-export block there is a
  // syntax error, and callers append their own `export { … }`.
  src = src.replace(/^export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
  src = src.replace(/\n?export\s*\{[^}]*\}\s*;\s*$/g, '');

  const missing = WASI_REQUIRED_TOP_LEVEL.filter(
    (name) => !new RegExp(`^(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`, 'm').test(src)
      && !new RegExp(`^globalThis\\.${name}\\s*=`, 'm').test(src),
  );
  if (missing.length > 0) {
    throw new Error(
      `[bundle-facet-workers/wasi-instance] the bundle no longer declares ${missing.join(', ')} `
      + 'at top level — esbuild renamed or scoped them, and every facet that splices this body would '
      + 'fail with a ReferenceError the guest cannot report',
    );
  }
  if (/^export\b/m.test(src)) {
    throw new Error('[bundle-facet-workers/wasi-instance] an export statement survived stripping');
  }
  // The exit path identifies a guest's proc_exit by `e.constructor.name`, so the
  // class name is part of the contract, not an implementation detail. A rename
  // would turn every clean exit into exitCode 1 with the throw as its message.
  // Bundling rewrites `class __WasiExit {}` to `var __WasiExit = class {}`;
  // NamedEvaluation still infers `.name` from the binding, so both forms pass.
  if (!/\bclass __WasiExit\b|\b__WasiExit\s*=\s*class\b/.test(src)) {
    throw new Error(
      '[bundle-facet-workers/wasi-instance] class __WasiExit was renamed — __wasiRunStart '
      + 'identifies a guest exit by constructor.name, so every proc_exit would be reported as a crash',
    );
  }
  return src;
}

/**
 * Bundle the typed bash scheduler into a self-contained IIFE.
 *
 * IIFE and not a flat body, because this string is evaluated as a FUNCTION body
 * — `new Function('globalThis', src)` in tests, a loader-pool `preamble` in
 * production — so an `import`, an `export` or a top-level `await` would be a
 * syntax error at the point of evaluation. Wrapping also keeps ~70 scheduler
 * identifiers out of the facet module scope; the only things it publishes are
 * `globalThis.__bashBoot` and `globalThis.__bashFeed`.
 *
 * treeShaking is OFF for the same reason it is off for the WASI shim: every
 * declaration here is reachable only through those two globals, which
 * elimination cannot see, and a dropped one is a ReferenceError raised inside a
 * suspended guest where nothing can report it.
 */
async function bundleBashRunner() {
  const result = await build({
    entryPoints: [join(coreRoot, 'src', 'runtime', 'bash', 'preamble.ts')],
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    treeShaking: false,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/bash-runner] esbuild produced no output');
  }
  const src = withoutComments(result.outputFiles[0].text);
  for (const name of ['__bashBoot', '__bashFeed']) {
    if (!new RegExp(`^\\s*globalThis\\.${name}\\s*=`, 'm').test(src)) {
      throw new Error(
        `[bundle-facet-workers/bash-runner] the bundle no longer assigns globalThis.${name} — ` +
        'every bash dispatch would answer "preamble missing"',
      );
    }
  }
  if (/^\s*(?:import|export)\b/m.test(src)) {
    throw new Error(
      '[bundle-facet-workers/bash-runner] an import/export survived bundling — the string is ' +
      'evaluated as a function body and would be a syntax error there',
    );
  }
  // The exit path identifies a guest's proc_exit by `e instanceof Exit`, so the
  // class has to survive as a class. Bundling rewrites `class Exit {}` to
  // `var Exit = class {}`; both forms pass.
  if (!/\bclass Exit\b|\bExit\s*=\s*class\b/.test(src)) {
    throw new Error(
      '[bundle-facet-workers/bash-runner] class Exit was renamed — proc_exit is caught by ' +
      'instanceof, so every clean exit would propagate as a scheduler crash',
    );
  }
  return src;
}

/**
 * The `esbuild` command's runner: Go's own js/wasm glue from the installed
 * esbuild-wasm (the package whose esbuild.wasm is staged to ASSETS, so the glue
 * always matches the binary), wrapped so each run hands it its own global and
 * `fs`, followed by the typed runner as an IIFE that installs
 * globalThis.__esbuildCliRun. wasm_exec.js is spliced in verbatim, license
 * header included.
 */
async function bundleEsbuildCli() {
  const result = await build({
    entryPoints: [join(coreRoot, 'src', 'runtime', 'esbuild-cli', 'preamble.ts')],
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/esbuild-cli] esbuild produced no output');
  }
  const runner = withoutComments(result.outputFiles[0].text);
  if (!/^\s*globalThis\.__esbuildCliRun\s*=/m.test(runner)) {
    throw new Error(
      '[bundle-facet-workers/esbuild-cli] the bundle no longer assigns globalThis.__esbuildCliRun — ' +
      'every esbuild command would fail inside the esbuild facet',
    );
  }
  if (/^\s*(?:import|export)\b/m.test(runner)) {
    throw new Error('[bundle-facet-workers/esbuild-cli] an import/export survived bundling');
  }
  const glue = readFileSync(join(resolvePackageDir('esbuild-wasm', { start: root }), 'wasm_exec.js'), 'utf8');
  if (!/globalThis\.Go\s*=\s*class\b/.test(glue)) {
    throw new Error('[bundle-facet-workers/esbuild-cli] esbuild-wasm/wasm_exec.js no longer defines globalThis.Go');
  }
  return `const __esbuildGoRuntime = function (globalThis, fs) {\n${glue}\nreturn globalThis.Go;\n};\n${runner}`;
}

/**
 * Stage a runtime script under public/_assets/runtime/<prefix>-<build id>.js,
 * named by a prefix of its own digest so no cache layer can serve another
 * build's bytes under its name, and pin it in src/<generated>: exports
 * <constant>_ASSET_PATH, <constant>_BUILD_ID (the content-hash prefix) and
 * <constant>_SHA256 (the digest every fetch is verified against).
 */
function stageRuntimeSource(src, { prefix, generated, constant, description }) {
  const sha256 = createHash('sha256').update(src, 'utf8').digest('hex');
  const buildId = sha256.slice(0, 16);
  const assetDir = join(root, 'public', '_assets', 'runtime');
  const assetName = `${prefix}-${buildId}.js`;
  mkdirSync(assetDir, { recursive: true });
  for (const entry of readdirSync(assetDir)) {
    if (entry.startsWith(`${prefix}-`) && entry !== assetName) unlinkSync(join(assetDir, entry));
  }
  writeFileSync(join(assetDir, assetName), src, 'utf8');
  const assetPath = `/_assets/runtime/${assetName}`;
  const generatedPath = join(root, 'src', generated);
  writeFileSync(generatedPath, [
    '/**',
    ` * ${generated} — AUTO-GENERATED by`,
    ' * scripts/bundle-facet-workers.mjs. DO NOT EDIT.',
    ' *',
    ...description.map((line) => ` * ${line}`),
    ` * ${constant}_BUILD_ID is a content-hash prefix, ${constant}_SHA256 the`,
    ' * digest every fetch is verified against.',
    ' *',
    ` * Size: ${(src.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const ${constant}_ASSET_PATH: string = ${JSON.stringify(assetPath)};`,
    `export const ${constant}_BUILD_ID: string = ${JSON.stringify(buildId)};`,
    `export const ${constant}_SHA256: string = ${JSON.stringify(sha256)};`,
    '',
  ].join('\n'));
  return { assetPath, generatedPath };
}

/** The esbuild CLI runner, staged (stageRuntimeSource). */
function stageEsbuildCli(src) {
  return stageRuntimeSource(src, {
    prefix: 'esbuild-cli',
    generated: 'esbuild-cli-artifact.generated.ts',
    constant: 'ESBUILD_CLI',
    description: [
      'Pins the staged runner of the `esbuild` command: esbuild-wasm/wasm_exec.js',
      '(Go js/wasm glue, as __esbuildGoRuntime) followed by @nimbus-sh/core',
      'src/runtime/esbuild-cli/preamble.ts as an IIFE. Only the session\'s esbuild',
      'facet evaluates it, so src/runtime/esbuild-wasm-bytes.ts fetches it from',
      'ASSETS when that facet is built, instead of the Worker bundle carrying it.',
    ],
  });
}

/**
 * The transform facet's runtime (core src/runtime/oxc-facet/preamble.ts) as
 * an IIFE: the Oxc wasm's driver, the dynamic-import rewrite and the
 * top-level-await lowering, installed as globals the facet's class reads.
 */
async function bundleOxcFacet() {
  const result = await build({
    entryPoints: [join(coreRoot, 'src', 'runtime', 'oxc-facet', 'preamble.ts')],
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/oxc-facet] esbuild produced no output');
  }
  const runtime = withoutComments(result.outputFiles[0].text);
  for (const global of ['__nimbusCreateOxcTransform', '__nimbusRewriteDynamicImports', '__nimbusLowerAsyncModule']) {
    if (!runtime.includes(global)) {
      throw new Error(`[bundle-facet-workers/oxc-facet] the bundle no longer installs globalThis.${global}`);
    }
  }
  if (/^\s*(?:import|export)\b/m.test(runtime)) {
    throw new Error('[bundle-facet-workers/oxc-facet] an import/export survived bundling');
  }
  return runtime;
}

/**
 * The build facet's runtime (scripts/rolldown-facet/entry.mjs) as an ES
 * module: rolldown's JavaScript API, pinned to the staged binding's version,
 * and core's esbuild-contract adapter (runtime/rolldown-build.ts). The Node
 * modules rolldown imports and a facet has no use for are shims.mjs; node:path
 * is workerd's. rolldown finds its binding at globalThis.__nimbusRolldownBinding,
 * which the facet installs before it imports this module.
 */
async function bundleRolldownFacet() {
  const shims = join(root, 'scripts', 'rolldown-facet', 'shims.mjs');
  const rolldownPkg = JSON.parse(readFileSync(join(root, 'node_modules', 'rolldown', 'package.json'), 'utf8'));
  const artifacts = readFileSync(join(root, 'src', 'napi-wasm-artifacts.generated.ts'), 'utf8');
  const stagedVersion = /"name": "rolldown",\s*"version": "([^"]+)"/.exec(artifacts)?.[1];
  if (rolldownPkg.version !== stagedVersion) {
    throw new Error(`[bundle-facet-workers/rolldown-facet] rolldown ${rolldownPkg.version} is installed; the staged binding is ${stagedVersion}`);
  }
  const result = await build({
    entryPoints: [join(root, 'scripts', 'rolldown-facet', 'entry.mjs')],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
    plugins: [{
      name: 'rolldown-facet-shims',
      setup(b) {
        b.onResolve({ filter: /^node:path$/ }, () => ({ path: 'node:path', external: true }));
        b.onResolve({ filter: /^node:(worker_threads|tty|os|util|module|fs|fs\/promises|process|url|readline|child_process)$/ }, () => ({ path: shims }));
        // rolldown's binding loader (createRequire, native shards, WASI fallbacks): the facet's binding instead.
        b.onResolve({ filter: /\/binding-[A-Za-z0-9_-]+\.mjs$/ }, (args) => ({ path: args.path, namespace: 'rolldown-binding' }));
        b.onLoad({ filter: /.*/, namespace: 'rolldown-binding' }, () => ({
          contents: [
            'export const t = () => {',
            '  const binding = globalThis.__nimbusRolldownBinding;',
            '  if (!binding) throw new Error("Nimbus: the build facet imported rolldown before installing its binding");',
            '  return binding;',
            '};',
            'export const n = (mod) => mod;',
          ].join('\n'),
          loader: 'js',
        }));
      },
    }],
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/rolldown-facet] esbuild produced no output');
  }
  const runtime = result.outputFiles[0].text;
  const imports = [...runtime.matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  if (imports.some((specifier) => specifier !== 'node:path')) {
    throw new Error(`[bundle-facet-workers/rolldown-facet] the runtime imports ${imports.join(', ')}; only node:path is allowed`);
  }
  for (const name of ['build', 'prebundle']) {
    if (!new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(runtime)) throw new Error(`[bundle-facet-workers/rolldown-facet] the runtime no longer exports ${name}`);
  }
  return runtime;
}

/** The build facet's runtime, staged (stageRuntimeSource). */
function stageRolldownFacet(src) {
  return stageRuntimeSource(src, {
    prefix: 'rolldown-facet',
    generated: 'rolldown-facet-artifact.generated.ts',
    constant: 'ROLLDOWN_FACET',
    description: [
      'Pins the staged runtime of the build facet: scripts/rolldown-facet/entry.mjs',
      'as an ES module (rolldown\'s JavaScript API over the staged threadless',
      'binding, and @nimbus-sh/core runtime/rolldown-build.ts). Only the build',
      'facet imports it, so facets/build-facet.ts fetches it from ASSETS when',
      'that facet is built.',
    ],
  });
}

/** The transform facet's runtime, staged (stageRuntimeSource). */
function stageOxcFacet(src) {
  return stageRuntimeSource(src, {
    prefix: 'oxc-facet',
    generated: 'oxc-facet-artifact.generated.ts',
    constant: 'OXC_FACET',
    description: [
      'Pins the staged runtime of the transform facet: @nimbus-sh/core',
      'src/runtime/oxc-facet/preamble.ts as an IIFE (the Oxc wasm\'s driver, the',
      'dynamic-import rewrite and the top-level-await lowering). Only the',
      'transform facet evaluates it, so src/runtime/oxc-wasm-bytes.ts fetches it',
      'from ASSETS when that facet is built.',
    ],
  });
}

async function main() {
  // 1. Tar-parser preamble (existing W2.5/W4 hot-path helpers).
  const tarStripped = await bundleAsPreamble(
    join(coreRoot, 'src', '_shared', 'tarball-stream.ts'),
    'tar-stream',
  );

  // 2. W7 frame encoder preamble. The npm-install-batch-facet calls
  //    encodeWriteBatchStream() to wrap its writeBatch payload as a
  //    type:'bytes' ReadableStream, then passes the stream to
  //    env.SUPERVISOR.writeBatchStream(). Without this preamble the
  //    facet has no access to the encoder symbol (cloudflare-parallel
  //    serialises via fn.toString() — no runtime imports).
  //
  const w7Stripped = await bundleAsPreamble(
    join(platformRoot, 'src', 'w7-frame.ts'),
    'w7-frame',
  );

  // 3. Node's ESM resolver, which the node shims embed as source (their
  //    process's import() loader). One compile of it, here, so the shims'
  //    copy is the same text whatever toolchain later evaluates the shims.
  const esmResolver = await bundleAsPreamble(
    join(coreRoot, 'src', '_shared', 'esm-resolver.ts'),
    'esm-resolver',
  );
  if (!/^function createEsmResolver\(/m.test(esmResolver)) {
    throw new Error('[bundle-facet-workers/esm-resolver] the bundle no longer declares function createEsmResolver');
  }

  // 4. node:http2, which the node shims embed as source, as the substrate's
  //    node-compat module map imports it: one module, both runtimes.
  const http2Module = await bundleAsPreamble(
    join(coreRoot, 'src', '_shared', 'http2-module.ts'),
    'http2-module',
  );
  if (!/^function createHttp2Module\(/m.test(http2Module)) {
    throw new Error('[bundle-facet-workers/http2-module] the bundle no longer declares function createHttp2Module');
  }

  const waveWriter = await bundleWaveWriter();

  const tarEncoded = JSON.stringify(tarStripped);
  const w7Encoded = JSON.stringify(w7Stripped);
  const outPath = join(root, 'src', 'loaders', 'generated-workers.ts');

  const tsWrapper = [
    '/**',
    ' * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/_shared/tarball-stream.ts (streaming tar primitives)',
    ' *   - @nimbus-sh/platform src/w7-frame.ts (W7 streaming bulk-write encoder)',
    ' *   - @nimbus-sh/platform src/wave-writer.ts (the W7 wave writer, as an IIFE)',
    ' *   - @nimbus-sh/core src/_shared/esm-resolver.ts (Node\'s ESM resolver, for the node shims)',
    ' *   - @nimbus-sh/core src/_shared/http2-module.ts (node:http2, for the node shims)',
    ' *',
    ' * Consumed by fabric/isolate-pool.ts callers via the `preamble`',
    ' * option. The preamble is injected at the top of every generated',
    ' * worker module so user functions can reference the exported',
    ' * helpers by name.',
    ' *',
    ' * Tar-stream symbols: parseTarHeader, streamTarEntries,',
    ' *   streamPackageEntries, readableStreamToAsyncIterable, MAX_FILE_BYTES.',
    ' * W7-frame symbols:   encodeWriteBatchStream, decodeWriteBatchStream,',
    ' *   W7_MAGIC, W7_MAX_RECORD_BYTES.',
    ' *',
    ` * Tar size: ${(tarStripped.length / 1024).toFixed(2)} KiB`,
    ` * W7 size:  ${(w7Stripped.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const TAR_STREAM_PREAMBLE: string = ${tarEncoded};`,
    '',
    `export const W7_FRAME_PREAMBLE: string = ${w7Encoded};`,
    '',
    '/** Binds `__nimbusWaveWriter` (createWaveWriter, WaveFailure, …) in the module that splices it. */',
    `export const WAVE_WRITER_PREAMBLE: string = ${JSON.stringify(waveWriter)};`,
    '',
    '/** Declares `function createEsmResolver(host)`; the node shims call it. */',
    `export const ESM_RESOLVER_PREAMBLE: string = ${JSON.stringify(esmResolver)};`,
    '',
    '/** Declares `function createHttp2Module(host)`; the node shims call it. */',
    `export const HTTP2_MODULE_PREAMBLE: string = ${JSON.stringify(http2Module)};`,
    '',
  ].join('\n');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, tsWrapper);

  const kernelSrc = await bundleVirtualSocketKernel();
  const kernelOutPath = join(coreRoot, 'src', 'runtime', 'virtual-socket-kernel.generated.ts');
  const kernelWrapper = [
    '/**',
    ' * virtual-socket-kernel.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/runtime/virtual-socket-kernel.ts',
    ' *',
    ' * Self-contained IIFE that installs globalThis.__nimbusVirtualSockets.',
    ' * Consumed by python-runner.ts and ruby-runner.ts: spliced into the',
    ' * socket process worker module source passed to NimbusIsolatePool.',
    ' *',
    ` * Size: ${(kernelSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const VIRTUAL_SOCKET_KERNEL_SRC: string = ${JSON.stringify(kernelSrc)};`,
    '',
  ].join('\n');
  writeFileSync(kernelOutPath, kernelWrapper);

  const answeringSrc = await bundleAnsweringSupervisor();
  const answeringOutPath = join(coreRoot, 'src', 'runtime', 'supervisor-answering.generated.ts');
  writeFileSync(answeringOutPath, [
    '/**',
    ' * supervisor-answering.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/runtime/vfs-supervisor.ts (answeringSupervisor)',
    ' *',
    ' * Self-contained IIFE that installs globalThis.__nimbusAnsweringSupervisor.',
    ' * Spliced into the node facet bodies (worker facets/manager.ts) and the',
    ' * opencode runner, which wrap their SUPERVISOR binding with it.',
    ' *',
    ` * Size: ${(answeringSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const SUPERVISOR_ANSWERING_SRC: string = ${JSON.stringify(answeringSrc)};`,
    '',
  ].join('\n'));

  console.log(
    `[bundle-facet-workers] wrote ${outPath} ` +
    `(tar=${(tarStripped.length / 1024).toFixed(2)} KiB, ` +
    `w7=${(w7Stripped.length / 1024).toFixed(2)} KiB)`,
  );
  const wasiSrc = await bundleWasiInstance();
  const wasiOutPath = join(coreRoot, 'src', 'runtime', 'wasi-instance.generated.ts');
  writeFileSync(wasiOutPath, [
    '/**',
    ' * wasi-instance.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/runtime/wasi/preamble.ts',
    ' *',
    ' * The WASI snapshot_preview1 shim as a flat ESM body, for splicing into a',
    ' * facet module source. wasi-instance.ts appends the wasi-threads scheduler',
    ' * and re-exports the result as WASI_INSTANCE_PREAMBLE_SRC.',
    ' *',
    ` * Size: ${(wasiSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const WASI_INSTANCE_BODY_SRC: string = ${JSON.stringify(wasiSrc)};`,
    '',
  ].join('\n'));

  const gitPackSrc = await bundleGitPack();
  const gitPackOutPath = join(root, 'src', 'git', 'pack', 'facet.generated.ts');
  writeFileSync(gitPackOutPath, [
    '/**',
    ' * facet.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/git/pack/facet.ts',
    ' *',
    ' * An IIFE binding `__nimbusGitPack` in the module that splices it, the git',
    ' * network facet, after GIT_PACK_NODE_IMPORTS.',
    ' *',
    ` * Size: ${(gitPackSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    "export const GIT_PACK_NODE_IMPORTS: string = \"import * as __nimbusNodeCrypto from 'node:crypto';\\nimport * as __nimbusNodeZlib from 'node:zlib';\";",
    '',
    `export const GIT_PACK_SRC: string = ${JSON.stringify(gitPackSrc)};`,
    '',
  ].join('\n'));

  const bashSrc = await bundleBashRunner();
  const bashOutPath = join(coreRoot, 'src', 'runtime', 'bash-runner.generated.ts');
  writeFileSync(bashOutPath, [
    '/**',
    ' * bash-runner.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/runtime/bash/preamble.ts',
    ' *',
    ' * The facet-side bash scheduler as a self-contained IIFE that installs',
    ' * globalThis.__bashBoot / globalThis.__bashFeed. bash-runner.ts re-exports it',
    ' * as BASH_RUNNER_PREAMBLE and passes it as the facet preamble.',
    ' *',
    ` * Size: ${(bashSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const BASH_RUNNER_BODY_SRC: string = ${JSON.stringify(bashSrc)};`,
    '',
  ].join('\n'));

  const esbuildCliSrc = await bundleEsbuildCli();
  const esbuildCli = stageEsbuildCli(esbuildCliSrc);
  const oxcFacetSrc = await bundleOxcFacet();
  const oxcFacet = stageOxcFacet(oxcFacetSrc);
  const rolldownFacetSrc = await bundleRolldownFacet();
  const rolldownFacet = stageRolldownFacet(rolldownFacetSrc);

  console.log(
    `[bundle-facet-workers] wrote ${kernelOutPath} ` +
    `(kernel=${(kernelSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] wrote ${wasiOutPath} ` +
    `(wasi=${(wasiSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] wrote ${bashOutPath} ` +
    `(bash=${(bashSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] staged ${esbuildCli.assetPath} and wrote ${esbuildCli.generatedPath} ` +
    `(esbuild-cli=${(esbuildCliSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] staged ${oxcFacet.assetPath} and wrote ${oxcFacet.generatedPath} ` +
    `(oxc-facet=${(oxcFacetSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] staged ${rolldownFacet.assetPath} and wrote ${rolldownFacet.generatedPath} ` +
    `(rolldown-facet=${(rolldownFacetSrc.length / 1024).toFixed(2)} KiB)`,
  );
}

// The bundle functions are exported so the parity test can re-derive the
// generated files from source and compare, rather than restating the esbuild
// settings — a second copy of those settings is exactly the drift such a test
// exists to catch. main() therefore runs only when this file is the entry point.
export { bundleWasiInstance, bundleBashRunner, bundleEsbuildCli, bundleOxcFacet, bundleAnsweringSupervisor, bundleWaveWriter };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error('[bundle-facet-workers] FAILED:', e?.message || e);
    process.exitCode = 1;
  });
}
