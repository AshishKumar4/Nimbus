#!/usr/bin/env bun
// primitives-extension/process-env-port — primitive #7 probe.
//
// Bug (pre-fix): src/session/init.ts:1603-1623 — the session env
// at boot ships HOME/USER/PWD/NODE_ENV but is MISSING:
//   - PORT
//   - HOST
//   - NIMBUS_SESSION_ID
//
// User scripts that hardcode `process.env.PORT` (Express, Hono,
// fastify, raw Bun.serve, …) get `undefined` and fall back to
// random ports. The session URL identity is invisible to user
// code, blocking session-aware tooling.
//
// What we assert (GREEN gate):
//
//   1. node -e 'console.log(process.env.PORT)'      → "3000"
//   2. node -e 'console.log(process.env.HOST)'      → "0.0.0.0"
//   3. node -e 'console.log(process.env.NIMBUS_SESSION_ID)' → matches sid
//   4. The pre-existing keys are still set:
//        NODE_ENV=development, PWD=/home/user, USER=user, HOME=/home/user
//
// Black-box surfaces only: shell over WS.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[#7] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2000);
await t.waitForPrompt(15_000).catch(() => {});

async function envValue(key) {
  const r = await t.run(`node -e "console.log(JSON.stringify(process.env.${key}||null))"`, 30_000);
  // The shell echoes the command; the line right after is the JSON value.
  // Strip ANSI and look for the JSON literal.
  const lines = stripAnsi(r.output).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Drop lines that contain the command echo or the prompt.
  for (const l of lines) {
    if (l.includes('node -e')) continue;
    if (/[$#>]\s*$/.test(l)) continue;
    // Try to JSON-parse; fall through to next line if it's not valid.
    try {
      const v = JSON.parse(l);
      return v;
    } catch {}
  }
  return undefined;
}

const findings = {
  primitive: '#7',
  sid,
  base: BASE,
  observed: {
    PORT: await envValue('PORT'),
    HOST: await envValue('HOST'),
    NIMBUS_SESSION_ID: await envValue('NIMBUS_SESSION_ID'),
    NODE_ENV: await envValue('NODE_ENV'),
    PWD: await envValue('PWD'),
    USER: await envValue('USER'),
    HOME: await envValue('HOME'),
  },
};

await t.close();

console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['PORT === "3000"',                findings.observed.PORT === '3000'],
  ['HOST === "0.0.0.0"',             findings.observed.HOST === '0.0.0.0'],
  ['NIMBUS_SESSION_ID matches sid',  findings.observed.NIMBUS_SESSION_ID === sid],
  ['NODE_ENV preserved',             findings.observed.NODE_ENV === 'development'],
  ['PWD preserved',                  findings.observed.PWD === '/home/user'],
  ['USER preserved',                 findings.observed.USER === 'user'],
  ['HOME preserved',                 findings.observed.HOME === '/home/user'],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[#7] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
