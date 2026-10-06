#!/usr/bin/env bun
// An inline `node` program under a workspace egress (Kinu ask 20): every
// request it makes off the box goes out through the egress, and comes back as
// Node's fetch would give it.
//
//   (1) a response that does not end (server-sent events) is the program's
//       once its head arrives, and its body is read as it comes;
//   (2) a body the program does not read is not read for it: the egress's
//       stream is pulled as far as the program reads, and a cancel reaches it;
//   (3) a body that fails after its head fails the program's read
//       (`TypeError: terminated`), as a dropped connection does in Node;
//   (4) redirects: the program's redirect mode is honored, each hop is a
//       request of its own through the egress (as workerd's fetch follows a
//       Fetcher's), and the outcome is Node's own: the same program run by
//       host Node against the same server gives the same results for
//       'follow' (the default), 'manual' and 'error', a 303 after a POST, a
//       cross-origin hop and a redirect loop.
//
// Run by bun, it checks the source under Bun, then runs itself under node
// against the built package (packages/core/dist: rebuild first), whose
// realm is a Node worker thread.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

/** Two origins (two ports): where the redirects go, and where a cross-origin hop lands. */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const readBody = (req) => new Promise((resolve) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => resolve(body)); });
const other = await listen(async (req, res) => {
  res.end(`landed elsewhere ${req.method} auth=${req.headers.authorization ?? '-'}`);
});
const main = await listen(async (req, res) => {
  const body = await readBody(req);
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/hop') { res.writeHead(302, { location: '/landed' }); res.end('moved'); return; }
  if (path === '/post303') { res.writeHead(303, { location: '/landed' }); res.end('see other'); return; }
  if (path === '/cross') { res.writeHead(302, { location: `${other.origin}/landed` }); res.end('moved'); return; }
  if (path === '/loop') { res.writeHead(302, { location: '/loop' }); res.end('again'); return; }
  res.end(`landed ${req.method} auth=${req.headers.authorization ?? '-'} type=${req.headers['content-type'] ?? '-'} body=${body || '-'}`);
});

/** The egress: answers /sse, /big and /broken itself; anything else goes on to the network, as it was asked. */
const egress = {
  seen: [],
  pulls: 0,
  cancelled: [],
  async fetch(request) {
    const url = new URL(request.url);
    this.seen.push(`${request.method} ${url.pathname} redirect=${request.redirect}`);
    if (url.pathname === '/sse') {
      let sent = false;
      return new Response(new ReadableStream({
        pull: (controller) => {
          if (sent) return new Promise(() => {});
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
        },
        cancel: () => { this.cancelled.push('/sse'); },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === '/big') {
      return new Response(new ReadableStream({
        pull: (controller) => {
          this.pulls++;
          controller.enqueue(new Uint8Array(65536).fill(98));
          if (this.pulls === 256) controller.close();
        },
        cancel: () => { this.cancelled.push('/big'); },
      }, { highWaterMark: 0 }));
    }
    if (url.pathname === '/broken') {
      let pulled = 0;
      return new Response(new ReadableStream({
        pull: (controller) => {
          if (pulled++ === 0) controller.enqueue(new TextEncoder().encode('part'));
          else controller.error(new Error('connection reset'));
        },
      }, { highWaterMark: 0 }));
    }
    return fetch(request);
  },
  connect() { throw new Error('this egress carries no TCP'); },
};

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, egress });
const run = async (command, options = {}) => {
  const result = await ws.exec(command, { cwd: '/home/user', ...options });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
/** `source` as an inline node program, ended after 20 s if it is still running. */
const runProgram = async (name, source) => {
  await ws.fs.writeFile(`/home/user/${name}`, source);
  return await run(`node ${name}`, { signal: AbortSignal.timeout(20_000) });
};

try {
  // ── (1) a response that does not end ──────────────────────────────────────
  {
    const r = await runProgram('sse.mjs', `
      const response = await fetch(${JSON.stringify(main.origin + '/sse')});
      console.log('head', response.status, response.headers.get('content-type'));
      const reader = response.body.getReader();
      const { value } = await reader.read();
      console.log('event', JSON.stringify(new TextDecoder().decode(value)));
      await reader.cancel();
      console.log('cancelled');
    `);
    assert.equal(r.out, 'head 200 text/event-stream\nevent "data: 1\\n\\n"\ncancelled\n', `(1) the head arrives before the body ends, and the body as it comes: ${r.err}`);
    assert.equal(r.code, 0, r.err);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(egress.cancelled, ['/sse'], "(1) the program's cancel reached the egress's stream");
  }

  // ── (2) a body the program does not read is not read for it ───────────────
  {
    const r = await runProgram('big.mjs', `
      const response = await fetch(${JSON.stringify(main.origin + '/big')});
      const reader = response.body.getReader();
      const { value } = await reader.read();
      console.log('first', value.length);
      await reader.cancel();
    `);
    assert.equal(r.out, 'first 65536\n', r.err);
    assert.ok(egress.pulls <= 3, `(2) the egress's 16 MiB body was read as far as the program read it, not whole (${egress.pulls} of 256 chunks)`);
    assert.ok(egress.cancelled.includes('/big'), '(2) and the rest was cancelled');
  }

  // ── (3) a body that fails after its head ──────────────────────────────────
  {
    const r = await runProgram('broken.mjs', `
      const response = await fetch(${JSON.stringify(main.origin + '/broken')});
      console.log('status', response.status);
      const reader = response.body.getReader();
      console.log('chunk', new TextDecoder().decode((await reader.read()).value));
      try { await reader.read(); console.log('no error'); }
      catch (error) { console.log(error.name + ': ' + error.message + ' (' + error.cause?.message + ')'); }
    `);
    assert.equal(r.out, 'status 200\nchunk part\nTypeError: terminated (connection reset)\n', `(3) ${r.err}`);
  }

  // ── (4) redirects, as host Node follows them ──────────────────────────────
  {
    const program = `
      const base = ${JSON.stringify(main.origin)};
      const outcome = async (path, init) => {
        try {
          const r = await fetch(base + path, init);
          return { status: r.status, url: r.url, redirected: r.redirected, body: await r.text() };
        } catch (error) {
          return { error: error.name + ': ' + error.message, cause: error.cause?.message };
        }
      };
      const results = { default: await outcome('/hop') };
      for (const redirect of ['follow', 'manual', 'error']) {
        results['hop ' + redirect] = await outcome('/hop', { redirect });
        results['post303 ' + redirect] = await outcome('/post303', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' }, redirect });
        results['cross ' + redirect] = await outcome('/cross', { headers: { authorization: 'Bearer t' }, redirect });
      }
      results.loop = await outcome('/loop');
      console.log(JSON.stringify(results));
    `;
    // Spawned, not spawnSync: the servers answering it run in this process.
    const node = await new Promise((resolve, reject) => {
      const child = spawn('node', ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('error', reject);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(node.status, 0, node.stderr);
    const expected = JSON.parse(node.stdout);
    // What host Node gives, stated, so the comparison below is not vacuous.
    assert.equal(expected.default.body, 'landed GET auth=- type=- body=-');
    assert.equal(expected['hop manual'].status, 302);
    assert.equal(expected['hop error'].cause, 'unexpected redirect');
    assert.equal(expected['cross follow'].body, 'landed elsewhere GET auth=-');
    assert.equal(expected.loop.cause, 'redirect count exceeded');

    egress.seen.length = 0;
    const r = await runProgram('redirects.mjs', program);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), expected, '(4) the inline program sees what host Node sees');
    assert.deepEqual(egress.seen.slice(0, 2), ['GET /hop redirect=manual', 'GET /landed redirect=manual'],
      '(4) each hop is a request of its own through the egress');
  }
} finally {
  main.server.close();
  other.server.close();
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - workspace-egress-inline-node (streamed responses, unread bodies left unread, body errors, redirects as Node; under Bun and Node)');
} else {
  console.log('ok - under node');
}
