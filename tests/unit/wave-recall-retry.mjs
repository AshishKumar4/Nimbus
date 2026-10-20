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
import { runScenarios, until } from './lib/resident-body.mjs';

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

await runScenarios(import.meta.path, {
  async 'a write beside a directory whose batch is out reaches the session'() {
    const { engine, asked, open } = await parkedBatches((authority) => {
      authority.kfs.mkdir('home/user/app/x/e', { recursive: true, mode: 0o755 });
    });
    const opening = engine.fs.open(`${APP}/x/e`, { read: true, directory: true });
    await until(() => asked() > 0, 'the directory batch asked');
    await engine.write(`${APP}/x/f`, 'kept');
    open();
    await engine.fs.close((await opening).id);
    await engine.fs.flush();
    assert.equal(dec.decode(engine.authority.kfs.readFile('home/user/app/x/f')), 'kept');
  },
  async 'a file made in a directory whose batch is out reaches the session'() {
    const { engine, asked, open } = await parkedBatches((authority) => {
      authority.kfs.mkdir('home/user/app/d', { recursive: true, mode: 0o755 });
    });
    const opening = engine.fs.open(`${APP}/d`, { read: true, directory: true });
    await until(() => asked() > 0, 'the directory batch asked');
    engine.sync.writeFile(`${APP}/d/n`, new TextEncoder().encode('made'));
    await engine.fs.flush();
    open();
    await engine.fs.close((await opening).id);
    await engine.fs.flush();
    assert.equal(dec.decode(engine.authority.kfs.readFile('home/user/app/d/n')), 'made');
  },
});
