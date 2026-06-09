#!/usr/bin/env bun
// static-checks/native-executable-preamble-parity — the supervisor and
// resolver-facet native-bin reject policy must stay equivalent.

import { makeAsserter } from '../_driver.mjs';
import { nativeExecutableReject } from '../../../packages/worker/src/facets/wasm-swap-registry.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../../packages/worker/src/loaders/npm-resolve-preamble.ts';

const a = makeAsserter('static-checks/native-executable-preamble-parity');

const preambleReject = new Function(`${NPM_RESOLVE_PREAMBLE}\nreturn NATIVE_EXECUTABLE_REJECT;`)();

const fixtures = [
  {
    name: 'windows-bin',
    bin: { tool: 'bin/tool.exe' },
  },
  {
    name: 'native-addon-bin',
    bin: { addon: 'dist/addon.node' },
  },
  {
    name: 'native-addon-with-query',
    bin: { addon: 'dist/addon.node?module#hash' },
  },
  {
    name: 'javascript-bin',
    bin: { cli: 'dist/cli.js' },
  },
  {
    name: 'extensionless-bin',
    bin: { cli: 'dist/cli' },
  },
  {
    name: 'empty-bin',
    bin: {},
  },
];

for (const fixture of fixtures) {
  const supervisor = nativeExecutableReject(fixture) ?? null;
  const facet = preambleReject(fixture) ?? null;
  a.check(
    `${fixture.name} policy matches`,
    JSON.stringify(supervisor) === JSON.stringify(facet),
    `supervisor=${JSON.stringify(supervisor)} facet=${JSON.stringify(facet)}`,
  );
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
