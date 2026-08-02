#!/usr/bin/env bun
/**
 * Entry-script module format: which files the runtime handler parses as ESM.
 *
 * workerd forbids codegen from strings at request time, so a facet can only
 * run CommonJS — an ESM entry has to be rewritten before it is shipped. The
 * handler therefore has to answer Node's own question ("is this file a
 * module?") the same way Node does, and Node answers it from the extension
 * plus the nearest package.json `type`:
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
import { buildRuntimeHandler } from '../../packages/worker/src/runtime/runtime-registry.ts';

const TRANSFORM_MARKER = '/* nimbus-test: transformed */';

function makeHandler(files) {
  const transforms = [];
  let ranWith = null;
  const fs = {
    exists: (p) => Object.hasOwn(files, p),
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
      async run(_facetMgr, code) {
        ranWith = code;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    {
      vfs: { as: () => fs },
      facetMgr: {},
      getEsbuild: () => ({
        async transform(code, opts) {
          transforms.push({ code, opts });
          return { code: TRANSFORM_MARKER + '\n' + code };
        },
      }),
      registry: { resolve: () => undefined },
    },
  );
  return { handler, transforms, ran: () => ranWith };
}

async function runScript(files, scriptPath) {
  const built = makeHandler(files);
  const stderr = [];
  const exitCode = await built.handler({
    args: [scriptPath],
    cwd: '/home/user',
    env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdout: { write: () => {} },
    stderr: { write: (v) => stderr.push(v) },
  });
  return { exitCode, stderr: stderr.join(''), code: built.ran(), transforms: built.transforms };
}

const ESM_SOURCE = '#!/usr/bin/env node\nimport "../lib/tsc.js";\n';
const CJS_SOURCE = "#!/usr/bin/env node\nrequire('../lib/tsc.js')\n";

const MODULE_PKG = JSON.stringify({ name: 'typescript', type: 'module', bin: { tsc: './bin/tsc' } });
const CJS_PKG = JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } });

// ── extensionless bin in a type:module package → ESM, must be rewritten ──
{
  const r = await runScript({
    'home/user/node_modules/typescript/package.json': MODULE_PKG,
    'home/user/node_modules/typescript/bin/tsc': ESM_SOURCE,
  }, '/home/user/node_modules/typescript/bin/tsc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.code.startsWith(TRANSFORM_MARKER), 'extensionless ESM bin must reach the runner as CJS');
  assert.equal(r.transforms.length, 1);
  assert.equal(r.transforms[0].opts.loader, 'js');
  assert.equal(r.transforms[0].opts.format, 'cjs');
  // The shebang is stripped before the transform, never handed to esbuild.
  assert.doesNotMatch(r.transforms[0].code, /^#!/);
}

// ── extensionless bin in a package with no `type` → CommonJS, untouched ──
{
  const r = await runScript({
    'home/user/node_modules/typescript/package.json': CJS_PKG,
    'home/user/node_modules/typescript/bin/tsc': CJS_SOURCE,
  }, '/home/user/node_modules/typescript/bin/tsc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, 'a CommonJS bin must not be rewritten');
  assert.match(r.code, /require\('\.\.\/lib\/tsc\.js'\)/);
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
}

// ── .cjs stays CommonJS even inside a type:module package ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/main.cjs': "require('./x')\n",
  }, '/home/user/main.cjs');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 0, '.cjs is CommonJS by definition');
}

// ── .mjs is ESM with no package.json in sight ──
{
  const r = await runScript({ 'home/user/main.mjs': 'import "./x.js";\n' }, '/home/user/main.mjs');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 1);
  assert.ok(r.code.startsWith(TRANSFORM_MARKER));
}

// ── .js follows the package type (pre-existing behavior, kept) ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/main.js': 'import "./x.js";\n',
  }, '/home/user/main.js');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 1);
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
  assert.equal(r.transforms.length, 1, 'a dotted directory must not hide an extensionless entry');
  assert.equal(r.transforms[0].opts.loader, 'js');
}

// ── a dotfile entry has no extension; its package type decides ──
{
  const r = await runScript({
    'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'home/user/.hookrc': 'import "./x.js";\n',
  }, '/home/user/.hookrc');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms.length, 1);
  assert.equal(r.transforms[0].opts.loader, 'js');
}

// ── TypeScript entries keep their own loader ──
{
  const r = await runScript({ 'home/user/main.ts': 'export const x: number = 1;\n' }, '/home/user/main.ts');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.transforms[0].opts.loader, 'ts');
}

console.log('runtime-entry-module-format: ok');
