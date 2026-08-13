#!/usr/bin/env bun
// A runtime's subcommand verb must not swallow a path.
//
// `bun run <file>` runs a FILE in real bun; only a bare name means a
// package.json script. Nimbus dispatched `spec.subcommands[args[0]]` and never
// looked back, so `bun run packages/cli/bin/cli.ts --help` — the second-to-last
// step of a real `curl … | bash` installer — died on
// `script "packages/cli/bin/cli.ts" not found in package.json` instead of
// executing the file.
//
// The fix is a seam, not a second execution path: a verb handler receives a
// continuation back into the standard flow, so the file case reaches the very
// same resolution → transform → facet dispatch that `bun <file>` takes.
//
// What has to hold: the resolver agrees with real bun (measured against bun
// 1.3.1, not recalled), a directory resolves to its index rather than being
// read as source, and a verb that delegates actually lands in the runner with
// the file's code and the user's argv intact.

import assert from 'node:assert/strict';
import {
  buildRuntimeHandler,
  resolveRuntimeScriptPath,
} from '../../packages/core/src/runtime/runtime-registry.ts';

// ── a VFS standing in for the session's ─────────────────────────────────────

function makeFs(files) {
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    isFile: (p) => Object.hasOwn(files, p),
    exists: (p) => Object.hasOwn(files, p) || dirs.has(p),
    readFileString: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

const CWD = '/home/user/app';
const fs = makeFs({
  'home/user/app/cli.ts': 'console.log("CLI_TS");',
  'home/user/app/plain.js': 'console.log("PLAIN_JS");',
  'home/user/app/tools/index.js': 'console.log("TOOLS_INDEX");',
  'home/user/app/package.json': '{"main":"plain.js","module":"cli.ts"}',
  'home/user/app/nested/deep.ts': 'console.log("DEEP");',
});

// ── the resolver, against behaviour measured from real bun ──────────────────

const resolve = (target, opts) => resolveRuntimeScriptPath(fs, CWD, target, opts);

assert.equal(resolve('cli.ts'), 'home/user/app/cli.ts', 'a bare filename resolves verbatim');
assert.equal(resolve('./cli.ts'), 'home/user/app/cli.ts', './ resolves against cwd');
assert.equal(
  resolve('nested/deep.ts'),
  'home/user/app/nested/deep.ts',
  'a relative subpath resolves against cwd',
);
assert.equal(
  resolve('/home/user/app/cli.ts'),
  'home/user/app/cli.ts',
  'an absolute path resolves to the same canonical key as a relative one',
);
assert.equal(
  resolve('../app/cli.ts'),
  'home/user/app/cli.ts',
  '.. is collapsed rather than handed to the VFS literally',
);

// Extension probing: `bun run plain` finds plain.js.
assert.equal(resolve('plain'), 'home/user/app/plain.js', 'a target without an extension is probed');

// A directory is never source. Real bun runs tools/index.js for `bun run ./tools`;
// resolving the directory to itself made readFileString throw and reported the
// file as missing.
assert.equal(
  resolve('tools'),
  'home/user/app/tools/index.js',
  'a directory resolves to its index, not to itself',
);
assert.equal(resolve('./tools'), 'home/user/app/tools/index.js', 'likewise path-shaped');

// `.` is the package entry. bun prefers `module`, node takes `main`.
assert.equal(resolve('.'), 'home/user/app/plain.js', 'node takes package.json main');
assert.equal(
  resolve('.', { preferModuleField: true }),
  'home/user/app/cli.ts',
  'bun prefers package.json module over main',
);

// Nothing runnable is null — the caller decides which error that is, because
// real bun says "Module not found" for a path and "Script not found" for a name.
assert.equal(resolve('nosuch'), null, 'an unresolvable bare name is null');
assert.equal(resolve('./nosuch.ts'), null, 'an unresolvable path is null');

// A missing package.json must not throw — `bun run x` in a bare directory is
// an ordinary miss, not a crash.
assert.equal(
  resolveRuntimeScriptPath(makeFs({}), '/home/user', '.', {}),
  null,
  'a cwd with no package.json resolves to null rather than throwing',
);

// ── the fall-through seam ───────────────────────────────────────────────────

function makeCtx(args) {
  const out = [];
  const err = [];
  return {
    ctx: {
      args,
      cwd: CWD,
      env: {},
      cred: undefined,
      stdout: { write: (d) => out.push(d) },
      stderr: { write: (d) => err.push(d) },
    },
    out,
    err,
  };
}

// A spec shaped like bun's: a `run` verb that hands a path back to the
// standard flow, exactly as session/init.ts does.
let ran = null;
const transformed = [];
const spec = {
  name: 'testbun',
  version: '1.0.0',
  helpText: 'usage: testbun',
  run: async (code, opts) => {
    ran = { code, opts };
    return { exitCode: 0, stdout: 'RAN\n', stderr: '' };
  },
  subcommands: {
    run: async (ctx, _registry, runAsRuntime) => {
      const args = ctx.args;
      const target = args[1];
      if (target === 'hello') {
        ctx.stdout.write('SCRIPT_BRANCH\n');
        return 0;
      }
      const resolved = resolveRuntimeScriptPath(fs, ctx.cwd, target, { preferModuleField: true });
      if (resolved === null) {
        ctx.stderr.write(`error: Module not found "${target}"\n`);
        return 1;
      }
      return runAsRuntime(['/' + resolved, ...args.slice(2)]);
    },
  },
};

const handler = buildRuntimeHandler(spec, {
  vfs: { as: () => fs },
  getEsbuild: () => ({
    transform: async (code) => {
      transformed.push(code);
      return { code: `/*transformed*/${code}` };
    },
  }),
  registry: { resolve: () => null },
});

// The verb still owns bare names it recognises.
{
  const { ctx, out } = makeCtx(['run', 'hello']);
  assert.equal(await handler(ctx), 0, 'the script branch still runs');
  assert.equal(out.join(''), 'SCRIPT_BRANCH\n', 'a bare script name never reaches the file flow');
}

// A path delegates into the standard flow and actually executes.
{
  ran = null;
  const { ctx, out } = makeCtx(['run', './cli.ts', '--help', 'extra']);
  assert.equal(await handler(ctx), 0, 'a delegated path exits with the runner code');
  assert.ok(ran, 'the runner was reached — the verb did not swallow the path');
  assert.equal(
    ran.opts.filename,
    '/home/user/app/cli.ts',
    'the runner receives the resolved file, not the verb',
  );
  assert.deepEqual(
    ran.opts.argv,
    ['/home/user/app/cli.ts', '--help', 'extra'],
    'user args after the path reach the script — --help is the script\'s, not the runtime\'s',
  );
  assert.ok(
    ran.code.includes('CLI_TS'),
    'the file\'s source was read and handed to the runner',
  );
  assert.equal(transformed.length, 1, 'a .ts target went through the transform path');
  assert.equal(out.join(''), 'RAN\n', 'runner stdout reaches the shell');
}

// Delegation must not re-enter the verb: a file literally named `run` would
// otherwise loop forever.
{
  ran = null;
  const loopFs = makeFs({ 'home/user/app/run': 'console.log("FILE_NAMED_RUN");' });
  const loopHandler = buildRuntimeHandler(
    { ...spec, subcommands: { run: async (ctx, _r, go) => go(['./run', ...ctx.args.slice(1)]) } },
    {
      vfs: { as: () => loopFs },
      getEsbuild: () => { throw new Error('esbuild must not be needed here'); },
      registry: { resolve: () => null },
    },
  );
  const { ctx } = makeCtx(['run']);
  assert.equal(await loopHandler(ctx), 0, 'delegation terminates');
  assert.ok(
    ran && ran.code.includes('FILE_NAMED_RUN'),
    'the continuation skips subcommand dispatch instead of recursing',
  );
}

// A runtime with no subcommand table is untouched by any of this.
{
  ran = null;
  const bare = buildRuntimeHandler(
    { name: 'testnode', version: '1.0.0', helpText: 'h', run: spec.run },
    {
      vfs: { as: () => fs },
      getEsbuild: () => ({ transform: async (c) => ({ code: c }) }),
      registry: { resolve: () => null },
    },
  );
  const { ctx } = makeCtx(['plain.js']);
  assert.equal(await bare(ctx), 0, 'the plain script path still runs');
  assert.equal(ran.opts.filename, '/home/user/app/plain.js', 'and resolves the same way');
}

console.log('runtime-script-resolution: OK');
