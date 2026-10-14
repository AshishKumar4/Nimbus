// @serial
// @tier slow — drives a local workerd
// The staged OpenTUI parser answers in a real facet. A Durable Object facet
// of a Worker Loader worker, as the attached opencode facet is (its compat
// date and flags), hosts the parser through the runner's own Worker polyfill
// (WORKER_POLYFILL_SRC) on the facet's one thread, where workerd's
// worker_threads says main: OpenTUI's GET_PERFORMANCE gets its
// PERFORMANCE_RESPONSE.
//
// And a bare "fs/promises", as the parser imports it, is the module map's
// `node:fs/promises` (the facet's bridge to the session's filesystem, as
// opencodeBuiltinBridgeModules names it), not workerd's own: the parser's data
// cache is the session's. Proved on a member of the same map that imports it
// so.
//
// Red before: the staged parser read workerd's isMainThread (true) and never
// answered.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_POLYFILL_SRC } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { OPENCODE_ARTIFACT_VERSION, OPENCODE_TUI_PARSER_WORKER } from '../../packages/worker/src/opencode-artifact.generated.ts';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '../../packages/core/src/constants.ts';

const parser = readFileSync(new URL(`../../packages/worker/public/_assets/opencode/${OPENCODE_ARTIFACT_VERSION}/${OPENCODE_TUI_PARSER_WORKER}`, import.meta.url), 'utf8');
const LEAF_MAIN = `
import { DurableObject } from 'cloudflare:workers';
${WORKER_POLYFILL_SRC}
export class Leaf extends DurableObject {
  async run() {
    const answers = [];
    const worker = new Worker('./${OPENCODE_TUI_PARSER_WORKER}');
    worker.onmessage = (event) => answers.push(event.data);
    worker.onerror = (event) => answers.push({ error: String(event.message) });
    worker.postMessage({ type: 'GET_PERFORMANCE', messageId: 1 });
    for (let i = 0; i < 500 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const { isMainThread } = await import('node:worker_threads');
    const { bridged } = await import('fs-probe.js');
    return { answers, isMainThread, bridged };
  }
}
`;
const LEAF = {
  compatibilityDate: CF_COMPAT_DATE,
  compatibilityFlags: [...GUEST_COMPAT_FLAGS],
  mainModule: 'leaf.js',
  modules: {
    'leaf.js': LEAF_MAIN,
    [OPENCODE_TUI_PARSER_WORKER]: parser,
    // The map's bridge, as the facet's: names the parser imports, marked.
    'node:fs/promises': { js: 'const bridge = (name) => Object.assign(async () => undefined, { bridge: name });\nexport const mkdir = bridge("mkdir");\nexport const readFile = bridge("readFile");\nexport const writeFile = bridge("writeFile");\nexport default { mkdir, readFile, writeFile };\n' },
    'fs-probe.js': 'import { readFile } from "fs/promises";\nexport const bridged = readFile.bridge === "readFile";\n',
  },
};
const MAIN = `
import { DurableObject } from 'cloudflare:workers';
const LEAF = ${JSON.stringify(LEAF)};
export class Host extends DurableObject {
  async run() {
    const leaf = this.env.LOADER.get('opencode-parser-v1', () => LEAF).getDurableObjectClass('Leaf');
    return this.ctx.facets.get('opencode', async () => ({ class: leaf })).run();
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/ready') return new Response('ok');
    try {
      return Response.json(await env.HOST.get(env.HOST.idFromName('one')).run());
    } catch (error) {
      return Response.json({ failed: String(error?.stack ?? error) });
    }
  },
};
`;

async function freePort() {
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  return port;
}

const require = createRequire(import.meta.url);
const workerd = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const dir = mkdtempSync(join(tmpdir(), 'opencode-parser-facet-'));
writeFileSync(join(dir, 'main.js'), MAIN);
const port = await freePort();
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "${CF_COMPAT_DATE}",
      durableObjectNamespaces = [(className = "Host", uniqueKey = "opencode-parser-facet", enableSql = true)],
      durableObjectStorage = (inMemory = void),
      bindings = [
        (name = "HOST", durableObjectNamespace = "Host"),
        (name = "LOADER", workerLoader = ()),
      ],
    )),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`);
const child = spawn(workerd, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
try {
  for (const until = Date.now() + 30_000; ;) {
    try { await fetch(`http://127.0.0.1:${port}/ready`); break; } catch {}
    if (child.exitCode !== null || Date.now() > until) throw new Error(`workerd did not start:\n${logs}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const result = await (await fetch(`http://127.0.0.1:${port}/run`)).json();
  assert.equal(result.failed, undefined, `the facet runs: ${result.failed}\n${logs.slice(-2000)}`);
  assert.equal(result.isMainThread, true, "the facet's own thread is workerd's main thread");
  assert.equal(result.answers[0]?.type, 'PERFORMANCE_RESPONSE', `the parser answers GET_PERFORMANCE within 5 s (answers: ${JSON.stringify(result.answers)})\n${logs.slice(-2000)}`);
  assert.equal(result.answers[0].messageId, 1);
  assert.equal(result.bridged, true, 'a bare "fs/promises" is the map\'s node:fs/promises');
  console.log('opencode-parser-facet-workerd: ok');
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
