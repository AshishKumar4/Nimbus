#!/usr/bin/env bun
// observability/unhandled-rejection — a rejection nothing handles ends the
// program as it ends Node's: Node's fatal report on stderr (the arrow at the
// place, the error, the version), exit code 1. Real Node runs each program
// too and is the oracle: its stderr, frames left out, is what the session's
// output carries. A handled rejection reports nothing, and an import() the
// listener must not disturb still runs.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[observability/unhandled-rejection] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('observability/unhandled-rejection');

const withoutFrames = (text) => text.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^\s+at /.test(line)).join('\n');
// Real Node's stderr and exit code for `program` as `file`, its directory named `dir`.
function nodeRun(file, program, dir) {
  const host = realpathSync(mkdtempSync(join(tmpdir(), 'unhandled-rejection-')));
  try {
    writeFileSync(join(host, file), program);
    const ran = spawnSync('node', [file], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH } });
    return { status: ran.status, report: withoutFrames(ran.stderr.split(host).join(dir)).trim() };
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}

// ── Check 1: a rejected promise nothing handles ─────────────────────

const REJ = `
console.log('BEFORE');
Promise.reject(new Error('synthetic-boom-42'));
console.log('AFTER_KICKOFF');
`;
await t.run('rm -rf /home/user/unhrej && mkdir -p /home/user/unhrej', 5_000);
await t.writeFile('/home/user/unhrej/rej.mjs', REJ);
const rejNode = nodeRun('rej.mjs', REJ, '/home/user/unhrej');
const rejR = await t.run('cd /home/user/unhrej && node rej.mjs', 30_000);
A.check(
  "rejection: Node's fatal report",
  withoutFrames(rejR.output).includes(rejNode.report),
  `node: ${rejNode.report}\nsession: ${rejR.output.slice(-900)}`,
);
A.check("rejection: Node's exit code", rejNode.status === 1 && rejR.exitCode === rejNode.status, `exit ${rejR.exitCode}, node ${rejNode.status}`);

// ── Check 2: an unawaited async function that throws ───────────────

const AFF = `
async function failing() { throw new Error('async-fire-forget-99'); }
console.log('BEFORE');
failing();
console.log('AFTER_KICKOFF');
`;
await t.run('rm -rf /home/user/aff && mkdir -p /home/user/aff', 5_000);
await t.writeFile('/home/user/aff/aff.mjs', AFF);
const affNode = nodeRun('aff.mjs', AFF, '/home/user/aff');
const affR = await t.run('cd /home/user/aff && node aff.mjs', 30_000);
A.check(
  "async-fire-forget: Node's fatal report",
  withoutFrames(affR.output).includes(affNode.report),
  `node: ${affNode.report}\nsession: ${affR.output.slice(-900)}`,
);
A.check("async-fire-forget: Node's exit code", affNode.status === 1 && affR.exitCode === affNode.status, `exit ${affR.exitCode}, node ${affNode.status}`);

// ── Check 3: handler-no-double ──────────────────────────────────────
//
// Rejection WITH explicit .catch handler attached → no unhandledrejection
// event → listener doesn't fire. Process exits cleanly with code 0.

await t.run('rm -rf /home/user/handled && mkdir -p /home/user/handled', 5_000);
await t.writeFile('/home/user/handled/handled.mjs', `
Promise.reject(new Error('caught-101')).catch(() => { console.log('CAUGHT_OK'); });
`);
const handR = await t.run('cd /home/user/handled && node handled.mjs', 30_000);
const handOut = handR.output;
A.check(
  'handler-no-double: no fatal report (the rejection was handled)',
  !/Node\.js v\d/.test(handOut),
  `tail: ${handOut.slice(-500)}`,
);
A.check(
  'handler-no-double: .catch handler fired (CAUGHT_OK printed)',
  /CAUGHT_OK/.test(handOut),
  `tail: ${handOut.slice(-500)}`,
);
A.check(
  'handler-no-double: process exits cleanly',
  handR.exitCode === 0,
  `tail: ${handOut.slice(-500)}`,
);

// ── Check 4: dynamic-import-regression ──────────────────────────────
//
// Run a single check from the dynamic-import wave to confirm the
// new listener doesn't break the existing fix. import('./mod').then(m => log)
// should still print mod's export and exit cleanly.

await t.run('rm -rf /home/user/dyn-reg && mkdir -p /home/user/dyn-reg', 5_000);
await t.writeFile('/home/user/dyn-reg/mod.mjs', "export const X = 'REG_OK';");
await t.writeFile('/home/user/dyn-reg/entry.mjs', `import('./mod.mjs').then(m => console.log('RESULT=' + m.X));`);
const regR = await t.run('cd /home/user/dyn-reg && node entry.mjs', 30_000);
const regOut = regR.output;
A.check(
  'dynamic-import-regression: RESULT=REG_OK printed (existing fix still works)',
  /RESULT=REG_OK/.test(regOut),
  `tail: ${regOut.slice(-500)}`,
);
A.check(
  'dynamic-import-regression: exit 0 and no fatal report',
  regR.exitCode === 0 && !/Node\.js v\d/.test(regOut),
  `tail: ${regOut.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
