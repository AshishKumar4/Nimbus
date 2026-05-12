#!/usr/bin/env bun
// npm-create/new/create-nextjs-node-constants — framework-fixes-F1.
//
// Pre-fix: `require('node:constants')` errored "Cannot find module
// 'node:constants'" from create-next-app's init flow, blocking the
// entire scaffold. Root cause: src/runtime/node-shims.ts had no
// builtins.constants / builtins['node:constants'] registration.
//
// Post-fix: __constantsMod exposes the constant table; both
// 'constants' and 'node:constants' resolve and expose UV_FS_O_FILEMAP
// (the specific constant create-next-app reads at module init).
//
// Probe shape:
//   1. Direct: `node -e require('node:constants').UV_FS_O_FILEMAP`
//      to verify the shim resolves and exposes the expected key.
//   2. End-to-end: full create-next-app invocation, assert no
//      "Cannot find module 'node:constants'" in output. create-next-
//      app may still fail at a later step (other deps), but the F1
//      regression signature must not surface.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/new/create-nextjs-node-constants');
console.log(`npm-create/new/create-nextjs-node-constants — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function tail(s, n = 600) { return s.length > n ? '…' + s.slice(-n) : s; }

// Probe 1: direct shim resolution.
{
  const r = await t.run(
    `node -e "const c = require('node:constants'); console.log('UV_FS_O_FILEMAP=' + c.UV_FS_O_FILEMAP); console.log('O_RDONLY=' + c.O_RDONLY); console.log('SIGTERM=' + c.SIGTERM); console.log('OK')"`,
    60_000,
  );
  const out = stripAnsi(r.output);
  a.check("require('node:constants') resolves (no 'Cannot find module')",
    !/Cannot find module 'node:constants'/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
  a.check('UV_FS_O_FILEMAP defined',
    /UV_FS_O_FILEMAP=0/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
  a.check('O_RDONLY defined',
    /O_RDONLY=0/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
  a.check('SIGTERM defined (signal value 15)',
    /SIGTERM=15/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
  a.check('script reaches "OK" (no mid-script crash)',
    /\bOK\b/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
}

// Probe 2: bare 'constants' (no 'node:' prefix).
{
  const r = await t.run(
    `node -e "console.log('UV_FS_O_FILEMAP=' + require('constants').UV_FS_O_FILEMAP)"`,
    30_000,
  );
  const out = stripAnsi(r.output);
  a.check("require('constants') (legacy bare form) also resolves",
    /UV_FS_O_FILEMAP=0/.test(out) && !/Cannot find module/.test(out),
    `tail=${JSON.stringify(tail(out))}`);
}

// Probe 3: end-to-end create-next-app — the regression signature
// "Cannot find module 'node:constants'" must NOT surface.
{
  const r = await t.run(
    `npm create next-app@latest test-next -- --yes --use-npm --typescript=false --tailwind=false --eslint=false --src-dir=false --app=false --import-alias=@/* 2>&1; echo RC=$?`,
    240_000,
  );
  const out = stripAnsi(r.output);
  a.check("create-next-app: no 'Cannot find module node:constants' error",
    !/Cannot find module 'node:constants'/.test(out),
    `tail=${JSON.stringify(tail(out, 800))}`);
}

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
