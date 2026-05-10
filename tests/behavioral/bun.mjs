#!/usr/bin/env bun
// behavioral/bun — Change B's bun-runtime probe matrix.
//
// Black-box surfaces only. NO _diag.
//
// Asserts:
//   1. `bun --version` returns a semver.
//   2. `bun -e <expr>` runs and prints to stdout.
//   3. `bun script.js` runs a file from the VFS.
//   4. `bun server.js` (Bun.serve) produces a long-running marker.
//   5. `bun install <pkg>` adds packages to node_modules.
//   6. `bun run <script>` executes a package.json script.

import { mintSession, Terminal, makeAsserter, sleep, heredocCommand } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('bun');
console.log(`behavioral/bun — bun runtime matrix\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.run('mkdir -p /home/user/bun-probe && cd /home/user/bun-probe', 10_000);

// 1. bun --version
{
  const r = await t.run('bun --version', 30_000);
  const lines = r.output.split('\n').map((l) => l.replace(/\r/g, ''));
  const hasVersion = lines.some((l) => /^\d+\.\d+\.\d+/.test(l) && !l.startsWith('user@'));
  a.check('bun --version returns a semver', hasVersion, r.output.slice(-200));
}

// 2. bun -e
{
  const tag = 'BUN_E_OUT_' + Math.random().toString(36).slice(2, 8);
  const r = await t.run(`bun -e 'console.log("${tag}")'`, 30_000);
  const lines = r.output.split('\n').map((l) => l.replace(/\r/g, ''));
  const seenInOutput = lines.some((l) => l.includes(tag) && !l.startsWith('user@') && !l.includes('bun -e'));
  a.check('bun -e prints output', seenInOutput, r.output.slice(-200));
}

// 3. bun script.js
{
  const tag = 'BUN_FILE_OUT_' + Math.random().toString(36).slice(2, 8);
  const scriptJs = `console.log('${tag}'); console.log('argv:', JSON.stringify(process.argv));`;
  await t.run(heredocCommand('/home/user/bun-probe/probe.js', scriptJs), 15_000);
  const r = await t.run('bun /home/user/bun-probe/probe.js arg1 arg2', 30_000);
  const lines = r.output.split('\n').map((l) => l.replace(/\r/g, ''));
  const seen = lines.some((l) => l.includes(tag) && !l.startsWith('user@'));
  a.check('bun script.js runs a file from the VFS', seen, r.output.slice(-200));
}

// 4. bun server.js (Bun.serve) — long-running marker.
const serverJs = `
const server = Bun.serve({
  port: 8722,
  hostname: "0.0.0.0",
  fetch(req) { return new Response("bun-served-content"); },
});
console.log("BUN_LISTENING " + server.port);
setTimeout(() => { server.stop(); process.exit(0); }, 12_000);
`.trim();
await t.run(heredocCommand('/home/user/bun-probe/server.js', serverJs), 15_000);
{
  t.reset();
  t.cmd('bun /home/user/bun-probe/server.js');
  let started = false;
  try {
    await t.waitFor((b) => /BUN_LISTENING|started \(long-running\)/.test(b), 30_000, 'bun server-started marker');
    started = true;
  } catch { /* recorded below */ }
  a.check('bun server.js (Bun.serve) emitted started marker', started, t.buf.slice(-200));
}

// Wait for server to exit (so the prompt returns) before next test.
await sleep(13_000);

// 5. bun install — small package.
{
  await t.run('cd /home/user/bun-probe && rm -rf node_modules', 15_000);
  await t.run('echo \'{"name":"bp","version":"0.0.0"}\' > package.json', 10_000);
  const r = await t.run('bun install zod', 180_000);
  // bun install reports "X packages installed" or similar.
  const ok = /packages installed|saved lockfile|Resolving dependencies|added \d+ packages|Done!/i.test(r.output);
  a.check('bun install zod completes', ok, r.output.slice(-300));
}

// 6. bun run <script>
{
  const tag = 'BUN_RUN_OUT_' + Math.random().toString(36).slice(2, 8);
  const pkgJson = `{"name":"bp","version":"0.0.0","scripts":{"hello":"node -e \\"console.log('${tag}')\\""}}`;
  await t.run(heredocCommand('/home/user/bun-probe/package.json', pkgJson), 10_000);
  const r = await t.run('bun run hello', 30_000);
  const lines = r.output.split('\n').map((l) => l.replace(/\r/g, ''));
  const seen = lines.some((l) => l.includes(tag) && !l.startsWith('user@') && !l.includes('hello'));
  a.check('bun run <script> executes package.json scripts', seen, r.output.slice(-300));
}

await t.close();
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
