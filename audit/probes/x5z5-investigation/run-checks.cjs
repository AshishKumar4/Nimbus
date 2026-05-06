// Standalone reproduction probes for the four Z5 packages.
// Each block runs in pure Node.js (no facet/wrangler needed) and
// reproduces the exact failure mode the runtime probe captured.
//
// Usage: node audit/probes/x5z5-investigation/run-checks.js
'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS = [];
function check(name, fn) {
  try {
    const r = fn();
    RESULTS.push({ name, status: 'ok', detail: r });
    console.log('[ok]', name, '—', r);
  } catch (e) {
    RESULTS.push({ name, status: 'err', detail: e.message });
    console.log('[ERR]', name, '—', e.message);
  }
}

// ───────────────────────────────────────────────────────────────────
// Z5 #1 — express. Reproduce util.inherits(X, Stream) where Stream is
//         a plain namespace object (no .prototype) → exact runtime
//         message "Object prototype may only be an Object or null:
//         undefined".
// ───────────────────────────────────────────────────────────────────
check('express: util.inherits with no-.prototype Stream throws verbatim message', () => {
  // Mirror our facet's __streamMod return shape — a plain object with
  // Readable/Writable/Stream:Readable but no .prototype on the
  // outermost object.
  const Readable = class extends require('events').EventEmitter {};
  const Writable = class extends require('events').EventEmitter {};
  const Stream = { Readable, Writable, Stream: Readable }; // OUR shim shape

  // Mirror our util.inherits shim verbatim from src/node-shims.ts:708
  const inherits = (c, s) => {
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c } });
  };

  let caught = null;
  try {
    inherits(Writable, Stream);
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error('expected throw, got none');
  const expected = 'Object prototype may only be an Object or null: undefined';
  if (caught.message !== expected) {
    throw new Error(`message mismatch:\n  got: ${caught.message}\n  exp: ${expected}`);
  }
  return 'verbatim runtime message reproduced';
});

check('express: a guarded inherits + namespace-with-.prototype both fix it', () => {
  // Fix A1 — synthetic .prototype on the namespace (low-risk).
  // Use plain functions (writable .prototype) like our shim's Readable/Writable.
  function Readable() {}
  Readable.prototype = Object.create(require('events').EventEmitter.prototype);
  function Writable() {}
  Writable.prototype = Object.create(require('events').EventEmitter.prototype);
  const StreamFixed = { Readable, Writable, Stream: Readable };
  Object.defineProperty(StreamFixed, 'prototype', { value: Readable.prototype, enumerable: false });

  const inherits = (c, s) => {
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c } });
  };
  inherits(Writable, StreamFixed); // should not throw

  // Fix B — guarded inherits also no-throws on bare namespace
  function W2() {}
  const StreamBare = { Readable, Writable };
  const inheritsGuarded = (c, s) => {
    if (s == null || s.prototype == null) return;
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
  };
  inheritsGuarded(W2, StreamBare); // should NOT throw — guard returns early
  return 'A1 namespace fix and B guard fix both no-throw';
});

// ───────────────────────────────────────────────────────────────────
// Z5 #2 — ts-jest. Reproduce missing fs.realpathSync.native access on
//         our shim shape.
// ───────────────────────────────────────────────────────────────────
check('ts-jest: _fs.realpathSync.native throws verbatim message', () => {
  // Mirror our __fsMod — readFileSync etc. but no realpathSync at all.
  const _fs = {
    readFileSync: () => '',
    writeFileSync: () => {},
    statSync: () => ({ isFile: () => true }),
    // (no realpathSync — see src/node-shims.ts:580-638)
  };

  let caught = null;
  try {
    // typescript.js:8247 verbatim
    const fsRealpath = !!_fs.realpathSync.native ? _fs.realpathSync.native : _fs.realpathSync;
    void fsRealpath;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error('expected throw, got none');
  const expected = "Cannot read properties of undefined (reading 'native')";
  if (caught.message !== expected) {
    throw new Error(`message mismatch:\n  got: ${caught.message}\n  exp: ${expected}`);
  }
  return 'verbatim runtime message reproduced';
});

check('ts-jest: adding realpathSync + .native makes the access succeed', () => {
  function realpathSync(p) { return path.resolve(String(p)); }
  realpathSync.native = realpathSync;
  const _fs = { readFileSync: () => '', realpathSync };

  // typescript.js:8247 verbatim
  const fsRealpath = !!_fs.realpathSync.native ? _fs.realpathSync.native : _fs.realpathSync;
  if (typeof fsRealpath !== 'function') throw new Error('fsRealpath should be a function');
  return 'fix unblocks ' + fsRealpath('/foo/bar');
});

// ───────────────────────────────────────────────────────────────────
// Z5 #3 — @tailwindcss/vite. Demonstrate looksLikeEsm regex misses
//         minified ESM where ;import or ;export are on the same line.
// ───────────────────────────────────────────────────────────────────
check('tailwindcss-vite: looksLikeEsm returns false on minified ;import/;export', () => {
  // Verbatim from src/facet-manager.ts:766-776
  function looksLikeEsm(src) {
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
    const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
    return importStmt.test(stripped) || exportStmt.test(stripped);
  }
  // Synthetic minified ESM — same shape as @tailwindcss/vite/dist/index.mjs
  const minifiedEsm = 'var C=1,D=2;import{compile as M}from"@tailwindcss/node";function f(){return 1};export{f as default};';
  if (looksLikeEsm(minifiedEsm)) {
    throw new Error('expected looksLikeEsm to return false on minified ;import/;export, got true');
  }
  return 'regex correctly fails to detect minified ESM (the bug)';
});

check('tailwindcss-vite: amended regex with [\\n;}] anchor + import[\\s{] catches it', () => {
  function looksLikeEsmFixed(src) {
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // (a) leading anchor relaxed to also accept ; and } (post-statement)
    // (b) `import\s+` and `export\s+` widened to `import[\s{]` / `export[\s{]`
    //     to catch the no-whitespace minified form `import{...}from"..."`.
    const importStmt = /(^|[\n;}])\s*import[\s{]/;
    const exportStmt = /(^|[\n;}])\s*export[\s{*]/;
    return importStmt.test(stripped) || exportStmt.test(stripped);
  }
  const minifiedEsm = 'var C=1,D=2;import{compile as M}from"@tailwindcss/node";function f(){return 1};export{f as default};';
  if (!looksLikeEsmFixed(minifiedEsm)) {
    throw new Error('expected fixed regex to detect minified ESM, got false');
  }
  // Make sure CJS isn't false-positived
  const cjs = 'const x = require("y");\nmodule.exports = {};';
  if (looksLikeEsmFixed(cjs)) throw new Error('false positive on plain CJS');
  // Also check newline-anchored ESM still works
  const esmNewline = 'import x from "y";\nexport default x;';
  if (!looksLikeEsmFixed(esmNewline)) throw new Error('regression on newline ESM');
  return 'fixed regex passes all 3 cases';
});

// ───────────────────────────────────────────────────────────────────
// Z5 #4 — @tailwindcss/oxide. No reproducible-locally probe — the bug
//         is "downstream blocker = workerd's node:wasi stub".
//         Section 04 already verified.
// ───────────────────────────────────────────────────────────────────
check('tailwindcss-oxide: documentation-pointer probe', () => {
  const sec = path.resolve(__dirname, '../../sections/04-native-mitigation.md');
  if (!fs.existsSync(sec)) throw new Error('section 04 not found at ' + sec);
  const txt = fs.readFileSync(sec, 'utf8');
  if (!txt.includes('node:wasi')) throw new Error('section 04 missing node:wasi cite');
  if (!txt.includes('@tailwindcss/oxide-wasm32-wasi')) {
    throw new Error('section 04 missing @tailwindcss/oxide-wasm32-wasi cite');
  }
  return 'section 04 confirms node:wasi is the upstream block (line 41,47-56)';
});

// ───────────────────────────────────────────────────────────────────
// Summary
// ───────────────────────────────────────────────────────────────────
const ok = RESULTS.filter(r => r.status === 'ok').length;
const err = RESULTS.filter(r => r.status === 'err').length;
console.log('\n──── X5Z5 reproduction summary: ' + ok + ' ok, ' + err + ' err ────');
process.exit(err === 0 ? 0 : 1);
