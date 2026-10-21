#!/usr/bin/env bun
// Experiment (not for landing): a clang compile+link's client wall, in the
// session (pinned) and on its warm peer, each with and without the session's
// pending writes made durable before a call leaves (presync), in one idle
// session, 8 rounds of 4 runs an arm, arm order rotating.
import { mintSession, deleteSession, Terminal, heredocCommand } from '../_driver.mjs';
import { peer, warmFor } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const LINE = 'rm -f x && clang x.c -o x';
const ARMS = [['session', false], ['session', true], ['peer', false], ['peer', true]];
const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install clang', heredocCommand('x.c', '#include <stdio.h>\nint main(void) { printf("%d\\n", 6 * 7); return 0; }\n')]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${r.output.slice(-300)}`);
  }
  await peer(sid, 'pin');
  await t.run(LINE, 600_000);
  await t.run(LINE, 600_000);
  await peer(sid, 'unpin');
  await t.run(LINE, 600_000);
  for (const tag of ['clang-runner-clang', 'clang-runner-wasm-ld']) await warmFor(sid, tag);
  for (let i = 1; i <= 8; i++) {
    for (let k = 0; k < ARMS.length; k++) {
      const [host, presync] = ARMS[(k + i) % ARMS.length];
      await peer(sid, host === 'session' ? 'pin' : 'unpin');
      await peer(sid, presync ? 'presync' : 'nosync');
      if (host === 'peer') for (const tag of ['clang-runner-clang', 'clang-runner-wasm-ld']) await warmFor(sid, tag);
      const walls = [];
      for (let n = 0; n < 4; n++) {
        const started = Date.now();
        const r = await t.run(LINE, 600_000);
        walls.push({ wall: Date.now() - started, exit: r.exitCode });
      }
      out({ round: i, host, presync, walls });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await peer(sid, 'nosync').catch(() => {});
  await peer(sid, 'unpin').catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
