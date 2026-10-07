#!/usr/bin/env bun
// wrangler-config-jsonc — every Nimbus reader of a wrangler.jsonc reads it
// as wrangler does (jsonc-parser, trailing commas allowed): `nimbus wrangler
// dev`, its unsupported-binding warning, and the deploy-isolation gate. A
// config one of them accepts, the others accept, with the same values.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWrangler } from '../../packages/worker/src/wrangler/nimbus-wrangler.ts';
import { detectUnsupportedWranglerConfig } from '../../packages/worker/src/session/helpers.ts';
import { loadConfig } from '../../scripts/deploy-isolation.mjs';

const ROOT = '/home/user/app';

/** The three readers' views of one wrangler.jsonc: dev's config, dev's warning, and the deploy gate's config. */
async function read(text) {
  const logs = [];
  const files = new Map([[`${ROOT}/wrangler.jsonc`, text]]);
  const wrangler = new NimbusWrangler({
    vfs: { exists: (path) => files.has(`/${path}`), readFileString: (path) => files.get(`/${path}`) },
    vfsEvents: { on: () => {} },
    esbuild: {},
    env: {},
    ctx: {},
    root: ROOT,
    onLog: (line) => logs.push(line),
  });
  const devRead = wrangler._readConfigForTest();
  const unsupported = await detectUnsupportedWranglerConfig({
    stat: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { type: 'file' };
    },
    readFile: async (path) => new TextEncoder().encode(files.get(path)),
  }, ROOT);
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-config-jsonc-'));
  let deploy;
  try {
    writeFileSync(join(dir, 'wrangler.jsonc'), text);
    deploy = loadConfig('wrangler.jsonc', dir);
  } catch (error) {
    deploy = error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { dev: devRead ? wrangler.config : null, logs, unsupported, deploy };
}

// Comments, a trailing comma, and comment and comma text inside strings.
{
  const config = await read(`{
  // the Worker
  "name": "app",
  "main": "src/index.ts", /* its entry */
  "vars": {
    "NOTE": "a, } // not a comment /* nor this */",
  },
  "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" },] },
}
`);
  const expected = {
    name: 'app',
    main: 'src/index.ts',
    vars: { NOTE: 'a, } // not a comment /* nor this */' },
    queues: { producers: [{ binding: 'JOBS', queue: 'jobs' }] },
  };
  assert.deepEqual(config.dev, expected, `nimbus wrangler dev read it (${config.logs.join('')})`);
  assert.deepEqual(config.unsupported, ['queues']);
  assert.deepEqual(config.deploy, expected);
}

// Text that is not JSONC, or JSONC that is not an object: every reader refuses it.
for (const text of ['{ "name": "app" "main": "src/index.ts" }', '[]', 'null']) {
  const config = await read(text);
  assert.equal(config.dev, null, text);
  assert.match(config.logs.join(''), /could not parse .*wrangler\.jsonc/, text);
  assert.deepEqual(config.unsupported, [], text);
  assert.ok(config.deploy instanceof Error, `the deploy gate refuses ${text}`);
}

console.log('wrangler-config-jsonc: ok');
