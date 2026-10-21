#!/usr/bin/env bun
// Experiment (not for landing): what a warm ruby one-shot asks of the session
// (its resident store's statistics, absent-name lookups counted apart), in the
// session and on its peer, paired, 8 rounds, the session otherwise idle.
import { mintSession, deleteSession, Terminal } from '../_driver.mjs';
import { peer, warmFor, mark, hostsSince } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const ARMS = {
  'ruby launch': `NIMBUS_WASI_FS_STATS=1 ruby -e "puts 1"`,
  'gem require': `NIMBUS_WASI_FS_STATS=1 ruby -e "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1"`,
};
const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const setup = await t.run('nimbus install ruby', 600_000);
  if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.output.slice(-300)}`);
  for (const [arm, line] of Object.entries(ARMS)) {
    await peer(sid, 'forget');
    await t.run(line, 600_000);
    await t.run(line, 600_000);
    for (let i = 1; i <= 8; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        if (host === 'session') await peer(sid, 'forget');
        else await warmFor(sid, 'ruby-runner');
        const marked = await mark(sid);
        const started = Date.now();
        const r = await t.run(line, 600_000);
        const ms = Date.now() - started;
        const stats = r.output.match(/\[wasi-fs\] ruby (\{.*\}|null)/);
        out({ arm, round: i, host, ms, exit: r.exitCode, ranOn: await hostsSince(sid, marked), stats: stats ? JSON.parse(stats[1]) : null });
      }
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
