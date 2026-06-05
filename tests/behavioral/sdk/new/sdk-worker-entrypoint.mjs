#!/usr/bin/env bun
// sdk/new/sdk-worker-entrypoint - @nimbus-sh/sdk exposes a compiled
// public Worker embedder subpath. Plain Bun cannot execute this module because
// the runtime implementation imports cloudflare:workers; Wrangler dry-runs
// cover Worker bundling. This probe validates the package surface.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/sdk-worker-entrypoint');

const pkg = JSON.parse(await Bun.file('packages/sdk/package.json').text());
const src = await Bun.file('packages/sdk/src/worker.ts').text();
const js = await Bun.file('packages/sdk/dist/worker.js').text();
const dts = await Bun.file('packages/sdk/dist/worker.d.ts').text();

a.check('package exports @nimbus-sh/sdk/worker',
  pkg.exports?.['./worker']?.import === './dist/worker.js'
  && pkg.exports?.['./worker']?.types === './dist/worker.d.ts'
  && pkg.exports?.['./worker']?.workspace === './src/worker.ts');

for (const name of [
  'NimbusSession',
  'SupervisorRPC',
  'NimbusAssetsRPC',
  'NimbusLoaderRPC',
  'NimbusLoadedWorker',
  'NimbusLoadedEntrypoint',
  'NimbusDurableObjectNamespace',
  'NimbusDOStub',
  'CirrusHmrRPC',
  'createNimbusHandler',
  'issueNimbusToken',
  'verifyNimbusToken',
]) {
  a.check(`source re-exports ${name}`, src.includes(name));
  a.check(`dist js re-exports ${name}`, js.includes(name));
  a.check(`dist d.ts re-exports ${name}`, dts.includes(name));
}

a.check('source re-exports from runtime package',
  src.includes("from '@nimbus-sh/worker'"));
a.check('dist js re-exports from runtime package',
  js.includes("from '@nimbus-sh/worker'"));

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
