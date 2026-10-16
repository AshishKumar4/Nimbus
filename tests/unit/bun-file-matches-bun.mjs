#!/usr/bin/env bun
// Bun.file and Bun.write answer as Bun's do, compared against the bun running
// this test (the oracle) running the same program over the same tree. In the
// shim, the seeded files are not resident: reading one is a read through the
// session, as any file a program has not opened before.
//
//   - text, json, arrayBuffer, bytes and stream read the file's bytes; a
//     missing file rejects with ENOENT; exists and size answer as Bun's;
//   - Bun.write takes the bytes of a Blob, a Response, a BunFile or a view
//     (its offset kept), encodes a string as UTF-8, writes to a path or a
//     BunFile, and answers the byte count.
//
// Red before: the shim read with readFileSync, which a non-resident file
// refuses, and text() and arrayBuffer() took that for an empty file; Bun.write
// turned a Blob into text (0xff became U+FFFD) and counted a string's UTF-16
// units.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { BUN_SHIM_PREAMBLE } from '../../packages/worker/src/runtime/bun-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

const realProcess = globalThis.process;
const SEEDED = {
  dirs: ['seed', 'out'],
  files: [['seed/a.txt', new TextEncoder().encode('hé\n')], ['seed/data.json', new TextEncoder().encode('{"k":[1,2]}')], ['seed/bin', new Uint8Array([0xff, 0x00, 0x7f, 0x80])]],
};

// Run by both with `Bun` and `root` given; answers what each case did.
const PROGRAM = `async (Bun, root) => {
  const P = (p) => root + '/' + p;
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const outcome = async (f) => { try { const r = await f(); return r === undefined ? 'ok' : r; } catch (e) { return { code: e.code }; } };
  const written = async (path, data) => { const n = await Bun.write(path, data); return [n, hex(new Uint8Array(await Bun.file(path).arrayBuffer()))]; };
  const r = {};
  r.text = await outcome(() => Bun.file(P('seed/a.txt')).text());
  r.json = await outcome(() => Bun.file(P('seed/data.json')).json());
  r.arrayBuffer = await outcome(async () => hex(new Uint8Array(await Bun.file(P('seed/bin')).arrayBuffer())));
  r.bytes = await outcome(async () => hex(await Bun.file(P('seed/bin')).bytes()));
  r.stream = await outcome(async () => hex(new Uint8Array(await new Response(Bun.file(P('seed/bin')).stream()).arrayBuffer())));
  r.exists = await outcome(() => Bun.file(P('seed/a.txt')).exists());
  r.existsMissing = await outcome(() => Bun.file(P('missing.txt')).exists());
  r.size = Bun.file(P('seed/bin')).size;
  r.sizeMissing = Bun.file(P('missing.txt')).size;
  r.name = Bun.file('rel/name.txt').name;
  r.textMissing = await outcome(() => Bun.file(P('missing.txt')).text());
  r.arrayBufferMissing = await outcome(() => Bun.file(P('missing.txt')).arrayBuffer());
  r.jsonMissing = await outcome(() => Bun.file(P('missing.txt')).json());
  r.writeBlob = await outcome(() => written(P('out/blob.bin'), new Blob([new Uint8Array([0xff, 0x00, 0x80])])));
  r.writeString = await outcome(() => written(P('out/s.txt'), 'é€'));
  r.writeFile = await outcome(() => written(P('out/copy.bin'), Bun.file(P('seed/bin'))));
  r.writeResponse = await outcome(() => written(P('out/resp.bin'), new Response(new Uint8Array([1, 2, 3]))));
  r.writeView = await outcome(() => written(P('out/view.bin'), new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)));
  r.writeArrayBuffer = await outcome(() => written(P('out/ab.bin'), new Uint8Array([5, 4]).buffer));
  r.writeToBunFile = await outcome(async () => { const n = await Bun.write(Bun.file(P('out/dst.txt')), 'dst'); return [n, await Bun.file(P('out/dst.txt')).text()]; });
  return r;
}`;

// ── the oracle: this bun ──
const real = mkdtempSync(join(tmpdir(), 'nimbus-bun-file-'));
let expected;
try {
  for (const d of SEEDED.dirs) mkdirSync(join(real, d), { recursive: true });
  for (const [file, bytes] of SEEDED.files) writeFileSync(join(real, file), bytes);
  const oracle = spawnSync(process.execPath, ['-e', `(${PROGRAM})(Bun, ${JSON.stringify(real)}).then((r) => console.log(JSON.stringify(r)))`], { encoding: 'utf8', cwd: real });
  if (oracle.status !== 0) throw new Error(`bun: ${oracle.stderr}`);
  expected = JSON.parse(oracle.stdout);
  expected.exit = [0, ''];
} finally {
  rmSync(real, { recursive: true, force: true });
}

// ── the shim: the bun runner's preamble, in a one-shot runner over a session's authority ──
const ROOT = '/home/user/bunfile';
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const key = (p) => (ROOT + '/' + p).slice(1);
kernel.mkdir(ROOT.slice(1), { recursive: true });
kernel.chown(ROOT.slice(1), 1000, 1000);
for (const d of SEEDED.dirs) { kernel.mkdir(key(d), { recursive: true }); kernel.chown(key(d), 1000, 1000); }
for (const [file, bytes] of SEEDED.files) { kernel.writeFile(key(file), bytes); kernel.chown(key(file), 1000, 1000); }
const dir = mkdtempSync(join(tmpdir(), 'bun-file-matches-bun-'));
let actual;
try {
  const program = `${BUN_SHIM_PREAMBLE}\n(${PROGRAM})(globalThis.Bun, ${JSON.stringify(ROOT)}).then((r) => console.log(JSON.stringify(r)))`;
  const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
  const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
  const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const process = processInstanceSupervisor(authority, cred);
  let body;
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ argv: [], env: {}, cwd: ROOT, filename: ROOT + '/main.js', dirname: ROOT, stdin: '', captureOutput: true, cred, pid: process.pid }),
    }), { SUPERVISOR: process.supervisor });
    body = await response.json();
  } finally {
    await process.close();
  }
  actual = JSON.parse(body.stdout || '{}');
  actual.exit = [body.exitCode, String(body.stderr ?? '').split(ROOT).join('/ROOT').slice(0, 2000)];
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const differing = Object.keys(expected).filter((k) => JSON.stringify(actual[k]) !== JSON.stringify(expected[k]));
for (const k of differing) realProcess.stderr.write(`${k}\n  bun:   ${JSON.stringify(expected[k])}\n  shim:  ${JSON.stringify(actual[k])}\n`);
if (differing.length > 0) {
  realProcess.stderr.write(`bun-file-matches-bun: ${differing.length} of ${Object.keys(expected).length} answer otherwise than Bun's: ${differing.join(', ')}\n`);
  realProcess.exit(1);
}
console.log(`bun-file-matches-bun: all ${Object.keys(expected).length} answers are Bun's`);
