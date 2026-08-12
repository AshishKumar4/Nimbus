#!/usr/bin/env bun
// shell/rm-recursive-large-tree — `rm -rf` of an npm-install-sized tree must
// leave the terminal alive.
//
// Pre-fix, removing Pi's installed tree (19,429 files) killed the session
// socket, twice, reproducibly: `rm -rf` issued one transaction per entry and
// every one of them resolved "what is under this path?" by scanning the whole
// inode table — ~190 million synchronous comparisons on the Durable Object's
// only thread. The object stopped answering, the WebSocket closed 1006, and
// the browser painted `[process terminal closed]`.
//
// So the assertion is the socket, not the command: the shell must still be
// there afterwards and must still produce output. A probe that only checked
// the command's exit status would go green on a dead screen.

import { deleteSession, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/rm-recursive-large-tree');
console.log(`shell/rm-recursive-large-tree — ${process.env.BASE}`);

const PROJECT = '/home/user/rm-tree';
const TREE = `${PROJECT}/node_modules`;
const PACKAGE = '@earendil-works/pi-coding-agent';
const token = Math.random().toString(36).slice(2, 10);

/**
 * Wait for `marker`, reporting a dropped socket as the dropped socket it is.
 * Returns null when the terminal died, so the probe can assert on that rather
 * than crash out of the run and skip its own cleanup.
 */
async function expect(t, marker, timeoutMs, label) {
  try {
    await t.waitFor((b) => b.includes(marker), timeoutMs, label);
    return stripAnsi(t.buf);
  } catch (error) {
    return { failure: String(error?.message ?? error), closed: t.closed, detail: t.closeDetail };
  }
}

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
let treeFiles = 0;

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const install = await t.run(
    `mkdir -p ${PROJECT} && cd ${PROJECT} && echo keep-me > sibling.txt`
    + ` && npm install --ignore-scripts ${PACKAGE}; echo INSTALLED_${token}`,
    600_000,
  );
  const installOut = stripAnsi(install.output);
  a.check('the tree under test installed',
    installOut.includes(`INSTALLED_${token}`) && !/npm install failed|command not found/i.test(installOut),
    JSON.stringify(installOut.slice(-1200)));

  const counted = await t.run(`find ${TREE} -type f | wc -l`, 300_000);
  const countMatch = stripAnsi(counted.output).match(/(\d{3,})/);
  treeFiles = countMatch ? Number(countMatch[1]) : 0;
  console.log(`tree files: ${treeFiles}`);
  a.check('the tree is npm-install sized (thousands of files)',
    treeFiles >= 5_000,
    `counted ${treeFiles}; output ${JSON.stringify(stripAnsi(counted.output).slice(-400))}`);

  // The removal itself. Not `t.run` — a dropped socket must be reported as a
  // dropped socket, not as a timeout waiting for a prompt.
  t.reset();
  t.cmd(`rm -rf ${TREE}; echo REMOVED_${token}`);
  const removal = await expect(t, `REMOVED_${token}`, 600_000, 'rm -rf to finish');
  a.check(`rm -rf of ${treeFiles} files completes with the terminal alive`,
    typeof removal === 'string',
    typeof removal === 'string' ? 'ok' : JSON.stringify(removal));

  // The socket surviving the command is the point, and a frame arriving after
  // it is the proof it survived rather than merely not having closed yet.
  a.check('the terminal socket is still open after the removal',
    !t.closed,
    `closeDetail=${t.closeDetail ?? 'none'}`);

  t.reset();
  t.cmd(`echo ALIVE_${token}`);
  const alive = await expect(t, `ALIVE_${token}`, 60_000, 'a frame after the removal');
  a.check('the shell still answers on the same socket after the removal',
    typeof alive === 'string',
    typeof alive === 'string' ? 'ok' : JSON.stringify(alive));

  t.reset();
  t.cmd(`ls ${TREE} 2>&1; echo LISTED_${token}`);
  const listed = await expect(t, `LISTED_${token}`, 60_000, 'the post-removal listing');
  a.check('the tree is actually gone',
    typeof listed === 'string' && /ENOENT|No such file|cannot access/i.test(listed),
    typeof listed === 'string' ? JSON.stringify(listed.slice(-400)) : JSON.stringify(listed));

  // The removal took the subtree and nothing beside it.
  t.reset();
  t.cmd(`cat ${PROJECT}/sibling.txt 2>&1; echo SIBLING_${token}`);
  const sibling = await expect(t, `SIBLING_${token}`, 60_000, 'the surviving sibling');
  a.check("a file beside the removed tree survives it",
    typeof sibling === 'string' && /keep-me/.test(sibling),
    typeof sibling === 'string' ? JSON.stringify(sibling.slice(-400)) : JSON.stringify(sibling));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
