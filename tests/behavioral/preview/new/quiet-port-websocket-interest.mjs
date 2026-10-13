import WebSocket from 'ws';
import { BASE, mintSession, deleteSession, Terminal, makeAsserter, requestHeaders, wsHeaders, sleep } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

const a = makeAsserter('quiet-port-websocket-interest'), sid = await mintSession();
const terminal = new Terminal(sid);
let socket;
try {
  await terminal.connect(); await terminal.waitForPrompt(60000);
  const response = await fetch(`${BASE}/api/embedder/${sid}/quiet-websocket`, { method: 'POST', headers: requestHeaders({}, sid) });
  if (!response.ok) throw new Error(await response.text());
  const spawned = await response.json(), messages = [];
  socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/s/${sid}/port/${spawned.port}/`, wsHeaders(sid));
  let error;
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  socket.on('error', value => { error = value.message; });
  const until = async (predicate, what) => {
    for (const deadline = Date.now() + 15000; !predicate();) {
      if (error || Date.now() > deadline) throw new Error(error ?? what);
      await sleep(50);
    }
  };
  await until(() => messages.length > 0, 'the socket greeting');
  const before = (await diagMemory(sid))?.hib?.isolateGen;
  await terminal.close();
  for (let i = 0; i < 15; i++) await sleep(10000);
  a.check('a quiet routed preview socket remains open beyond the client traffic bound', socket.readyState === WebSocket.OPEN);
  const count = messages.length; socket.send('same process');
  await until(() => messages.length > count, 'the same server after quiet interest');
  a.check('quiet preview interest preserves the process boot nonce', messages.at(-1).nonce === spawned.boot.nonce, JSON.stringify(messages));
  const active = (await diagMemory(sid))?.hib?.isolateGen;
  a.check('quiet preview interest preserves its coordinator incarnation', typeof before === 'number' && active === before, `${before} -> ${active}`);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close(4001, 'preview closed'); await closed;
  for (let i = 0; i < 15; i++) await sleep(10000);
  const after = (await diagMemory(sid))?.hib?.isolateGen;
  a.check('closing the preview releases its bounded idle grace for hibernation', typeof active === 'number' && after > active, `${active} -> ${after}`);
} finally {
  socket?.close(); await terminal.close().catch(() => {});
  a.check('session deleted', (await deleteSession(sid)).ok);
}
process.exit(a.summary().fail ? 1 : 0);
