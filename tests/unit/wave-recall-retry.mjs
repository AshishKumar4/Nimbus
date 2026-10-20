#!/usr/bin/env bun
/**
 * wave-recall-retry — a write the process sends while the session holds a
 * delegation over its path that must be recalled first (the process's own
 * read lease, asked with a directory batch whose answer has not reached it)
 * is sent again once the recall is over: the session refuses the wave it
 * cannot wait in (EAGAIN, the recall started), and the write is not lost.
 * Found by the barrier sweep (seeds 1008 and 1298, holder).
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

/** Root changes a name outside the process's subtrees (a peer that must recall the process's read lease first, and waits). */
const rootChange = (engine, key) => engine.authority.peerAs(CRED_KERNEL).chown(key, 0, 0);

await runScenarios(import.meta.path, {
  async 'a write sent while a peer recalls the process\'s read lease reaches the session'() {
    const { engine, asked, open } = await parkedBatches((authority) => {
      authority.kfs.mkdir('home/user/app/x/e', { recursive: true, mode: 0o755 });
      authority.kfs.mkdir('home/user/app/d', { mode: 0o755 });
    });
    // The read lease is the process's at the session once the batch is asked; it learns of it with the batch's answer.
    const opening = engine.fs.open(`${APP}/x/e`, { read: true, directory: true });
    await until(() => asked() > 0, 'the directory batch asked');
    const recalling = rootChange(engine, 'home/user/app/d');
    const writing = engine.write(`${APP}/x/f`, 'kept');
    await sleep(50);
    open();
    await Promise.all([writing, recalling]);
    await engine.fs.close((await opening).id);
    await engine.fs.flush();
    assert.equal(dec.decode(engine.authority.kfs.readFile('home/user/app/x/f')), 'kept');
  },
  async 'a directory\'s mode set while a peer recalls the process\'s read lease reaches the session'() {
    const { engine, asked, open } = await parkedBatches((authority) => {
      authority.kfs.mkdir('home/user/app/d/e', { recursive: true, mode: 0o755 });
      authority.kfs.mkdir('home/user/app/x', { mode: 0o755 });
    });
    const opening = engine.fs.open(`${APP}/d`, { read: true, directory: true });
    await until(() => asked() > 0, 'the directory batch asked');
    const recalling = rootChange(engine, 'home/user/app/x');
    const changing = engine.fs.chmod(`${APP}/d/e`, 0o700);
    await sleep(50);
    open();
    await Promise.all([changing, recalling]);
    await engine.fs.close((await opening).id);
    await engine.fs.flush();
    assert.equal(engine.authority.kfs.stat('home/user/app/d/e').mode & 0o777, 0o700);
  },
});
