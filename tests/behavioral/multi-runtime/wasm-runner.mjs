#!/usr/bin/env bun
// multi-runtime/wasm-runner — CAPTURE-ONLY (was P3 ship-target).
//
// Original intent: ship a `wasm-runner` shell command that takes a
// user-supplied .wasm file and runs it via WebAssembly.instantiate.
//
// FINDING during P3: WebAssembly.instantiate(bytes) is blocked by
// workerd's CSP — not just at supervisor request-time but ALSO inside
// facets. Cloudflare's web-standards documentation confirms:
//
//   For security reasons, the following are not allowed:
//     - eval()
//     - new Function (request-time; facets get module-init exemption)
//     - WebAssembly.compile / compileStreaming
//     - WebAssembly.instantiate with a buffer parameter
//     - WebAssembly.instantiateStreaming
//
// Only WebAssembly.instantiate(precompiledModule) — i.e. STATICALLY
// imported at deploy time — is allowed. Arbitrary user-supplied
// .wasm at runtime is a platform-level no.
//
// This probe stays as a forensic record of what fails and why.
// CAPTURE-ONLY — exits 0 always.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[wasm-runner-capture] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-cap', 10_000);
await t.run('cd /home/user/wr-cap', 10_000);

// 70-byte AssemblyScript-compiled add(a,b) → a+b. Verified via host-
// side `WebAssembly.instantiate(buf).then(r => r.instance.exports
// .add(3,4))` returns 7.
const HELLO_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DAgEABQMBAAAHEAIDYWRkAAAGbWVtb3J5AgAKCQEHACAAIAFqCwANBG5hbWUBBgEAA2FkZA==';

await t.run(
  `node -e "require('fs').writeFileSync('hello.wasm', Buffer.from('${HELLO_WASM_B64}','base64'))"`,
  30_000,
);

const findings = {
  probe: 'wasm-runner-capture',
  sid,
  base: BASE,
  startedAt: new Date().toISOString(),
};

// Test 1: wasm-runner --version (does the shell command exist?)
const r1 = await t.run('wasm-runner --version', 15_000);
findings.version = {
  output: stripAnsi(r1.output).slice(-300),
  cmdNotFound: /command not found/i.test(stripAnsi(r1.output)),
};

// Test 2: WebAssembly.instantiate(bytes) inside a facet — verify the CSP block
const wasmEvalCode = `
(async () => {
  const bytes = Uint8Array.from(atob('${HELLO_WASM_B64}'), c => c.charCodeAt(0));
  console.log('bytes-len:', bytes.length);
  try {
    const r = await WebAssembly.instantiate(bytes);
    console.log('exports:', Object.keys(r.instance.exports).join(','));
    console.log('add(3,4):', r.instance.exports.add(3, 4));
  } catch (e) {
    console.log('err:', e && e.message ? e.message : String(e));
  }
})();`;
const wasmEvalB64 = Buffer.from(wasmEvalCode).toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('check.js', Buffer.from('${wasmEvalB64}','base64').toString('utf8'))"`,
  30_000,
);
const r2 = await t.run('node check.js', 30_000);
const out2 = stripAnsi(r2.output);
findings.facetInstantiate = {
  output: out2.slice(-600),
  // The error string verifies the CSP block (workerd's exact wording).
  blocked: /code generation disallowed by embedder/i.test(out2) ||
           /WebAssembly\.instantiate.*disallowed/i.test(out2),
  reachedExports: /exports:\s*add/.test(out2),
};

await t.close();

console.log(JSON.stringify(findings, null, 2));
console.log('[wasm-runner-capture] EXPECTED-RED — captured for forensic record');
process.exit(0);
