// A download through a port holds its session only while it streams. After
// one completes, and after a client walks away from one the server has gone
// quiet on (framed, and chunked), the session hibernates on its own with no
// traffic, and a peer host lets the process go: nothing the response owned
// (a host watch, a peer's cancel stub, a pipe) outlives it.
import { BASE, mintSession, deleteSession, Terminal, makeAsserter, requestHeaders, sleep } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

const a = makeAsserter('abandoned-download-releases-session');
const PORT = 3218, MIB = 1024 * 1024;
const SERVER = `require('http').createServer((request, response) => {
  if (request.url === '/ready') return response.end('ready');
  if (request.url === '/download') { const body = Buffer.alloc(${8 * MIB}, 97); response.writeHead(200, { 'Content-Length': String(body.length) }); return response.end(body); }
  // One chunk, then nothing more: the client is the one who leaves.
  response.writeHead(200, request.url === '/stall' ? { 'Content-Length': String(${8 * MIB}) } : {});
  response.write(Buffer.alloc(65536, 98));
}).listen(${PORT});
`;
const sessions = [], terminals = [];
async function hostLoss(sid, action, fields = {}) {
  const response = await fetch(`${BASE}/api/embedder/${sid}/host-loss`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid), body: JSON.stringify({ action, ...fields }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`host-loss ${action}: ${response.status} ${text}`);
  return JSON.parse(text);
}
const portUrl = (sid, path) => `${BASE}/s/${sid}/port/${PORT}${path}`;

async function served(label, use) {
  const sid = await mintSession(); sessions.push(sid);
  const terminal = new Terminal(sid); terminals.push(terminal);
  await terminal.connect(); await terminal.waitForPrompt(60000);
  await terminal.writeFile('/home/user/download-server.js', SERVER);
  const boot = await terminal.run('node /home/user/download-server.js', 60000);
  if (boot.exitCode !== 0) throw new Error(`${label}: ${boot.output}`);
  const pid = terminal.spawns.filter((event) => event.longRunning && event.command.includes('download-server.js')).at(-1)?.pid;
  for (const deadline = Date.now() + 60000; ;) {
    const ready = await fetch(portUrl(sid, '/ready'), { headers: requestHeaders({}, sid) });
    if (ready.status === 200 && await ready.text() === 'ready') break;
    if (Date.now() > deadline) throw new Error(`${label}: the server never answered`);
    await sleep(250);
  }
  const mode = (await hostLoss(sid, 'mode')).mode;
  const placement = mode === 'peer' ? (await hostLoss(sid, 'inspect', { pid })).placement : null;
  await use(sid);
  await terminal.close();
  const generation = (await diagMemory(sid))?.hib?.isolateGen;
  return { label, sid, mode, placement, generation };
}

async function leave(sid, path) {
  const client = new AbortController();
  const response = await fetch(portUrl(sid, path), { headers: requestHeaders({}, sid), signal: client.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  a.check(`${path}: the first chunk arrives`, first.value?.byteLength > 0, String(first.value?.byteLength));
  a.check(`${path}: the declared length is relayed`, response.headers.get('content-length') === (path === '/stall' ? String(8 * MIB) : null), response.headers.get('content-length'));
  client.abort();
}

try {
  const cases = await Promise.all([
    served('completed', async (sid) => {
      const response = await fetch(portUrl(sid, '/download'), { headers: requestHeaders({}, sid) });
      const bytes = (await response.arrayBuffer()).byteLength;
      a.check('a completed download is whole and framed', bytes === 8 * MIB && response.headers.get('content-length') === String(8 * MIB), `${bytes} ${response.headers.get('content-length')}`);
    }),
    served('left framed', (sid) => leave(sid, '/stall')),
    served('left chunked', (sid) => leave(sid, '/stall-chunked')),
  ]);
  // No traffic: the resident keepalive's client-interest window, then the
  // platform's idle eviction, both bound how long a session that owns
  // nothing stays loaded.
  for (let i = 0; i < 24; i++) await sleep(10000);
  for (const { label, sid, mode, placement, generation } of cases) {
    if (mode === 'peer') {
      const peer = await hostLoss(sid, 'placement-state', placement);
      a.check(`${label}: the hosting peer let the process go`, !peer.found && peer.residencies === 0, JSON.stringify(peer));
    }
    const next = (await diagMemory(sid))?.hib?.isolateGen;
    a.check(`${label}: the session hibernated with nothing held (${mode})`, typeof generation === 'number' && next > generation, `${generation} -> ${next}`);
  }
} finally {
  for (const terminal of terminals) await terminal.close().catch(() => {});
  for (const sid of sessions) a.check('session deleted', (await deleteSession(sid)).ok, sid);
}
process.exit(a.summary().fail ? 1 : 0);
