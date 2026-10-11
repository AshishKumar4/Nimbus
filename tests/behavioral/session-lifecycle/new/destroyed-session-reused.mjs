// session-lifecycle/new/destroyed-session-reused — a session id used again
// after its DELETE comes up whole: its terminal attaches, and its files can
// be written and read.
//
// A destroy closes the session's filesystem and the next use opens a new one.
// Measured on main 117df4482 (BusyVicuna, b6c57bdf3, verdict
// 20261011T003910-b6c57bdf3810-20261011003834-b926c5d9): after a DELETE the
// same id's files.write answered 500 "The workspace filesystem must be over
// the workspace SqliteVFS" and its terminal socket was refused, because the
// namespace authority the destroyed session had built outlived the destroy,
// over the old engine.

import { BASE, AUTH_TOKEN, Terminal, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { Nimbus } from '../../../../packages/sdk/dist/sandbox.js';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'session-lifecycle/new/destroyed-session-reused';
const a = makeAsserter(label);
console.log(`${label} — BASE=${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const sandbox = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(sid);
try {
  const first = new Terminal(sid);
  await first.connect();
  await first.waitForPrompt(30_000);
  await sandbox.files.write('/home/user/before.txt', 'before');
  await first.close();

  const deleted = await deleteSession(sid, 'destroyed-session-reused');
  a.check('the session is deleted', deleted.ok, deleted.body);

  // The id used again: its terminal attaches, which brings the new session up.
  const again = new Terminal(sid);
  const attached = await again.connect().then(() => null, (error) => error.message);
  a.check('its terminal attaches again', attached === null, attached);
  if (attached === null) {
    await again.waitForPrompt(30_000);
    const wrote = await sandbox.files.write('/home/user/after.txt', 'written-after-delete').then(() => null, (error) => error.message);
    a.check('a write to the same id after its DELETE succeeds', wrote === null, wrote);
    const read = await sandbox.files.read('/home/user/after.txt').then((text) => String(text), (error) => `error: ${error.message}`);
    a.check('and reads back', read === 'written-after-delete', read);
    const gone = await sandbox.files.read('/home/user/before.txt').then((text) => text, (error) => `error: ${error.message}`);
    a.check('what was written before the DELETE is gone', gone === null, String(gone));
    const ran = await again.run('cat /home/user/after.txt; echo EXIT=$?', 15_000);
    a.check('and the terminal sees the new session\'s files', /^written-after-delete/m.test(ran.output) && ran.output.includes('EXIT=0'), ran.output.slice(-300));
    await again.close();
  }
} finally {
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail > 0 ? 1 : 0);
