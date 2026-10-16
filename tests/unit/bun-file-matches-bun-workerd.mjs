// @serial
// @tier slow — drives a local workerd
// Bun.file and Bun.write answer as Bun's do, compared against the bun running
// this test (the oracle) running the same program over the same trees. In the
// session, `bun` runs the program in a process of its own, launched with the
// files of its working tree (`root`) in hand; the files of a tree outside it
// (`far`) are not resident there: reading one is a read through the session,
// as any file a program has not opened before.
//
//   - text, json, arrayBuffer, bytes and stream read the file's bytes, text
//     without a byte order mark; a missing file rejects with ENOENT; exists
//     and size answer as Bun's (a directory does not exist as a file);
//   - Bun.write takes the bytes of a Blob, a Response, a BunFile or a view
//     (its offset kept), encodes a string as UTF-8 and anything else as its
//     string, writes to a path or a BunFile, and answers the byte count.
//
// Red before: the shim read with readFileSync, which a non-resident file
// refuses, and text() and arrayBuffer() took that for an empty file; Bun.write
// turned a Blob into text (0xff became U+FFFD) and counted a string's UTF-16
// units.
//
// The session's side runs on workerd, where there is no Bun of its own: in
// this test's process the shim could not install its global over Bun's.
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SEEDED = {
  dirs: ['seed', 'out'],
  far: [['a.txt', new TextEncoder().encode('far\n')], ['bin', new Uint8Array([0x00, 0xfe, 0x01])]],
  files: [['seed/a.txt', new TextEncoder().encode('hé\n')], ['seed/data.json', new TextEncoder().encode('{"k":[1,2]}')], ['seed/bin', new Uint8Array([0xff, 0x00, 0x7f, 0x80])], ['seed/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])]],
};

// Run by both with `Bun`, `root` and `far` given; answers what each case did.
const PROGRAM = `async (Bun, root, far) => {
  const P = (p) => root + '/' + p;
  const F = (p) => far + '/' + p;
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const outcome = async (f) => { try { const r = await f(); return r === undefined ? 'ok' : r; } catch (e) { return { code: e.code }; } };
  const written = async (path, data) => { const n = await Bun.write(path, data); return [n, hex(new Uint8Array(await Bun.file(path).arrayBuffer()))]; };
  const r = {};
  r.text = await outcome(() => Bun.file(P('seed/a.txt')).text());
  r.json = await outcome(() => Bun.file(P('seed/data.json')).json());
  r.textBom = await outcome(() => Bun.file(P('seed/bom.txt')).text());
  r.arrayBuffer = await outcome(async () => hex(new Uint8Array(await Bun.file(P('seed/bin')).arrayBuffer())));
  r.bytes = await outcome(async () => hex(await Bun.file(P('seed/bin')).bytes()));
  r.stream = await outcome(async () => hex(new Uint8Array(await new Response(Bun.file(P('seed/bin')).stream()).arrayBuffer())));
  r.exists = await outcome(() => Bun.file(P('seed/a.txt')).exists());
  r.existsMissing = await outcome(() => Bun.file(P('missing.txt')).exists());
  r.existsDirectory = await outcome(() => Bun.file(P('seed')).exists());
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
  r.writeNumber = await outcome(() => written(P('out/n.txt'), 123));
  r.writeArrayBuffer = await outcome(() => written(P('out/ab.bin'), new Uint8Array([5, 4]).buffer));
  r.farText = await outcome(() => Bun.file(F('a.txt')).text());
  r.farArrayBuffer = await outcome(async () => hex(new Uint8Array(await Bun.file(F('bin')).arrayBuffer())));
  r.farBytes = await outcome(async () => hex(await Bun.file(F('bin')).bytes()));
  r.farStream = await outcome(async () => hex(new Uint8Array(await new Response(Bun.file(F('bin')).stream()).arrayBuffer())));
  r.farExists = await outcome(() => Bun.file(F('a.txt')).exists());
  r.writeFarFile = await outcome(() => written(P('out/far.bin'), Bun.file(F('bin'))));
  r.writeToBunFile = await outcome(async () => { const n = await Bun.write(Bun.file(P('out/dst.txt')), 'dst'); return [n, await Bun.file(P('out/dst.txt')).text()]; });
  return r;
}`;
const report = (root, far) => `(${PROGRAM})(Bun, ${JSON.stringify(root)}, ${JSON.stringify(far)}).then((r) => console.log('BUNFILE ' + JSON.stringify(r)))`;

// ── the oracle: this bun ──
const real = mkdtempSync(join(tmpdir(), 'nimbus-bun-file-'));
let expected;
try {
  for (const d of SEEDED.dirs) mkdirSync(join(real, 'root', d), { recursive: true });
  for (const [file, bytes] of SEEDED.files) writeFileSync(join(real, 'root', file), bytes);
  mkdirSync(join(real, 'far'));
  for (const [file, bytes] of SEEDED.far) writeFileSync(join(real, 'far', file), bytes);
  const oracle = spawnSync(process.execPath, ['-e', report(join(real, 'root'), join(real, 'far'))], { encoding: 'utf8', cwd: join(real, 'root') });
  if (oracle.status !== 0) throw new Error(`bun: ${oracle.stderr}`);
  expected = JSON.parse(oracle.stdout.slice(oracle.stdout.indexOf('BUNFILE ') + 'BUNFILE '.length));
  expected.exit = 0;
} finally {
  rmSync(real, { recursive: true, force: true });
}

// ── the session: `bun` in the same trees, written by an earlier command ──
const ROOT = '/home/user/bunfile';
const FAR = '/tmp/bunfile-far';
const files = Object.fromEntries([
  ...SEEDED.files.map(([file, bytes]) => [`${ROOT}/${file}`, Buffer.from(bytes).toString('base64')]),
  ...SEEDED.far.map(([file, bytes]) => [`${FAR}/${file}`, Buffer.from(bytes).toString('base64')]),
  [`${ROOT}/main.js`, Buffer.from(report(ROOT, FAR)).toString('base64')],
]);
let actual;
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(files)).toString('base64');
    const setup = await session.run(
      `mkdir -p ${SEEDED.dirs.map((d) => `${ROOT}/${d}`).join(' ')} ${FAR} && node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());for(const [n,b] of Object.entries(f))require('fs').writeFileSync(n,Buffer.from(b,'base64'));console.log('SETUP')"`,
    );
    if (setup.status !== 0) throw new Error(`setup: ${setup.stdout}`);
    const run = await session.run(`cd ${ROOT} && bun main.js`, 120_000);
    const line = run.stdout.split('\n').find((l) => l.startsWith('BUNFILE '));
    actual = line === undefined ? {} : JSON.parse(line.slice('BUNFILE '.length));
    actual.exit = run.status;
    if (line === undefined) process.stderr.write(`bun printed no report:\n${run.stdout.slice(-2000)}\n`);
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}

const differing = Object.keys(expected).filter((k) => JSON.stringify(actual[k]) !== JSON.stringify(expected[k]));
for (const k of differing) process.stderr.write(`${k}\n  bun:   ${JSON.stringify(expected[k])}\n  shim:  ${JSON.stringify(actual[k])}\n`);
if (differing.length > 0) {
  process.stderr.write(`bun-file-matches-bun-workerd: ${differing.length} of ${Object.keys(expected).length} answer otherwise than Bun's: ${differing.join(', ')}\n`);
  process.exit(1);
}
console.log(`bun-file-matches-bun-workerd: all ${Object.keys(expected).length} answers are Bun's`);
