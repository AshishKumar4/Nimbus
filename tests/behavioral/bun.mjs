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
//   7. `bun run <path.ts>` executes the FILE, args intact.
//   8. a path-shaped target never consults package.json scripts.
//   9. not-found reports bun's own two messages, by target shape.

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
//
// The server script self-exits at +5s (via `process.exit(0)`); we
// observe (a) the BUN_LISTENING marker mid-run, then (b) the shell
// prompt returning AFTER exit. Observing the prompt — rather than
// `sleep(N)` — is the correct synchronisation primitive: it avoids
// the WS-may-drop-during-blind-sleep race that caused the original
// `_driver.mjs:88 WS not open` failure surfaced by TST-2.
const SERVER_TTL_MS = 5_000;
const serverJs = `
const server = Bun.serve({
  port: 8722,
  hostname: "0.0.0.0",
  fetch(req) { return new Response("bun-served-content"); },
});
console.log("BUN_LISTENING " + server.port);
setTimeout(() => { server.stop(); process.exit(0); }, ${SERVER_TTL_MS});
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

// Wait for the shell prompt to return after the server self-exits.
// `waitForPrompt` polls the WS (which keeps it alive) and asserts the
// prompt is at the buffer tail — i.e. the bun process really exited
// and the shell is back. The probe-exit at +5s may complete BEFORE
// this call, so we use `waitForPrompt` (matches current tail) rather
// than `waitForNewPrompt` (which requires buf to grow further and
// would deadlock if the prompt is already present).
// SERVER_TTL_MS (5s) + 10s buffer = 15s timeout.
await t.waitForPrompt(SERVER_TTL_MS + 10_000);

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

// 7-9. `bun run <target>` — file vs script.
//
// `bun run` used to mean ONLY "look up package.json scripts", so
// `bun run packages/cli/bin/cli.ts --help` — the shape every bun-based
// installer launcher ends on — died on `script "…" not found`. Real bun runs
// a FILE for a path-shaped target and consults scripts only for a bare name.
// Expectations below were produced by running the identical case under real
// bun 1.3.1, including the two distinct not-found messages.
{
  const tag = 'BUN_RUN_FILE_' + Math.random().toString(36).slice(2, 8);
  const cliTs = [
    'const argv: string[] = process.argv.slice(2);',
    `console.log('${tag}');`,
    "console.log('ARGV ' + JSON.stringify(argv));",
  ].join('\n');
  await t.run('mkdir -p /home/user/bun-probe/pkg/bin', 15_000);
  await t.run(heredocCommand('/home/user/bun-probe/pkg/bin/cli.ts', cliTs), 15_000);

  // 7. A relative path to a TypeScript file runs it, and the args after the
  // path belong to the script — `--help` is NOT bun's here.
  {
    const r = await t.run('cd /home/user/bun-probe && bun run pkg/bin/cli.ts --help extra', 90_000);
    const out = r.output.replace(/\r/g, '');
    a.check('bun run <path.ts> executes the file', out.includes(tag), out.slice(-400));
    a.check(
      'bun run <path.ts> passes trailing args to the script',
      out.includes('ARGV ["--help","extra"]'),
      out.slice(-400),
    );
  }

  // 8. A path-shaped target is a file even when a script of that name exists.
  {
    const scriptTag = 'BUN_SHADOWED_' + Math.random().toString(36).slice(2, 8);
    const pkgJson = `{"name":"bp","version":"0.0.0","scripts":{"hello":"node -e \\"console.log('${scriptTag}')\\"","pkg/bin/cli.ts":"node -e \\"console.log('${scriptTag}')\\""}}`;
    await t.run(heredocCommand('/home/user/bun-probe/package.json', pkgJson), 10_000);
    const r = await t.run('cd /home/user/bun-probe && bun run ./pkg/bin/cli.ts', 90_000);
    const out = r.output.replace(/\r/g, '');
    a.check(
      'a path-shaped target runs the file, not a same-named script',
      out.includes(tag) && !out.includes(scriptTag),
      out.slice(-400),
    );
  }

  // 9. Not-found is bun's own message, and which one depends on the shape.
  {
    const bare = await t.run('cd /home/user/bun-probe && bun run nosuchthing', 30_000);
    a.check(
      'a missing bare name reports bun\'s Script not found',
      bare.output.includes('error: Script not found "nosuchthing"'),
      bare.output.slice(-300),
    );
    const path = await t.run('cd /home/user/bun-probe && bun run ./nosuch.ts', 30_000);
    a.check(
      'a missing path reports bun\'s Module not found',
      path.output.includes('error: Module not found "./nosuch.ts"'),
      path.output.slice(-300),
    );
  }
}

await t.close();
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
