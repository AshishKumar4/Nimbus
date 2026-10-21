#!/usr/bin/env bun
/**
 * Entry-script module format: which files the runtime handler stages as ESM.
 *
 * An ES module reaches the runner as its source and esModule:true; the launch
 * compiles TypeScript/JSX and stages native modules. The handler answers
 * Node's own question ("is this file a module?") from the extension, the
 * nearest package.json `type`, and syntax where the package has no type:
 *
 *   .mjs → module, .cjs → commonjs, .js and NO EXTENSION → package type.
 *
 * The no-extension arm is the one that matters in practice: it is the shape
 * of nearly every npm `bin` script, and the path the `.bin/<cli>` dispatcher
 * hands the handler. Missing it made a `type: module` package's bin die with
 * "Cannot use import statement outside a module" before running a line —
 * typescript@7's `bin/tsc` (`import "../lib/tsc.js";`) among them.
 */

import assert from 'node:assert/strict';
import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';

function makeHandler(files, { nodeCommandLine = false } = {}) {
  const transforms = [];
  let ranWith = null;
  let ranOpts = null;
  const fs = {
    exists: (p) => Object.hasOwn(files, p),
    // Every fixture entry is a file; the bound VFS distinguishes the two so
    // script resolution can send a directory on to its index.
    isFile: (p) => Object.hasOwn(files, p),
    stat: (p) => (Object.hasOwn(files, p) ? { type: 'file', size: files[p].length } : null),
    readFileString: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
  };
  const handler = buildRuntimeHandler(
    {
      name: 'node',
      version: 'v22.0.0',
      helpText: 'help',
      supportsBinSpawn: true,
      ...(nodeCommandLine ? { nodeCommandLine: true } : {}),
      async run(code, opts) {
        ranWith = code;
        ranOpts = opts;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    {
      vfs: { as: () => fs },
      getEsbuild: () => ({
        async transform(code, opts) {
          transforms.push({ code, opts });
          assert.fail('the runtime handler delegates module compilation to the launch');
        },
        // A type strip, as the transform facet's amaro answers it: the annotations blanked, and Node's format.
        async transformMany(requests) {
          return requests.map(({ code, options }) => {
            transforms.push({ code, opts: options });
            const stripped = code.replace(/: number/g, (types) => ' '.repeat(types.length));
            return { code: stripped, map: '', warnings: [], ...(/\b(import|export)\b/.test(code) ? { esModule: 'node' } : {}) };
          });
        },
      }),
      registry: { resolve: () => undefined },
    },
  );
  return { handler, fs, transforms, ran: () => ranWith, ranOpts: () => ranOpts };
}

async function runScript(files, scriptPath, options) {
  const built = makeHandler(files, options);
  const stderr = [];
  const exitCode = await built.handler({
    vfs: built.fs,
    args: [scriptPath],
    cwd: '/home/user',
    env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdout: { write: () => {} },
    stderr: { write: (v) => stderr.push(v) },
  });
  return { exitCode, stderr: stderr.join(''), code: built.ran(), opts: built.ranOpts(), transforms: built.transforms };
}

const ESM_SOURCE = '#!/usr/bin/env node\nimport "../lib/tsc.js";\n';
const CJS_SOURCE = "#!/usr/bin/env node\nrequire('../lib/tsc.js')\n";

const MODULE_PKG = JSON.stringify({ name: 'typescript', type: 'module', bin: { tsc: './bin/tsc' } });
const CJS_PKG = JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } });

// ── extensionless bin in a type:module package → native ESM ──
{
  const r = await runScript({
    'home/user/node_modules/typescript/package.json': MODULE_PKG,
    'home/user/node_modules/typescript/bin/tsc': ESM_SOURCE,
  }, '/home/user/node_modules/typescript/bin/tsc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.code, ESM_SOURCE.slice(ESM_SOURCE.indexOf('\n')), 'the runner gets the original source after the handler\'s shebang strip, its line kept empty');
  assert.equal(r.transforms.length, 0, 'native ESM is staged by the launch, not transformed by the handler');
  assert.equal(r.opts.esModule, true);
  assert.equal(r.opts.moduleScope, 'node');
}

// ── extensionless bin in a package with no `type` → CommonJS, untouched ──
{
  const r = await runScript({
    'home/user/node_modules/typescript/package.json': CJS_PKG,
    'home/user/node_modules/typescript/bin/tsc': CJS_SOURCE,
  }, '/home/user/node_modules/typescript/bin/tsc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, 'a CommonJS bin must not be rewritten');
  assert.equal(r.opts.esModule, undefined);
  assert.equal(r.code, CJS_SOURCE.slice(CJS_SOURCE.indexOf('\n')), 'the shebang strip keeps its line, empty');
}

// ── the nearest package.json wins, not an ancestor ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/node_modules/dep/package.json': JSON.stringify({ name: 'dep' }),
    'home/user/node_modules/dep/bin/dep': CJS_SOURCE,
  }, '/home/user/node_modules/dep/bin/dep');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, 'an ancestor type:module must not reach into a CommonJS package');
  assert.equal(r.opts.esModule, undefined);
}

// ── .cjs stays CommonJS even inside a type:module package ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/main.cjs': "require('./x')\n",
  }, '/home/user/main.cjs');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, '.cjs is CommonJS by definition');
  assert.equal(r.opts.esModule, undefined);
}

// ── .mjs is ESM with no package.json in sight ──
{
  const r = await runScript({ 'home/user/main.mjs': 'import "./x.js";\n' }, '/home/user/main.mjs');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0);
  assert.equal(r.code, 'import "./x.js";\n');
  assert.equal(r.opts.esModule, true);
}

// ── .js follows the package type (pre-existing behavior, kept) ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/main.js': 'import "./x.js";\n',
  }, '/home/user/main.js');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0);
  assert.equal(r.code, 'import "./x.js";\n');
  assert.equal(r.opts.esModule, true);
}

// ── a dot in a DIRECTORY name is not an extension ──
//
// `resolvedPath.split('.').pop()` answered `pkg/bin/cli` here, which picked
// the wrong loader and read as "has an extension" for format purposes.
{
  const r = await runScript({
    'home/user/node_modules/my.pkg/package.json': JSON.stringify({ name: 'my.pkg', type: 'module' }),
    'home/user/node_modules/my.pkg/bin/cli': 'import "./x.js";\n',
  }, '/home/user/node_modules/my.pkg/bin/cli');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0);
  assert.equal(r.code, 'import "./x.js";\n');
  assert.equal(r.opts.esModule, true, 'a dotted directory must not hide an extensionless ES entry');
}

// ── an extensionless CommonJS body inside a type:module project survives ──
//
// Nimbus writes `node_modules/.bin/<name>` as a real file holding a CJS
// require of the bin target (npm writes a symlink, which Node realpaths into
// the target package). A file under node_modules with no package.json of
// its own belongs to no package: Node's scope walk stops at node_modules,
// so the `type: module` project above it does not reach it, and it runs as
// the CommonJS it is (real node 22.23.4: `typeof require` is 'function').
{
  const shim = 'require("/home/user/node_modules/genpkg/bin/genpkg");\n';
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/node_modules/.bin/genpkg': `#!/usr/bin/env node\n${shim}`,
  }, '/home/user/node_modules/.bin/genpkg');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, 'the shim is no package\'s: CommonJS, untransformed');
  assert.equal(r.opts.esModule, undefined);
  assert.equal(r.code, `\n${shim}`, 'the shebang strip keeps its line, empty');
}

// ── a dotfile entry has no extension; its package type decides ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/.hookrc': 'import "./x.js";\n',
  }, '/home/user/.hookrc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0);
  assert.equal(r.code, 'import "./x.js";\n');
  assert.equal(r.opts.esModule, true);
}

// ── TypeScript entries reach the launch as written ──
{
  const r = await runScript({ 'home/user/main.ts': 'export const x: number = 1;\n' }, '/home/user/main.ts');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0);
  assert.equal(r.code, 'export const x: number = 1;\n');
  assert.equal(r.opts.esModule, true, 'the launch compiles and stages TypeScript entries');
}

// ── .mts and .cts are TypeScript as well: ESM and CommonJS TypeScript ──
//
// The same loader table covers .mts/.cts/.tsx. The handler marks every
// TypeScript or JSX entry for the launch to compile and decide its emit's
// module format, even a CommonJS .cts inside a type:module package.
for (const [entry, source] of [
  ['home/user/main.mts', 'import { x } from "./x.mjs";\nconst n: number = x;\n'],
  ['home/user/main.cts', 'const x = require("./x.cjs");\nconst n: number = x;\n'],
  ['home/user/main.tsx', 'export const view = <div />;\n'],
  ['home/user/main.jsx', 'export const view = <div />;\n'],
]) {
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    [entry]: source,
  }, `/${entry}`);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, `${entry} is compiled by the launch`);
  assert.equal(r.code, source, `${entry} reaches the runner as written`);
  assert.equal(r.opts.esModule, true, `${entry} is marked for compilation and staging`);
}

// ── Under node, TypeScript is Node's: stripped, then run as JavaScript of Node's format ──
//
// The strip is a request of its own; an ES module's stripped code reaches
// the runner natively and CommonJS runs as stripped. Refusals execute in
// typescript-matches-node-workerd.mjs's direct-entry differential.
{
  const node = { nodeCommandLine: true };
  const esm = await runScript({ 'home/user/main.mts': 'export const x: number = 1;\n' }, '/home/user/main.mts', node);
  assert.equal(esm.exitCode, 0, esm.stderr);
  assert.deepEqual(esm.transforms.map((t) => t.opts.stripOnly ? 'strip' : t.opts.esModule), ['strip'], 'only the Node type strip runs in the handler');
  assert.equal(esm.code, `export const x${' '.repeat(': number'.length)} = 1;\n`, 'the runner gets the stripped native module');
  assert.equal(esm.opts.esModule, true);
  const cjs = await runScript({ 'home/user/main.cts': 'const x: number = 1;\nmodule.exports = x;\n' }, '/home/user/main.cts', node);
  assert.equal(cjs.exitCode, 0, cjs.stderr);
  assert.equal(cjs.transforms.length, 1, 'only the strip');
  assert.equal(cjs.code, `const x${' '.repeat(': number'.length)} = 1;\nmodule.exports = x;\n`, 'CommonJS runs as stripped');
  assert.equal(cjs.opts.esModule, undefined);
  const vendored = await runScript({ 'home/user/node_modules/x/main.ts': 'const x: number = 1;\n' }, '/home/user/node_modules/x/main.ts', node);
  assert.equal(vendored.transforms.length, 0, 'TypeScript under node_modules is refused before requesting a transform');
}

// ── ES eval and stdin programs reach the runner exactly as written ──
for (const input of ['eval', 'stdin']) {
  const source = 'export const answer = await Promise.resolve(42);\n';
  const built = makeHandler({}, { nodeCommandLine: true });
  const stderr = [];
  const exitCode = await built.handler({
    vfs: built.fs,
    args: input === 'eval' ? ['--input-type=module', '-e', source] : ['--input-type=module', '-'],
    cwd: '/home/user', env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdin: { async readAll() { return source; }, async read() { return null; } },
    stdout: { write: () => {} }, stderr: { write: (v) => stderr.push(v) },
  });
  assert.equal(exitCode, 0, stderr.join(''));
  assert.equal(built.ran(), source, `${input} ES input is passed as written`);
  assert.equal(built.ranOpts().esModule, true);
  assert.equal(built.transforms.length, 0, `${input} ES input is staged by the launch`);
}

// ── `-` runs the program on stdin, with its arguments after argv[1] ──
//
// Pi's installer validates its managed install with
// `node - "$package_json" "$package_lock" <<'NODE' ... NODE`. The flag span
// used to swallow the bare `-` as a flag and run the next argument, a JSON
// file, as the script: "SyntaxError: Unexpected token ':'".
{
  const built = makeHandler({ 'home/user/pkg.json': '{"version":"1"}' });
  const stderr = [];
  const exitCode = await built.handler({
    vfs: built.fs,
    args: ['-', '/home/user/pkg.json', 'x'],
    cwd: '/home/user',
    env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdin: { async readAll() { return 'process.exit(process.argv.length)\n'; }, async read() { return null; } },
    stdout: { write: () => {} },
    stderr: { write: (v) => stderr.push(v) },
  });
  assert.equal(exitCode, 0, stderr.join(''));
  assert.equal(built.ran(), 'process.exit(process.argv.length)\n', 'the program is what stdin held');
  assert.deepEqual(built.ranOpts().argv, ['-', '/home/user/pkg.json', 'x'], 'argv[1] is `-`, the arguments follow it');
  assert.equal(built.ranOpts().filename, '[stdin]');
  assert.equal(built.transforms.length, 0, 'a stdin program is CommonJS as written');
}

console.log('runtime-entry-module-format: ok');
