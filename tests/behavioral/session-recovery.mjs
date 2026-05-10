#!/usr/bin/env bun
// behavioral/session-recovery — close WS, reconnect with the SAME sid;
// assert filesystem + cwd + scrollback survived. NO _diag.
//
// Black-box surfaces only.

import { mintSession, Terminal, makeAsserter, sleep } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('session-recovery');
console.log(`behavioral/session-recovery — WS reconnect preserves state\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

// Connection 1 — set state.
const t1 = new Terminal(sid);
await t1.connect();
await sleep(2_000);
await t1.run('mkdir -p /home/user/app && cd /home/user/app', 10_000);
await t1.run('echo "marker-content-12345" > recovery-marker.txt', 10_000);
const cwdMarker1 = (await t1.run('pwd', 10_000)).output;
const cmd1 = (await t1.run('echo "scrollback-line-A"', 10_000)).output;
await t1.close();

// Connection 2 — same sid.
const t2 = new Terminal(sid);
await t2.connect();
await sleep(4_500); // let scrollback replay land

// 3. scrollback replay surfaces the previous "scrollback-line-A" output.
//    Check the initial buffer FIRST before running any commands (which
//    would reset the buffer).
{
  const haveScrollback = /scrollback-line-A/.test(t2.buf);
  a.check('scrollback replay surfaces prior-session output', haveScrollback,
    `t2.buf tail: ${t2.buf.slice(-300)}`);
}

// 1. file persisted.
{
  const r = await t2.run('cat /home/user/app/recovery-marker.txt', 10_000);
  a.check('marker file persists across WS reconnect',
    /marker-content-12345/.test(r.output), r.output.slice(0, 200));
}

// 2. cwd persisted (we should still be in /home/user/app, not /home/user).
{
  const r = await t2.run('pwd', 10_000);
  a.check('cwd persists across WS reconnect (still /home/user/app)',
    /\/home\/user\/app/.test(r.output), `marker1=${cwdMarker1.trim().slice(0, 80)} marker2=${r.output.trim().slice(0, 80)}`);
}

// 4. long-running process state — spawn a script with the explicit
//    --watch flag so the always-fresh-isolate dispatcher (post Change
//    A) routes to facetMgr.spawn (long-running fork). The shell
//    returns ≤3s with [started (long-running)] notice. Close t2.
//    Reconnect with t3 → ps should still list it.
//
//    Pre-Change-A, content-sniff would have routed http.listen here
//    automatically; post-Change-A, the user must opt in via
//    --watch / --inspect. This is the architectural promise.
{
  const longJs = `const http=require('http'); const s=http.createServer((q,r)=>r.end('x')); s.listen(0); setTimeout(()=>{s.close();process.exit(0);}, 25_000);`;
  const b64 = Buffer.from(longJs, 'utf8').toString('base64');
  await t2.run(`node -e "require('fs').writeFileSync('/tmp/srv.js', Buffer.from('${b64}','base64').toString('utf8'))"`, 15_000);
  // --watch makes runFresh route to facetMgr.spawn (long-running).
  await t2.run('node --watch /tmp/srv.js', 15_000);
  await sleep(1_500);
  await t2.close();

  // Reconnect with t3; ps should list the running node process.
  const t3 = new Terminal(sid);
  await t3.connect();
  await sleep(2_000);
  const r = await t3.run('ps', 10_000);
  a.check('long-running node process visible after WS reconnect',
    /node\b/.test(r.output) && /running/.test(r.output), r.output.slice(-300));
  await t3.close();
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
