#!/usr/bin/env bun
/**
 * wave-recall-retry — what the process decided and sends while the session
 * recalls a delegation over its path (the process's own read lease, a peer's
 * change recalling it while the directory batch that asked it has not
 * answered) goes again once the recall is over: the session refuses the
 * wave it cannot wait in (EAGAIN, the recall started), and the write is not
 * lost. Found by the barrier sweep (seed 1298, holder).
 */

import assert from 'node:assert/strict';
import { APP, bootEngine } from './lib/guest-engines.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { runScenarios, sleep, until } from './lib/resident-body.mjs';

const dec = new TextDecoder();

/** The holder engine, its directory batches answered once `open()` is called. */
async function parkedBatches(seed) {
  let asked = 0;
  const gate = Promise.withResolvers();
  const engine = await bootEngine('holder', {
    seed,
    supervise: {
      fsReadDirectories: async (call, args) => {
        const answer = await call(args);
        asked++;
        await gate.promise;
        return answer;
      },
    },
  });
  return { engine, asked: () => asked, open: () => gate.resolve() };
}

/** Root changes a name outside the process's subtrees: a peer that recalls the process's read lease first, and waits. */
const rootChange = (engine, key) => engine.authority.peerAs(CRED_KERNEL).chown(key, 0, 0);

await runScenarios(import.meta.path, {
  async 'a file the process makes while a peer recalls its read lease reaches the session'() {
    const { engine, asked, open } = await parkedBatches((authority) => {
      authority.kfs.mkdir('home/user/app/d/e', { recursive: true, mode: 0o755 });
      authority.kfs.mkdir('home/user/app/x', { mode: 0o755 });
      authority.kfs.writeFile('home/user/app/x/h', 'h');
      authority.kfs.writeFile('home/user/app/top', 't');
    });
    await engine.stat(`${APP}/x/h`);
    await engine.fs.readFile(`${APP}/top`);
    // The read lease is the process's at the session once the batch is asked; it learns of it with the batch's answer.
    const opening = engine.fs.open(`${APP}/d`, { read: true, directory: true });
    await until(() => asked() > 0, 'the directory batch asked');
    const recalling = rootChange(engine, 'home/user/app/x');
    engine.sync.writeFile(`${APP}/d/n`, new TextEncoder().encode('made'));
    const flushing = engine.fs.flush();
    await sleep(50);
    open();
    await Promise.all([flushing, recalling]);
    await engine.fs.close((await opening).id);
    assert.equal(dec.decode(engine.authority.kfs.readFile('home/user/app/d/n')), 'made');
  },
});
