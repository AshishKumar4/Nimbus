// W4 functional probe — r2-cache hit / miss observable in /api/_diag.
//
// Hits prod (or whichever BASE the _driver targets) and asserts that
// after npm install of a small package, the diag counters surface the
// W4 r2-cache fields (r2TarballHit, r2TarballMiss, r2PackumentHit,
// r2PackumentMiss). Pre-implementation: counters absent → probe fails.
//
// Post-implementation: a fresh session installs a small package; on first
// install r2TarballMiss > 0 (cold platform); on second-tenant install of
// the same package, r2TarballHit > 0.
//
// This probe runs the cold-then-warm sequence in a SINGLE session so it
// observes the same counter slot. Cross-tenant warm-cache behaviour is
// tested by e2e/mossaic-cold-warm.mjs which uses fresh sessions.

import { runProbe, nodeEvalBase64 } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r2-cache-hit-miss.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: r2-cache-hit-miss ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const probe = `
const probeJs = ${JSON.stringify(`
(async () => {
  // Use a package small enough to install fast but with a tarball.
  // 'is-odd' is ~700 bytes. Install once, fetch /api/_diag/memory, parse.
  const fetchDiag = async () => {
    const r = await fetch('/api/_diag/memory');
    if (!r.ok) return { error: 'diag http ' + r.status };
    return await r.json();
  };
  const before = await fetchDiag();
  console.log('DIAG_BEFORE:' + JSON.stringify({
    r2TarballHit: before?.r2?.tarballHit ?? 'absent',
    r2TarballMiss: before?.r2?.tarballMiss ?? 'absent',
    r2PackumentHit: before?.r2?.packumentHit ?? 'absent',
    r2PackumentMiss: before?.r2?.packumentMiss ?? 'absent',
  }));
})();
`)};
node -e "require('fs').writeFileSync('/tmp/diag.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" "$(echo -n '$0')" || true
`;

await runProbe('r2-cache-hit-miss', [
  { kind: 'cmd', cmd: 'mkdir -p /tmp/p && cd /tmp/p && cat > package.json <<EOF\n{ "name": "p", "version": "1.0.0", "dependencies": { "is-odd": "3.0.1" } }\nEOF', timeoutMs: 10_000 },
  { kind: 'cmd', cmd: 'cd /tmp/p && rm -rf node_modules && npm install 2>&1 | tail -20', timeoutMs: 60_000 },
  // First install — expect r2TarballMiss for is-odd@3.0.1 (cold-platform OR cold-tenant)
  { kind: 'cmd', cmd: nodeEvalBase64(`
    const r = await fetch('http://127.0.0.1:0/api/_diag/memory').catch(()=>null);
    // /api/_diag/memory is on the SUPERVISOR DO; from inside a session terminal,
    // it's reachable as a session-local fetch. We probe via the raw URL the
    // supervisor exposes at supervisor scope: /api/_diag/memory under the
    // session's host. Use globalThis.fetch with relative path since terminal
    // node-shim's fetch resolves within the supervisor's HTTP scope.
    try {
      const r = await fetch('/api/_diag/memory');
      const j = await r.json();
      console.log('DIAG1:' + JSON.stringify({
        r2: j.counters?.r2 || null,
        installPhase: j.counters?.installPhase,
      }));
    } catch (e) {
      console.log('DIAG1_ERR:' + e.message);
    }
  `), timeoutMs: 15_000 },
  // Second install of the SAME package — same session.
  { kind: 'cmd', cmd: 'cd /tmp/p && rm -rf node_modules && npm install 2>&1 | tail -20', timeoutMs: 60_000 },
  { kind: 'cmd', cmd: nodeEvalBase64(`
    try {
      const r = await fetch('/api/_diag/memory');
      const j = await r.json();
      console.log('DIAG2:' + JSON.stringify({
        r2: j.counters?.r2 || null,
        installPhase: j.counters?.installPhase,
      }));
    } catch (e) {
      console.log('DIAG2_ERR:' + e.message);
    }
  `), timeoutMs: 15_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });

// Post-process artifact: parse DIAG1/DIAG2 lines, assert r2 fields exist
// and behave as expected.
const text = fs.readFileSync(ARTIFACT, 'utf8');
const m1 = text.match(/DIAG1:({[^\n]+})/);
const m2 = text.match(/DIAG2:({[^\n]+})/);

let pass = false;
let reason = '';
if (!m1 || !m2) {
  reason = 'DIAG1 or DIAG2 not captured (pre-impl: r2 fields absent in /api/_diag/memory)';
} else {
  try {
    const d1 = JSON.parse(m1[1]);
    const d2 = JSON.parse(m2[1]);
    if (!d1.r2 || !d2.r2) {
      reason = 'r2 field absent in diag (pre-impl)';
    } else {
      // Post-impl assertions
      const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
      const okFields = ['tarballHit', 'tarballMiss', 'packumentHit', 'packumentMiss']
        .every((k) => has(d1.r2, k) && has(d2.r2, k));
      if (!okFields) {
        reason = 'r2 counter fields incomplete';
      } else {
        // Counter monotonicity: at least one of {hit, miss} must increase.
        const inc = (d2.r2.tarballHit + d2.r2.tarballMiss + d2.r2.packumentHit + d2.r2.packumentMiss)
                  - (d1.r2.tarballHit + d1.r2.tarballMiss + d1.r2.packumentHit + d1.r2.packumentMiss);
        pass = inc > 0;
        if (!pass) reason = 'counters did not increment between installs';
      }
    }
  } catch (e) {
    reason = 'parse failed: ' + e.message;
  }
}

log('');
log('VERDICT: ' + (pass ? 'PASS' : 'FAIL') + (reason ? ' (' + reason + ')' : ''));
process.exit(pass ? 0 : 1);
