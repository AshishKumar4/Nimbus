// @serial
// @tier slow — drives a local workerd
// A WASI program's stat of its working directory, through `wasm-runner` on
// the production engine (workerd, JSPI, the session's supervisor over RPC).
//
// Go's os.Getwd on wasip1 stats "." first, as the cwd its $PWD names
// re-stated against the "/" preopen, so a refusal there stops every Go
// program at startup: TypeScript 7's tsc said "Error getting current
// directory: stat .: I/O error". Each case is a program of its own, built
// here, that stats one name (or its preopen) and exits with the errno, 200
// when the answer is not a directory, or 0.

import assert from 'node:assert/strict';

import { Nimbus } from '../../packages/sdk/src/index.ts';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const enc = new TextEncoder();
const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const str = (s) => vec([...enc.encode(s)].map((b) => [b]));

/** A WASI command: path_filestat_get(3, follow, `name`) when a name is given, else fd_filestat_get(3). */
function statProgram(name) {
  const PATH = 16, OUT = 1024;
  const path = enc.encode(name ?? '');
  assert.ok(path.length < 64, 'a name the one-byte i32.const holds');
  const types = vec([
    [0x60, ...vec([[0x7f], [0x7f], [0x7f], [0x7f], [0x7f]]), ...vec([[0x7f]])],
    [0x60, ...vec([[0x7f], [0x7f]]), ...vec([[0x7f]])],
    [0x60, ...vec([[0x7f]]), 0x00],
    [0x60, 0x00, 0x00],
  ]);
  const wasi = (field, type) => [...str('wasi_snapshot_preview1'), ...str(field), 0x00, type];
  const imports = vec([wasi('path_filestat_get', 0), wasi('fd_filestat_get', 1), wasi('proc_exit', 2)]);
  const call = name === undefined
    ? [0x41, 3, 0x41, ...leb(OUT), 0x10, 1]
    : [0x41, 3, 0x41, 1, 0x41, PATH, 0x41, path.length, 0x41, 0x80, 0x08, 0x10, 0];
  const body = [
    ...vec([[1, 0x7f]]),
    ...call, 0x22, 0,
    0x04, 0x40, 0x20, 0, 0x10, 2, 0x0b,
    0x41, 0x90, 0x08, 0x2d, 0, 0, 0x41, 3, 0x47,
    0x04, 0x40, 0x41, 0xc8, 0x01, 0x10, 2, 0x0b,
    0x41, 0, 0x10, 2, 0x0b,
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, vec([[3]])),
    ...section(5, vec([[0x00, 1]])),
    ...section(7, vec([[...str('memory'), 0x02, 0], [...str('_start'), 0x00, 3]])),
    ...section(10, vec([[...leb(body.length), ...body]])),
    ...section(11, vec([[0x00, 0x41, PATH, 0x0b, ...leb(path.length), ...path]])),
  ]);
}

const CWD = '/home/user/proj/app';
const cases = [
  ['the preopen itself', undefined],
  ['"."', '.'],
  ['"./."', './.'],
  ['the cwd re-stated, as Go sends it', CWD.slice(1)],
  ['the cwd re-stated with "/."', `${CWD.slice(1)}/.`],
];

console.log('wasi-stat-cwd-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const box = Nimbus.connect({ endpoint: probe.base, token: probe.token }).sandbox(`wasi-stat-${Date.now().toString(36)}`);
try {
  const made = await box.exec(`mkdir -p ${CWD}`, { timeoutMs: 60_000 });
  assert.equal(made.exitCode, 0, made.stderr);
  const failures = [];
  for (const [i, [label, name]] of cases.entries()) {
    await box.files.write(`/home/user/stat-${i}.wasm`, statProgram(name));
    const r = await box.exec(`wasm-runner /home/user/stat-${i}.wasm`, { cwd: CWD, timeoutMs: 60_000 });
    console.log(`wasi-stat-cwd-workerd: ${label}: exit ${r.exitCode}${r.stderr ? ` (${r.stderr.trim()})` : ''}`);
    if (r.exitCode !== 0) failures.push(`${label}: exit ${r.exitCode} (an errno, or 200 for not a directory) ${r.stderr.trim()}`);
  }
  assert.deepEqual(failures, [], 'every stat of the working directory answers the directory');
} finally {
  await box.destroy({ reason: 'wasi-stat-cwd-workerd' }).catch(() => {});
  await probe.stop();
}
console.log(`wasi-stat-cwd-workerd: ${cases.length} stats of the working directory answer the directory`);
