// @serial
// @tier slow — drives a local workerd
// A D1 binding under Nimbus's `wrangler dev` is a database of its own, as on
// Cloudflare: its migrations run there and nowhere else. The session's own
// tables (its scrollback, its storage ledger, its filesystem) are not in it,
// so a migration that names one fails as it would on a fresh D1 database
// ("no such table") and changes nothing of the session's. And each migration
// applies whole or not at all, as `wrangler d1 migrations apply` does: one
// that fails is rolled back, not recorded, and ends the run; the next
// `wrangler dev` tries it again.
//
// Through the real path: apps/probe on the real workerd (lib/workerd-probe.mjs),
// a session whose terminal runs `wrangler dev` in a project with a
// d1_databases binding and a migrations_dir.
//
// Red before: the binding ran its statements in the session's own SQLite,
// and a table name it had not created passed through unchanged, so the
// migration deleted the session's scrollback (a reconnecting terminal
// showed none of its history); and a failed statement left the rest of its
// migration applied and the migration recorded.
//
// Runs the worker built in the tree: rebuild the generated artifacts before
// testing a change (dist-integrity).

import assert from 'node:assert/strict';

import { startLocalProbe } from './lib/workerd-probe.mjs';

const WORKER = 'export default { fetch() { return new Response("ok"); } };\n';
const CONFIG = {
  name: 'd1-isolation',
  main: 'src/index.js',
  compatibility_date: '2026-09-26',
  d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'local-app', migrations_dir: 'migrations' }],
};
const MIGRATIONS = {
  '0001_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n',
  // A table of its own first, then the session's: the migration is one whole.
  '0002_reach.sql': 'CREATE TABLE partial (x INTEGER);\nDELETE FROM nimbus_terminal_scrollback;\nDELETE FROM nimbus_storage_ledger;\n',
};

console.log('wrangler-dev-d1-isolation-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal, requestHeaders, stripAnsi } = await import('../behavioral/_driver.mjs');
const sid = await mintSession();
let terminal = new Terminal(sid);
// Every check, so a red run shows each way it went wrong.
const failed = [];
const check = (ok, what, detail) => { if (!ok) failed.push(`${what}\n    ${detail}`); };
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const marker = `history-${Date.now().toString(36)}`;
  // The line as the command prints it, not as it is typed (a quote splits the typed one).
  await terminal.run(`echo ${marker.slice(0, 8)}''${marker.slice(8)}`, 10_000);
  await terminal.run('mkdir -p /home/user/d1-app/src /home/user/d1-app/migrations', 10_000);
  const write = async (path, content) => {
    const response = await fetch(`${probe.base}/s/${sid}/api/write-file`, {
      method: 'POST',
      headers: requestHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path, content }),
    });
    assert.equal(response.status, 200, `write ${path}: ${await response.text()}`);
  };
  await write('/home/user/d1-app/wrangler.jsonc', JSON.stringify(CONFIG));
  await write('/home/user/d1-app/src/index.js', WORKER);
  for (const [name, sql] of Object.entries(MIGRATIONS)) await write(`/home/user/d1-app/migrations/${name}`, sql);
  await terminal.run('cd /home/user/d1-app', 10_000);

  /** `wrangler dev` until it has built and its migrations have had time to run; then stopped. Answers what it wrote. */
  const devOnce = async () => {
    terminal.reset();
    terminal.cmd('wrangler dev');
    await terminal.waitFor((b) => /Worker built|\x1b\[31m/.test(b), 120_000, 'wrangler dev build');
    // The migrations run beside the build; their lines come after it.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const out = stripAnsi(terminal.buf);
    terminal.send('\x03');
    await terminal.waitForPrompt(30_000);
    return out;
  };

  const tail = (text) => JSON.stringify(text.split('\n').filter((line) => /D1|migration|warning|error/i.test(line)).slice(-6));
  const first = await devOnce();
  check(/D1 DB: applied 1 migrations/.test(first), "the binding's own migration applies, and only it", tail(first));
  check(/migration 0002_reach\.sql failed and was rolled back: no such table: nimbus_terminal_scrollback/.test(first), "the session's tables are not in the binding's database", tail(first));

  // Rolled back and unrecorded: tried again, and its own table is not there from the first try.
  const second = await devOnce();
  check(!/applied \d+ migrations/.test(second), 'what was applied is recorded, and nothing else is applied', tail(second));
  check(/migration 0002_reach\.sql failed and was rolled back: no such table: nimbus_terminal_scrollback/.test(second), 'the failed migration is tried again, whole', tail(second));

  // The session's scrollback is the session's: a terminal that reconnects is shown its history.
  await terminal.close();
  terminal = new Terminal(sid);
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const history = stripAnsi(terminal.buf);
  check(new RegExp(`(^|\\n)${marker}\\r?\\n`).test(history), "the session's history survives the migrations", JSON.stringify(history.slice(-600)));
  assert.deepEqual(failed, []);
} finally {
  await terminal.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  await probe.stop();
}
console.log('wrangler-dev-d1-isolation-workerd: a D1 binding is a database of its own; its migrations apply whole');
