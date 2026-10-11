// Inline node reaches a real WebSocket server only through its host's egress.fetch.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';


const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = createRequire(require.resolve('wrangler/package.json'))('ws');
const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.on('listening', resolve));
const headers = [];
server.on('connection', (socket, request) => {
  headers.push(request.headers['x-review'] ?? null);
  socket.on('message', (data, binary) => socket.send(data, { binary }));
});
const seen = [];
const egress = {
  async fetch(request) {
    const url = new URL(request.url);
    seen.push([request.method, url.protocol, request.headers.get('upgrade'), request.headers.get('sec-websocket-protocol')]);
    if (url.pathname === '/denied') return new Response('denied by egress', { status: 403 });
    const socket = new WebSocket('ws://127.0.0.1:' + server.address().port, request.headers.get('sec-websocket-protocol')?.split(',').map((p) => p.trim()) ?? [], { headers: Object.fromEntries(request.headers) });
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const endpoint = {
      accept() {},
      get protocol() { return socket.protocol; },
      set binaryType(value) { socket.binaryType = value; },
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      addEventListener: (...args) => socket.addEventListener(...args),
      removeEventListener: (...args) => socket.removeEventListener(...args),
    };
    return { status: 101, webSocket: endpoint, headers: new Headers({ 'sec-websocket-protocol': socket.protocol }) };
  },
  connect() { throw new Error('the inline program bypassed egress.fetch'); },
};
const { sql, transactions } = await hostSqlite();
const workspace = await NimbusWorkspace.create({ sql, transactions, generation: 1, egress });
const run = async (source) => {
  await workspace.fs.writeFile('/home/user/socket.mjs', source);
  return workspace.exec('node socket.mjs', { cwd: '/home/user', signal: AbortSignal.timeout(20000) });
};
try {
  const opened = await run(`
    const socket = new WebSocket('wss://egress.invalid/echo', ['chat']);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      socket.onerror = (event) => reject(new Error(event.message ?? event.error?.message));
      socket.onopen = () => { console.log('open', socket.protocol, socket.readyState); socket.send('text'); };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') { console.log('text', event.data); socket.send(new Uint8Array([0, 128, 255])); }
        else { console.log('bytes', [...new Uint8Array(event.data)].join(',')); socket.close(4000, 'done'); }
      };
      socket.onclose = (event) => { console.log('close', event.code, event.reason, event.wasClean); resolve(); };
    });
  `);
  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(opened.stdout, 'open chat 1\ntext text\nbytes 0,128,255\nclose 4000 done true\n');
  assert.deepEqual(seen, [['GET', 'https:', 'websocket', 'chat']]);
  const refused = await run(`
    const socket = new WebSocket('wss://egress.invalid/denied');
    await new Promise((resolve) => {
      socket.onerror = (event) => console.log('refused', event.message ?? event.error?.message);
      socket.onclose = resolve;
    });
  `);
  assert.equal(refused.exitCode, 0, refused.stderr);
  assert.match(refused.stdout, /refused .*403/);
  const fixture = readFileSync(new URL('./lib/inline-websocket-arguments.mjs', import.meta.url), 'utf8').replace('export async function', 'async function');
  const base = 'ws://127.0.0.1:' + server.address().port;
  const expected = await new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', fixture + `\nconsole.log(JSON.stringify(await inlineWebSocketArguments(${JSON.stringify(base)})));`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (part) => { out += part; }); child.stderr.on('data', (part) => { err += part; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)); });
  });
  const actual = await run(fixture + `\nconsole.log(JSON.stringify(await inlineWebSocketArguments('wss://egress.invalid')));`);
  assert.equal(actual.exitCode, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), expected, 'every argument form uses Node conversions');
  assert.deepEqual(headers.slice(-2), ['yes', 'yes'], 'Node WebSocketInit headers reached the egress server');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60000 });
  assert.equal(node.status, 0, node.stdout + node.stderr);
}
console.log('workspace-egress-inline-websocket: text, bytes, protocol, close and refusal through egress.fetch');
