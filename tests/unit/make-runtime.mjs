#!/usr/bin/env bun
// GNU make as a catalog runtime (Kinu ask 72): make 4.4.1 cross-built for
// wasm32-wasi (packages/worker/wasm/make), installed as `nimbus install make`
// installs it and run by wasi-cli-runner@1, here off Cloudflare
// (localFacetHost). Before, a workspace had no make: "command not found".
// Here, what make does short of starting a recipe, which needs a host that
// can suspend it while its child runs (JSPI: wasi-cli-workerd.mjs runs them):
// - it is GNU Make 4.4.1, and reads the Makefile in the caller's directory,
//   or -f's, or -C's;
// - variables, functions ($(patsubst), $(foreach), $(wildcard), which reads
//   the directory) and $(info), with make's own output;
// - -n prints the recipes it would run, in dependency order, starting none;
// - an up-to-date target, a target with no rule, and $(error), with make's
//   messages and statuses (0, 2, 2).
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`make-runtime: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const open = (options) => NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', ...options });
{
  const seeding = await open({});
  const make = RUNTIMES.find((runtime) => runtime.name === 'make');
  assert.ok(make, 'the in-repo runtimes include make');
  seedRuntime(seeding.vfs, make);
  await seeding.close();
}
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });
const run = async (line) => {
  const result = await ws.exec(line);
  return [result.exitCode, result.stdout, result.stderr];
};
const write = (path, text) => ws.fs.writeFile(path, text);

try {
  const [code, version, err] = await run('make --version');
  assert.equal(code, 0, err);
  assert.match(version, /^GNU Make 4\.4\.1\nBuilt for wasm32-unknown-wasi\n/);
  console.log('  ok  GNU Make 4.4.1');

  await ws.exec('mkdir -p /home/user/proj/src /home/user/proj/sub');
  for (const name of ['a', 'b', 'c']) await write(`/home/user/proj/src/${name}.c`, `/* ${name} */\n`);
  await write('/home/user/proj/Makefile', [
    'SRCS := $(sort $(wildcard src/*.c))',
    'OBJS := $(patsubst src/%.c,build/%.o,$(SRCS))',
    '$(info sources: $(SRCS))',
    '$(info $(foreach o,$(OBJS),[$(notdir $(o))]))',
    '.PHONY: all',
    'all: app',
    'app: $(OBJS)',
    '\tcat $^ > $@',
    'build/%.o: src/%.c',
    '\t@mkdir -p build',
    '\tcp $< $@',
    'done.txt: ;',
    'fail:',
    '\t$(error stopped by $@)',
    '',
  ].join('\n'));
  await write('/home/user/proj/sub/GNUmakefile', 'here:\n\t@echo sub\n');
  await write('/home/user/proj/done.txt', 'done\n');

  const dry = await run('cd /home/user/proj && make -n');
  assert.equal(dry[0], 0, dry[2]);
  assert.equal(dry[1], [
    'sources: src/a.c src/b.c src/c.c',
    '[a.o] [b.o] [c.o]',
    'mkdir -p build', 'cp src/a.c build/a.o',
    'mkdir -p build', 'cp src/b.c build/b.o',
    'mkdir -p build', 'cp src/c.c build/c.o',
    'cat build/a.o build/b.o build/c.o > app',
    '',
  ].join('\n'));
  assert.equal(ws.vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).exists('home/user/proj/build'), false, '-n started nothing');
  console.log('  ok  it reads the Makefile in the caller\'s directory: variables, functions, $(wildcard), $(info), and -n in order');

  assert.deepEqual((await run('make -C /home/user/proj -f Makefile -n app')).slice(0, 1), [0]);
  const sub = await run('make -n -C /home/user/proj/sub');
  assert.equal(sub[0], 0, sub[2]);
  assert.match(sub[1], /^make: Entering directory '\/home\/user\/proj\/sub'\necho sub\nmake: Leaving directory '\/home\/user\/proj\/sub'\n$/);
  console.log('  ok  -C and -f, with make\'s own "Entering directory"');

  const upToDate = await run('cd /home/user/proj && make done.txt');
  assert.equal(upToDate[0], 0, upToDate[2]);
  assert.match(upToDate[1], /make: 'done\.txt' is up to date\.\n$/);
  const noRule = await run('cd /home/user/proj && make nothing');
  assert.equal(noRule[0], 2);
  assert.match(noRule[2], /^make: \*\*\* No rule to make target 'nothing'\.  Stop\.\n$/);
  const stopped = await run('cd /home/user/proj && make fail');
  assert.equal(stopped[0], 2);
  assert.match(stopped[2], /^Makefile:14: \*\*\* stopped by fail\.  Stop\.\n$/);
  console.log('  ok  up to date (0), no rule (2) and $(error) (2), in make\'s words');
} finally {
  await ws.close();
}
