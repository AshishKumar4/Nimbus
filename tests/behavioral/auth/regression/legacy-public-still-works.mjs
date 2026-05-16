#!/usr/bin/env bun
// auth/regression/legacy-public-still-works — when JWT_SECRET is unset
// OR NIMBUS_LEGACY_PUBLIC=1, mintSession() + WS connect must continue
// to work without a token (live demo path).
//
// This is the no-regression gate for the prod deploy: the live demo's
// users do NOT have tokens, and `createNimbusHandler()` with auth.mode
// default must auto-resolve to legacy mode when JWT_SECRET is unset.

import { mintSession, Terminal, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('auth/regression/legacy-public-still-works');

const sid = await mintSession();
a.check('POST /new returns a sessionId', typeof sid === 'string' && sid.length > 0,
  `sid=${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
a.check('WebSocket connected + prompt seen without any token', t.connected === true);

// Send a command and verify output flow (round-trips through the DO).
const { output } = await t.run('echo hello-from-legacy-public');
a.check('command output round-trips DO → WS', /hello-from-legacy-public/.test(output),
  `output=${JSON.stringify(output.slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
