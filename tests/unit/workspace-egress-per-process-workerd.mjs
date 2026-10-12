// @serial
// @tier slow — drives workerd twice (facet and peer hosting).
// An egress per process (Kinu ask 45): each process's fetch, sockets, TLS,
// commands and Dynamic Worker go out through the egress its host minted for
// it (NimbusSession.egressFor), so the embedder knows which exec made each.
// The probe's test egress answers /who, TCP port 9 and TLS /who with the exec
// it was minted for ('-' for a process no exec named); a path like /who.git
// is refused with that text, which git shows as `remote:`; any path under /who/ is
// recorded with its exec, and /who-seen lists them. Covered: programs (fetch,
// net, tls), curl, git, a Worker under wrangler dev and a Worker
// it loads, a one-shot opencode, and a session destroyed and made again in
// the same instance. Run under the facet host and under the peer host
// (NIMBUS_PROCESS_HOST=peer), where a resident runs in a sibling session and
// its egress crosses to it.
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const { Nimbus } = await import('../../packages/sdk/src/index.ts');

// What a program sees of its egress: its fetch, a plain socket, a TLS socket.
const WHO = String.raw`
const net = require('net'), tls = require('tls');
const read = (open) => new Promise((resolve) => {
  const socket = open();
  let body = '';
  socket.setEncoding('utf8');
  socket.on('data', (part) => { body += part; });
  socket.on('close', () => resolve(body.trim()));
  socket.on('error', (error) => resolve('error ' + error.message));
});
module.exports = async () => [
  'fetch ' + (await (await fetch('http://egress-test.invalid/who')).text()).trim(),
  'tcp ' + await read(() => net.connect(9, 'egress-test.invalid')),
  'tls ' + await read(() => {
    const socket = tls.connect(443, 'egress-test.invalid', () => socket.write('GET /who HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n'));
    return socket;
  }),
];
`;
const ONCE = `require('./who.js')().then((lines) => console.log(lines.join('\\n')));`;
// A resident: it says what it saw, then serves, so its host keeps it.
const SERVE = `require('./who.js')().then((lines) => {
  console.log(lines.join('\\n'));
  require('http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]));
});`;

// A Worker under wrangler dev that answers what its own fetch and a Worker it loads (worker_loaders) each see.
const NESTED_CONFIG = { name: 'nested', main: 'src/index.js', compatibility_date: '2026-09-26', worker_loaders: [{ binding: 'LOADER' }] };
const NESTED = `export default {
  async fetch(request, env) {
    const outer = (await (await fetch('http://egress-test.invalid/who')).text()).trim();
    const child = env.LOADER.load({
      compatibilityDate: '2026-09-26',
      mainModule: 'child.js',
      modules: { 'child.js': "export default { fetch() { return fetch('http://egress-test.invalid/who'); } }" },
    });
    const nested = (await (await child.getEntrypoint().fetch('http://child/')).text()).trim();
    return new Response('outer ' + outer + '\\nnested ' + nested);
  },
};
`;

const sees = (text, execId) => {
  assert.match(text, new RegExp(`^fetch via-egress who ${execId}$`, 'm'), text);
  assert.match(text, new RegExp(`^tcp via-egress-tcp who ${execId}$`, 'm'), text);
  assert.match(text, new RegExp(`^tls via-egress-tls who ${execId}$`, 'm'), text);
};

const until = async (what, read, ms = 60_000) => {
  for (const deadline = Date.now() + ms; ;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

for (const host of ['facet', 'peer']) {
  const probe = await startLocalProbe({
    runtimes: [],
    vars: { NIMBUS_TEST_EGRESS: '1', NIMBUS_TEST_EGRESS_TLS: '1', NIMBUS_TEST_EGRESS_PER_PROCESS: '1', NIMBUS_PROCESS_HOST: host, NIMBUS_DEBUG: '1' },
  });
  const box = Nimbus.connect({ endpoint: probe.base, token: probe.token }).sandbox(`egress-per-process-${host}-${Date.now()}`);
  try {
    await box.files.mkdir('/home/user/who');
    await box.files.write('/home/user/who/who.js', WHO);
    await box.files.write('/home/user/who/once.js', ONCE);
    await box.files.write('/home/user/who/serve.js', SERVE);

    // A resident, here or on a peer.
    const resident = await box.startProcess('node serve.js 8971', { cwd: '/home/user/who', execId: `job-resident-${host}` });
    const log = await until('the resident to report', async () => {
      const text = (await box.processes.logs(resident.pid)).text;
      return /tls /.test(text) ? text : null;
    });
    sees(log, `job-resident-${host}`);
    if (host === 'peer') assert.match(log, /\[nimbus-debug\] process hosted on peer '/, log);
    await box.processes.kill(resident.pid).catch(() => {});

    if (host === 'facet') {
      // Two programs from two execs, and one no exec named.
      for (const execId of ['job-a', 'job-b']) {
        const ran = await box.exec('node once.js', { cwd: '/home/user/who', execId });
        assert.equal(ran.exitCode, 0, ran.stdout + ran.stderr);
        sees(ran.stdout, execId);
      }
      const unnamed = await box.exec('node once.js', { cwd: '/home/user/who' });
      sees(unnamed.stdout, '-');
      // A builtin command, and git, through the exec's egress.
      const curl = await box.exec('curl -s http://egress-test.invalid/who', { execId: 'job-curl' });
      assert.equal(curl.stdout.trim(), 'via-egress who job-curl', curl.stdout + curl.stderr);
      const git = await box.exec('git clone http://egress-test.invalid/who.git /home/user/who-repo', { execId: 'job-git' });
      assert.match(git.stderr, /remote: via-egress who job-git/, git.stdout + git.stderr);

      // Each case below is checked on its own; every failure is reported at the end.
      const failures = [];
      const check = async (what, run) => { try { await run(); } catch (error) { failures.push(`${what}: ${error.message}`); } };

      // A Worker wrangler dev serves, and a Worker it loads, through the egress of the exec that started it.
      await check('a Worker under wrangler dev, and one it loads', async () => {
        await box.files.mkdir('/home/user/nested');
        await box.files.mkdir('/home/user/nested/src');
        await box.files.write('/home/user/nested/wrangler.jsonc', JSON.stringify(NESTED_CONFIG));
        await box.files.write('/home/user/nested/src/index.js', NESTED);
        const dev = await box.startProcess('wrangler dev', { cwd: '/home/user/nested', execId: 'job-wrangler' });
        try {
          // It builds on its first request; until then the route answers that it is not ready.
          let answer = '';
          await until('the Worker to answer', async () => {
            const served = await fetch(`${probe.base}/s/${encodeURIComponent(box.id)}/worker/`, { headers: { Authorization: `Bearer ${probe.token}` } });
            answer = await served.text();
            return /^outer /.test(answer) || null;
          }, 180_000).catch(async (error) => {
            throw new Error(`${error.message}; last answer: ${answer.slice(0, 600)}; its log: ${(await box.processes.logs(dev.pid)).text.slice(-1200)}`);
          });
          assert.equal(answer, 'outer via-egress who job-wrangler\nnested via-egress who job-wrangler', answer.slice(0, 1200));
        } finally {
          await box.processes.kill(dev.pid).catch(() => {});
        }
      });

      // opencode run once (a staged one-shot): its models request, through its exec's egress.
      await check('a one-shot opencode', async () => {
        const install = await box.exec('npm install -g opencode-ai', { execId: 'job-install' });
        assert.equal(install.exitCode, 0, install.stdout + install.stderr);
        const models = await box.exec('OPENCODE_MODELS_URL=http://egress-test.invalid/who opencode models', { execId: 'job-opencode' });
        const seen = await box.exec('curl -s http://egress-test.invalid/who-seen', { execId: 'job-seen' });
        assert.match(seen.stdout, /^api\.json job-opencode$/m, `seen: ${seen.stdout}; opencode: ${(models.stdout + models.stderr).slice(-1500)}`);
      });

      // Destroyed and made again under the same id, in the same instance: its processes are the new table's.
      await check('a session destroyed and made again', async () => {
        await box.destroy();
        const again = await box.exec('curl -s http://egress-test.invalid/who', { execId: 'job-again' });
        assert.equal(again.stdout.trim(), 'via-egress who job-again', again.stdout + again.stderr);
        await box.files.mkdir('/home/user/who');
        await box.files.write('/home/user/who/who.js', WHO);
        await box.files.write('/home/user/who/once.js', ONCE);
        const program = await box.exec('node once.js', { cwd: '/home/user/who', execId: 'job-again-node' });
        assert.equal(program.exitCode, 0, program.stdout + program.stderr);
        sees(program.stdout, 'job-again-node');
      });
      assert.deepEqual(failures, []);
    }
  } finally {
    await box.destroy().catch(() => {});
    await probe.stop();
  }
}
