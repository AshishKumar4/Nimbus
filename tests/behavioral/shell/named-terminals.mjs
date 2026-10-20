#!/usr/bin/env bun
// shell/named-terminals — a session's browser terminals by name (Kinu asks
// 64 and 56), on the session's own route: `/ws?terminal=<name>`.
//
// Two names at once are two shells (their own cwd), each beside the
// session's own terminal; a second socket on a name is refused while the
// first holds it; a reattach replays the name's screen and finds its shell
// where it was; the SDK lists them and closes one, after which the other
// runs on and the closed name starts over.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('shell/named-terminals');
console.log(`shell/named-terminals — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const opened = [];
const open = async (terminal) => {
  const t = new Terminal(sid, terminal === undefined ? {} : { terminal });
  opened.push(t);
  await t.connect(30_000);
  await t.waitForPrompt(60_000);
  return t;
};
const answer = async (t, line) => stripAnsi((await t.run(line, 30_000)).output);

try {
  const own = await open(undefined);
  const ta = await open('a');
  await answer(ta, 'cd /tmp');
  const tb = await open('b');
  await answer(tb, 'mkdir -p ~/bdir && cd ~/bdir && echo b-was-here');
  a.check('two names and the session\'s own terminal are open at once', ta.connected && tb.connected && own.connected, '');
  a.check('a is where a went', /\n\/tmp\r?\n/.test(await answer(ta, 'pwd')), '');
  a.check('b is where b went', /\/home\/user\/bdir\r?\n/.test(await answer(tb, 'pwd')), '');
  a.check('the session\'s own terminal is where it was', /\/home\/user\r?\n/.test(await answer(own, 'pwd')), '');

  let refused = false;
  try { await open('a'); } catch { refused = true; }
  a.check('a second live socket on a name is refused', refused, '');

  const listed = await box.terminals.list();
  a.check('the SDK lists the session\'s own and both names, with their cwds',
    JSON.stringify(listed.map((t) => [t.name, t.cwd])) === JSON.stringify([[null, '/home/user'], ['a', '/tmp'], ['b', '/home/user/bdir']]),
    JSON.stringify(listed));

  await tb.close();
  const tb2 = await open('b');
  a.check('a reattach replays the name\'s own screen', tb2.stream.includes('b-was-here'), '');
  a.check('and finds its shell where it was', /\/home\/user\/bdir\r?\n/.test(await answer(tb2, 'pwd')), '');

  const closed = await box.terminals.close('a');
  a.check('closing a name answers it closed', closed.closed === true, JSON.stringify(closed));
  const after = await box.terminals.list();
  a.check('it is gone from the list, b is not', JSON.stringify(after.map((t) => t.name)) === JSON.stringify([null, 'b']), JSON.stringify(after));
  const ta2 = await open('a');
  a.check('a closed name starts over', /\/home\/user\r?\n/.test(await answer(ta2, 'pwd')), '');
  a.check('b runs on', /\/home\/user\/bdir\r?\n/.test(await answer(tb2, 'pwd')), '');
} finally {
  for (const t of opened) await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
