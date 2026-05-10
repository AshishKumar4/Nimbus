#!/usr/bin/env bun
// behavioral/wrangler-dev-clone — clone a small Workers project + npm
// install + npm run dev → port reachable < 90 s.
//
// User repro: cd nimbus && npm run dev hangs forever at "Building
// Worker...". Both PATH α (cloning Nimbus into Nimbus and running its own
// `wrangler dev --ip 0.0.0.0 --port 8787`) and PATH β (any Workers
// project's `wrangler dev` inside Nimbus) hit the same browser-terminal
// `wrangler` shell handler.
//
// This probe drives PATH β with a *small* Worker (so we isolate the
// wrangler-dev path itself from the "bundle Nimbus's own 103 .ts files"
// case which may legitimately exceed the supervisor's 64 MiB ceiling).
//
// Asserts:
//   1. wrangler dev completes its bundle within 60 s of "Building Worker..."
//   2. either:
//        a) the worker is reachable via /worker/ AND returns the expected body
//        b) wrangler emitted a clear timeout / error / diagnostic (NOT silence)
//
// Black-box only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep, stripAnsi, fetchPort } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wrangler-dev-clone');
console.log(`behavioral/wrangler-dev-clone — small worker via wrangler dev\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);

// Step 1: write a minimal Workers project (no node_modules needed).
{
  await t.run('mkdir -p /home/user/hello-worker && cd /home/user/hello-worker', 10_000);
  const wranglerJsonc = JSON.stringify({
    name: 'hello-worker',
    main: 'src/index.ts',
    compatibility_date: '2026-04-01',
  });
  const indexTs = `export default { async fetch(req) { return new Response('hello-from-wrangler-dev-clone-probe', { headers: { 'content-type': 'text/plain' } }); } }`;
  const writeProbeJs = (path, content) => {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
  };
  await t.run(writeProbeJs('/home/user/hello-worker/wrangler.jsonc', wranglerJsonc), 10_000);
  await t.run('mkdir -p /home/user/hello-worker/src', 5_000);
  await t.run(writeProbeJs('/home/user/hello-worker/src/index.ts', indexTs), 10_000);
  // package.json is optional for wrangler dev; skip to keep this fast.
  const okWrangler = (await t.run('cat /home/user/hello-worker/wrangler.jsonc', 5_000)).output.includes('hello-worker');
  const okIndex = (await t.run('cat /home/user/hello-worker/src/index.ts', 5_000)).output.includes('hello-from-wrangler-dev-clone-probe');
  a.check('hello-worker scaffold (wrangler.jsonc + src/index.ts)',
    okWrangler && okIndex,
    `okWrangler=${okWrangler} okIndex=${okIndex}`);
}

// Step 2: run `wrangler dev` in the BACKGROUND (& \r) and watch for either
// a build-success marker, a build-error marker, or our timeout.
let buildOutcome = 'silence';
{
  await t.run('cd /home/user/hello-worker', 5_000);
  t.reset();
  t.cmd('wrangler dev');
  // Wait for ANY build-completed signal — success line OR error line OR
  // an explicit timeout diagnostic. RED today = silence forever.
  // Lookout for the explicit Building Worker print as the start marker;
  // anything that appears AFTER it indicates the build path resolved.
  let elapsed = -1;
  try {
    elapsed = await t.waitFor(
      (b) => (
        // Success: nimbus-wrangler logs that the build + load worked
        // (current source uses `Worker built and loaded`-style banner).
        /Worker built|Worker reachable|Worker is ready|Worker loaded|Worker bundled|build complete/i.test(b)
        // Honest-error: timeout or explicit no-output diagnostic
        || /esbuild bundle exceeded|esbuild init exceeded|No output from esbuild|esbuild error:|Bundle failed/i.test(b)
        // Or any other red error from nimbus-wrangler.ts onLog
        || /\x1b\[31m/.test(t.buf)
      ),
      90_000,
      'wrangler-dev build outcome',
    );
    const out = stripAnsi(t.buf);
    if (/Worker built|Worker reachable|Worker is ready|Worker loaded|Worker bundled|build complete/i.test(out)) {
      buildOutcome = 'success';
    } else if (/esbuild bundle exceeded|esbuild init exceeded/i.test(out)) {
      buildOutcome = 'honest-timeout';
    } else if (/No output from esbuild|esbuild error:|Bundle failed/i.test(out)) {
      buildOutcome = 'honest-error';
    } else {
      buildOutcome = 'red-error-other';
    }
    console.log(`  build outcome: ${buildOutcome} in ${elapsed}ms`);
  } catch (e) {
    // RED today: this branch fires — terminal silent for full 90s.
    buildOutcome = 'silence';
    console.log(`  build TIMEOUT — silence: ${e?.message?.slice(0, 200)}`);
  }
}

// Step 3: assert build either succeeded or failed loudly.
a.check('wrangler dev build resolves (success OR loud error, not silence)',
  buildOutcome !== 'silence',
  `outcome=${buildOutcome}`);

// Step 4: if successful, hit /worker/ and check response body.
if (buildOutcome === 'success') {
  // Nimbus routes user-Worker fetches via /s/<sid>/worker/. fetchPort
  // hits /s/<sid>/port/<n>/. We need the worker route — wire a direct fetch.
  const workerUrl = `${process.env.BASE}/s/${sid}/worker/`;
  let body = '';
  let status = 0;
  try {
    const resp = await fetch(workerUrl, { redirect: 'manual' });
    status = resp.status;
    body = await resp.text();
  } catch (e) {
    body = `fetch error: ${e?.message ?? e}`;
  }
  a.check('worker reachable via /worker/ returns expected body',
    status === 200 && body.includes('hello-from-wrangler-dev-clone-probe'),
    `status=${status} body=${body.slice(0, 200)}`);
} else {
  console.log(`  skipping reachability check (outcome=${buildOutcome})`);
  // If the build emitted a loud error, that's the GREEN path of this
  // probe — the contract is "no silent hang". Don't add a fake check
  // failure for the route reachability.
}

await t.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
