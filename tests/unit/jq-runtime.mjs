#!/usr/bin/env bun
// jq as a catalog runtime (Kinu ask 72): jq 1.7.1 cross-built for wasm32-wasi
// (packages/worker/wasm/jq), installed as `nimbus install jq` installs it and
// run by wasi-cli-runner@1, here off Cloudflare (localFacetHost). Before, a
// workspace had no jq: `jq` was "command not found".
// - It is jq 1.7.1: its version, its filters, Oniguruma's regexes, its dates,
//   --arg and $ENV, -r and -c.
// - It starts in the caller's directory (nimbus_proc.startup_dir): a relative
//   path is the shell's cwd's, an absolute one the session's.
// - It reads a pipe and writes through a redirection, and exits as jq does:
//   -e on null 1, bad input 2, a filter that does not compile 3.
// - It reads as the caller: another uid's 0600 file is "Permission denied".
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`jq-runtime: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const open = (options) => NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', ...options });
{
  const seeding = await open({});
  const jq = RUNTIMES.find((runtime) => runtime.name === 'jq');
  assert.ok(jq, 'the in-repo runtimes include jq');
  seedRuntime(seeding.vfs, jq);
  await seeding.close();
}
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });
const run = async (line) => {
  const result = await ws.exec(line);
  return [result.exitCode, result.stdout, result.stderr];
};
const ok = async (line, stdout) => {
  const [code, out, err] = await run(line);
  assert.deepEqual([code, out], [0, stdout], `${line}: ${err}`);
};

try {
  await ok('jq --version', 'jq-1.7.1\n');
  await ok(`printf '{"a":[1,2,{"b":"x"}]}' | jq -c '.a[2], (.a | length)'`, '{"b":"x"}\n3\n');
  await ok(`jq -n -c '"abcabc" | [test("b."), sub("b"; "B"), [match("c"; "g").offset]]'`, '[true,"aBcabc",[2,5]]\n');
  await ok(`jq -n -r '1700000000 | todate, ("2015-03-05T23:51:47Z" | fromdate)'`, '2023-11-14T22:13:20Z\n1425599507\n');
  await ok(`FOO=bar jq -n -c --arg x 1 '[$x, $ENV.FOO, env.FOO]'`, '["1","bar","bar"]\n');
  await ok(`jq -n '[range(100000)] | add'`, '4999950000\n');
  console.log('  ok  jq 1.7.1: filters, regexes, dates, --arg and $ENV');

  ws.vfs.as(CRED_KERNEL).mkdir('home/user/proj', { recursive: true });
  ws.vfs.as(CRED_KERNEL).chown('home/user/proj', 1000, 1000);
  await ws.fs.writeFile('/home/user/proj/data.json', '{"name":"nimbus","n":[3,1,2]}\n');
  await ok('cd /home/user/proj && jq -r .name data.json', 'nimbus\n');
  await ok('cd /tmp && jq -c ".n | sort" /home/user/proj/data.json', '[1,2,3]\n');
  await ok('cd /home/user/proj && jq ".n | length" ../proj/./data.json', '3\n');
  await ok('cd /home/user/proj && jq -n "{a: 1}" > out.json && cat out.json', '{\n  "a": 1\n}\n');
  console.log('  ok  it starts in the caller\'s directory, and writes through a redirection');

  assert.deepEqual((await run('echo null | jq -e .')).slice(0, 2), [1, 'null\n'], '-e on null');
  const bad = await run(`echo '{"a":' | jq .`);
  assert.equal(bad[0], 2, bad[2]);
  assert.match(bad[2], /^jq: error \(at <stdin>:\d+\): /);
  const uncompiled = await run('jq -n "{"');
  assert.equal(uncompiled[0], 3, uncompiled[2]);
  assert.match(uncompiled[2], /jq: 1 compile error/);
  console.log('  ok  it exits as jq does: -e on null 1, bad input 2, a filter that does not compile 3');

  const root = ws.vfs.as(CRED_KERNEL);
  root.writeFile('home/user/proj/secret.json', '{"s":1}\n', { mode: 0o600 });
  root.chown('home/user/proj/secret.json', 2000, 2000);
  const denied = await run('cd /home/user/proj && jq . secret.json');
  assert.equal(denied[0], 2, denied[2]);
  assert.match(denied[2], /secret\.json: Permission denied/);
  console.log('  ok  it reads as the caller: another uid\'s 0600 file is Permission denied');
} finally {
  await ws.close();
}
