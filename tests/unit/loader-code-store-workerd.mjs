// @serial
// @tier slow — drives workerd.
// The Worker Loader shim's code kept in the session's store, in workerd (FAB-2):
// a Worker under `wrangler dev` loads, through its worker_loaders binding, a
// child carrying a 12 MiB module, larger than the shim's 8 MiB module cache,
// and serves through it, the module's bytes intact. The session's loader
// store is its own uid's: the session user cannot list it. A rebuild serves
// again.
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const { Nimbus } = await import('../../packages/sdk/src/index.ts');

const CONFIG = { name: 'stored', main: 'src/index.js', compatibility_date: '2026-09-26', worker_loaders: [{ binding: 'LOADER' }] };
const INDEX = (version) => `export default {
  async fetch(request, env) {
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
    const child = await env.LOADER.load({
      compatibilityDate: '2026-09-26',
      mainModule: 'child.js',
      modules: {
        'child.js': "import data from './big.bin'; export default { fetch() { const view = new Uint8Array(data); let sum = 0; for (let i = 0; i < view.length; i += 4096) sum = (sum + view[i]) % 1000003; return new Response(view.length + ' ' + sum); } }",
        'big.bin': { data: big.buffer },
      },
    });
    const answer = await (await child.getEntrypoint().fetch('http://child/')).text();
    return new Response('v${version} ' + answer);
  },
};
`;

// What the child answers: the module's length, and a sum over its bytes.
let expectedSum = 0;
for (let i = 0; i < 12 * 1024 * 1024; i += 4096) expectedSum = (expectedSum + ((i / 4096) % 251)) % 1000003;
const EXPECTED = `${12 * 1024 * 1024} ${expectedSum}`;

const until = async (what, read, ms = 180_000) => {
  for (const deadline = Date.now() + ms; ;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const probe = await startLocalProbe({ runtimes: [] });
const box = Nimbus.connect({ endpoint: probe.base, token: probe.token }).sandbox(`loader-code-store-${Date.now()}`);
try {
  await box.files.mkdir('/home/user/stored');
  await box.files.mkdir('/home/user/stored/src');
  await box.files.write('/home/user/stored/wrangler.jsonc', JSON.stringify(CONFIG));
  await box.files.write('/home/user/stored/src/index.js', INDEX(1));
  const dev = await box.startProcess('wrangler dev', { cwd: '/home/user/stored' });
  const served = async (version) => {
    let answer = '';
    await until(`build v${version} to answer`, async () => {
      const response = await fetch(`${probe.base}/s/${encodeURIComponent(box.id)}/worker/`, { headers: { Authorization: `Bearer ${probe.token}` } });
      answer = await response.text();
      return answer.startsWith(`v${version} `) || null;
    }).catch(async (error) => {
      throw new Error(`${error.message}; last answer: ${answer.slice(0, 600)}; its log: ${(await box.processes.logs(dev.pid)).text.slice(-1500)}`);
    });
    return answer;
  };
  try {
    assert.equal(await served(1), `v1 ${EXPECTED}`, 'the child serves its 12 MiB module intact');
    const listed = await box.exec('ls /.nimbus/loader-code');
    assert.notEqual(listed.exitCode, 0, `the session user cannot list the store: ${listed.stdout}${listed.stderr}`);

    await box.files.write('/home/user/stored/src/index.js', INDEX(2));
    assert.equal(await served(2), `v2 ${EXPECTED}`, 'the rebuild serves again');
    const log = (await box.processes.logs(dev.pid)).text;
    assert.doesNotMatch(log, /loader binding was retired|no longer loaded/, log.slice(-1500));
  } finally {
    await box.processes.kill(dev.pid).catch(() => {});
  }
} finally {
  await box.destroy().catch(() => {});
  await probe.stop();
}
console.log('loader-code-store-workerd: ok');
