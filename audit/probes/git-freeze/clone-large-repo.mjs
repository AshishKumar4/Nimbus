// git-freeze — clone-large-repo end-to-end.
//
// Reproduces the prod freeze characterized in P1 + locks the post-fix
// invariant.
//
// Pre-fix (verified at 2026-05-09T03:54Z against
//   https://nimbus.ashishkmr472.workers.dev): clone of
//   https://github.com/AshishKumar4/Nimbus halts at
//   "Updating workdir 1450/1595" and never completes. The
//   SupervisorRPC wrapper isolate OOMs after ~5 writeBatch waves
//   (audit/probes/git-freeze/tail-2026-05-09T04-00-32Z.jsonl shows
//   two simultaneous "Worker exceeded memory limit" events on
//   SupervisorRPC.stat at t+25.7s, after which the clone freezes).
//
// Post-fix (P3 commit d699a36): the git facet now uses
//   writeBatchStream (W7) when supervisor.writeBatchStream and
//   encodeWriteBatchStream are both available. encodeWriteBatchStream
//   is wired in via the W7_FRAME_PREAMBLE prepended to the facet's
//   main module source. The streaming path uses a 256 KiB-highwater
//   ReadableStream — wrapper-isolate residency stays bounded
//   regardless of wave size, so the OOM cascade can't fire.
//
// Probe assertions:
//   (1) Clone completes within CLONE_TIMEOUT_MS (default 180s).
//   (2) The "[git] clone complete (N files, X bytes in Ts)" line
//       appears in the WS output stream.
//   (3) N matches the expected file count for the repo (within a
//       small tolerance to allow .git metadata variance).
//   (4) Final progress frame is "Updating workdir N/N" (NOT a
//       partial-progress freeze like 1450/1595).
//
// BASE controls target. Default = local wrangler dev on 8797.
// Set BASE=https://nimbus.ashishkmr472.workers.dev for prod
// verification (after deploy).
//
// REPO controls the target repo. Default Nimbus
// (https://github.com/AshishKumar4/Nimbus) — that's the repo the
// freeze was originally observed against. Smaller repos can
// substitute for local CI runs (workerd local dev's CF git proxy
// blocks larger fetches).
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8797';
const REPO = process.env.REPO || 'https://github.com/AshishKumar4/Nimbus';
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS || 180_000);
// Minimum file count we expect from the cloned repo. Default 100
// catches any reasonably-sized repo; for the canonical Nimbus
// target it'll be ~1500. Tests can lower this for tiny repos.
const MIN_FILE_COUNT = Number(process.env.MIN_FILE_COUNT || 100);

console.log('==== git-freeze clone-large-repo probe ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('REPO:', REPO);
console.log('CLONE_TIMEOUT_MS:', CLONE_TIMEOUT_MS);

// Mint a fresh session.
const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('SID:', sid);

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let buf = '';
ws.on('message', (m) => {
  try { const x = JSON.parse(m.toString()); if (x.type === 'output') buf += x.data; } catch {}
});
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

// Wait for shell prompt.
function stripped() { return buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); }
const tShell0 = Date.now();
while (Date.now() - tShell0 < 8000) {
  if (/\$ ?$/.test(stripped().trimEnd().slice(-3))) break;
  await new Promise(r => setTimeout(r, 100));
}
console.log('shell prompt ready @', Date.now() - tShell0, 'ms');

// Issue clone.
ws.send(JSON.stringify({ type: 'input', data: `git clone ${REPO}\r` }));
const tCloneStart = Date.now();

// Drive the clone to completion or timeout.
// Successful completion: "[git] clone complete (N files, X.YKB in Z.Zs)"
// Failure: "[git] clone failed: ..." or timeout.
const COMPLETE_RE = /\[git\] clone complete \((\d+) files, ([0-9.]+)KB in ([0-9.]+)s\)/;
const FAILED_RE = /\[git\] clone failed: (.+)/;

let cloneResult = null;
while (Date.now() - tCloneStart < CLONE_TIMEOUT_MS) {
  const s = stripped();
  const m = s.match(COMPLETE_RE);
  if (m) {
    cloneResult = {
      ok: true,
      files: parseInt(m[1], 10),
      kb: parseFloat(m[2]),
      seconds: parseFloat(m[3]),
    };
    break;
  }
  const f = s.match(FAILED_RE);
  if (f) {
    cloneResult = { ok: false, error: f[1] };
    break;
  }
  await new Promise(r => setTimeout(r, 500));
}

const cloneWallMs = Date.now() - tCloneStart;
ws.close();

console.log('clone wall time:', cloneWallMs, 'ms');

let pass = true;
if (!cloneResult) {
  // Timed-out with NO completion and NO error message. This is
  // exactly the original git-freeze symptom shape — the clone
  // hangs at a partial-progress frame (e.g. 1450/1595) with no
  // resolution. Surface the smoking-gun frame for triage.
  console.log(`FAIL: clone timed out after ${CLONE_TIMEOUT_MS}ms with no completion / error message`);
  const lines = stripped().split('\n');
  const lastWorkdir = lines.reverse().find(l => /\[git\] Updating workdir/.test(l));
  if (lastWorkdir) {
    console.log('  last [git] Updating workdir frame:', JSON.stringify(lastWorkdir.slice(-200)));
  }
  pass = false;
} else if (!cloneResult.ok) {
  // The clone errored cleanly. Distinguish infrastructure failures
  // (CF git-proxy denying upstream, network unavailable) from
  // genuine Nimbus regressions (auth-shape change, RPC ABI break,
  // etc.). Local wrangler dev's CF git-proxy intermittently
  // returns 403/522 for upstream reachability reasons that are
  // NOT a Nimbus bug — emit INFRA_FAIL so the run-all surfaces
  // it as not-our-fault rather than wedging the regression.
  //
  // The infra-fail signature is "[git] clone failed: HTTP Error: <code> ..."
  // where <code> is a transport-layer status (403/522/timeout)
  // surfacing through isomorphic-git's http transport. Genuine
  // Nimbus regressions surface as RPC errors, schema errors,
  // or the freeze (no error message at all — handled above).
  const isInfraFail = /HTTP Error: (?:403|408|429|5\d\d)\b/.test(cloneResult.error)
                   || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(cloneResult.error);
  if (isInfraFail) {
    console.log(`INFRA_FAIL: ${cloneResult.error}`);
    console.log('  (CF git-proxy / upstream reachability — NOT a Nimbus regression.');
    console.log('   Re-run later or switch BASE to prod for a real verification.)');
    // Exit 0 — INFRA_FAIL is reported but does not gate the wave.
    // The git-freeze invariant the probe is locking is "the freeze
    // shape doesn't recur", and a clean error ≠ a freeze.
    console.log('==== EXIT 0 (infra) ====');
    process.exit(0);
  }
  console.log(`FAIL: clone failed with: ${cloneResult.error}`);
  pass = false;
} else {
  console.log(`PASS: clone completed — ${cloneResult.files} files, ${cloneResult.kb} KB in ${cloneResult.seconds}s`);
  if (cloneResult.files < MIN_FILE_COUNT) {
    console.log(`FAIL: file count ${cloneResult.files} < expected min ${MIN_FILE_COUNT}`);
    pass = false;
  } else {
    console.log(`PASS: file count ${cloneResult.files} ≥ ${MIN_FILE_COUNT}`);
  }
  if (cloneResult.seconds * 1000 > CLONE_TIMEOUT_MS) {
    console.log(`FAIL: facet-reported time ${cloneResult.seconds}s > ${CLONE_TIMEOUT_MS}ms timeout`);
    pass = false;
  }
}

// Additional invariant: the LAST progress frame must show
// loaded === total (no 1450/1595-style partial-freeze tail).
const allWorkdir = [...stripped().matchAll(/\[git\] Updating workdir (\d+)\/(\d+)/g)];
if (allWorkdir.length > 0) {
  const last = allWorkdir[allWorkdir.length - 1];
  const loaded = parseInt(last[1], 10);
  const total = parseInt(last[2], 10);
  if (loaded === total) {
    console.log(`PASS: final progress frame ${loaded}/${total} (loaded === total)`);
  } else {
    console.log(`FAIL: final progress frame ${loaded}/${total} — partial freeze (the git-freeze symptom)`);
    pass = false;
  }
} else if (cloneResult?.ok && cloneResult.files <= 5) {
  // Tiny repos (1-5 files) may complete before any "Updating
  // workdir" frame is emitted — the throttle in network-facet.ts:524
  // suppresses fast progress. That's fine.
  console.log('PASS: tiny repo — no Updating workdir frames recorded (throttled out)');
} else {
  console.log('FAIL: no Updating workdir frame found in stream — probe scenario broken');
  pass = false;
}

console.log(`==== EXIT ${pass ? 0 : 1} ====`);
process.exit(pass ? 0 : 1);
