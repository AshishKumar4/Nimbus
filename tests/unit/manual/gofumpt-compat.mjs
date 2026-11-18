#!/usr/bin/env bun
// Local workerd only. Run with the output directory from build-compat.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalProbe } from '../lib/workerd-probe.mjs';

assert.equal(process.argv.length, 3, 'usage: bun tests/unit/manual/gofumpt-compat.mjs <build-output>');
const dir = resolve(process.argv[2]);
const repo = resolve(import.meta.dirname, '../../..');
const wasm = join(dir, 'gofumpt.wasm');
const oracle = join(dir, 'gofumpt-native');
const work = await mkdtemp(join(tmpdir(), 'nimbus-gofumpt-compat-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let local;
try {
  // Exercise the actual CLI runner without adding the candidate to the shared
  // runtime specs or staging helper. These objects exist only in local R2.
  const bytes = await readFile(wasm);
  const digest = sha(bytes);
  const content = `blobs/sha256/${digest}`;
  const release = { manifest: 'manifests/gofumpt-0.12.0.json', size_bytes: bytes.length, license: 'BSD-3-Clause' };
  const manifest = JSON.stringify({
    name: 'gofumpt', version: '0.12.0', license: release.license, wasi_namespace: 'wasi_snapshot_preview1',
    files: [{ path: 'bin/gofumpt', content, sha256: digest, size: bytes.length, mode: 'exec' }],
    entrypoints: [{ binName: 'gofumpt', runner: 'wasi-cli-runner@1', args: [] }],
  });
  const catalog = JSON.stringify({ version: 1, runtimes: { gofumpt: { default: '0.12.0', versions: {
    '0.12.0': { ...release, manifest_sha256: sha(manifest) },
  } } } });
  const pin = sha(catalog);
  const objects = [[content, wasm], [release.manifest, join(work, 'manifest')], [`catalog/sha256/${pin}.json`, join(work, 'catalog')]];
  await writeFile(objects[1][1], manifest);
  await writeFile(objects[2][1], catalog);
  const real = join(repo, 'node_modules/.bin/wrangler');
  const wrapper = join(work, 'wrangler');
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/usr/bin/env bash
set -eu
real=${quote(real)}
if [[ $1 == dev ]]; then
  args=("$@")
  while [[ $# -gt 1 && $1 != --persist-to ]]; do shift; done
  [[ $1 == --persist-to ]]
${objects.map(([key, file]) => `  "$real" r2 object put ${quote(`nimbus-runtime-cache/${key}`)} --file ${quote(file)} --local --persist-to "$2" >/dev/null`).join('\n')}
  exec "$real" "\${args[@]}"
fi
exec "$real" "$@"
`, { mode: 0o700 });
  local = await startLocalProbe({ runtimes: [], vars: { NIMBUS_RUNTIME_CATALOG_SHA256: pin }, wrangler: wrapper });
  process.env.BASE = local.base;
  process.env.NIMBUS_PROBE_TOKEN = local.token;
  const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
  const { mintSession, deleteSession } = await import('../../behavioral/_driver.mjs');
  const sid = await mintSession();
  try {
    const box = Nimbus.connect({ endpoint: local.base, token: local.token }).sandbox(sid);
    const result = await box.exec('nimbus install gofumpt@0.12.0', { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    console.log(JSON.stringify({ wasmSha256: digest, catalogPin: pin, imports: WebAssembly.Module.imports(new WebAssembly.Module(bytes)) }));

    const native = join(work, 'native');
    const guest = '/home/user/project';
    const source = 'package p\nimport(\n"example.test/project/local"\n"fmt"\n)\nfunc f() {    fmt.Println(local.X, 0644) }\n';
    await mkdir(join(native, 'nested'), { recursive: true });
    assert.equal((await box.exec(`mkdir -p ${guest}/nested`)).exitCode, 0);
    for (const [file, data] of Object.entries({ 'go.mod': 'module example.test/project\n\ngo 1.27.0\n', 'nested/sample.go': source, 'nested/bad.go': 'package p\nfunc =\n' })) {
      await writeFile(join(native, file), data, { mode: 0o640 });
      await box.files.write(`${guest}/${file}`, data);
    }
    await box.files.chmod(`${guest}/nested/sample.go`, 0o640);
    for (const [argv, input] of [[['sample.go']], [['-lang=go1', 'sample.go']], [['-d', 'sample.go']], [['bad.go']], [[], source], [['-w', 'sample.go']]]) {
      const expected = spawnSync(oracle, argv, { cwd: join(native, 'nested'), input, encoding: 'utf8', timeout: 5000 });
      assert.ifError(expected.error);
      const cmd = `${input === undefined ? '' : 'cat sample.go | '}PWD=/stale gofumpt ${argv.join(' ')}`;
      const { stdout, stderr, exitCode } = await box.exec(cmd, { cwd: `${guest}/nested`, timeoutMs: 15_000 });
      assert.deepEqual({ stdout, stderr, exitCode }, { stdout: expected.stdout, stderr: expected.stderr, exitCode: expected.status }, cmd);
      console.log(JSON.stringify({ cmd, stdout, stderr, exitCode }));
    }
    assert.equal(await box.files.read(`${guest}/nested/sample.go`), await readFile(join(native, 'nested/sample.go'), 'utf8'));
    const { mode } = await box.files.stat(`${guest}/nested/sample.go`);
    assert.equal(mode & 0o777, 0o640);

    const started = performance.now();
    const { stdout, stderr, exitCode } = await box.exec("(sleep 10; printf 'package p\\nvar X=1\\n') | gofumpt", { timeoutMs: 25_000 });
    const elapsedMs = Math.round(performance.now() - started);
    assert.deepEqual({ stdout, stderr, exitCode }, { stdout: 'package p\n\nvar X = 1\n', stderr: '', exitCode: 0 });
    assert.ok(elapsedMs >= 10_000 && elapsedMs < 15_000, `delayed pipe: ${elapsedMs}ms`);
    console.log(JSON.stringify({ delayedPipe: { stdout, stderr, exitCode, elapsedMs } }));

    const fixture = 'package p\n' + Array.from({ length: 144_000 }, (_, i) => `func f${i}(){println(1)}\n`).join('');
    await box.files.write('/home/user/compute.go', fixture);
    for (const interrupt of [false, true]) {
      const start = performance.now();
      const program = await box.startProgram(['gofumpt', '-l', 'compute.go'], { cwd: '/home/user' });
      let stdout = '', stderr = '';
      const collected = (async () => {
        for await (const part of program.output) {
          const data = Buffer.from(part.data).toString();
          if (part.stream === 'stderr') stderr += data;
          else stdout += data;
        }
      })();
      let accepted, live, sent;
      const watchdog = setTimeout(() => program.kill('SIGKILL'), 45_000);
      try {
        if (interrupt) {
          await Bun.sleep(1500);
          live = (await box.processes.list()).find((p) => p.pid === program.pid && p.state === 'running');
          assert.ok(live, 'compute fixture did not reach a live guest');
          sent = performance.now();
          accepted = await box.processes.signal(program.pid, 'SIGINT');
          assert.deepEqual(accepted, { ok: true, pid: program.pid });
        }
        const exit = await program.exit;
        await collected;
        const elapsedMs = Math.round(performance.now() - (sent ?? start));
        console.log(JSON.stringify({ compute: { pid: program.pid, live, accepted, stdout, stderr, exit, elapsedMs } }));
        assert.equal(stderr, '');
        assert.equal(stdout, interrupt ? '' : 'compute.go\n');
        assert.deepEqual(exit, { code: interrupt ? 130 : 0, signal: null });
        assert.ok(interrupt ? elapsedMs < 5000 : elapsedMs > 6500);
      } finally { clearTimeout(watchdog); }
    }
  } finally { assert.equal((await deleteSession(sid)).ok, true); }
} finally {
  try { await local?.stop(); }
  finally { await rm(work, { recursive: true, force: true }); }
}
