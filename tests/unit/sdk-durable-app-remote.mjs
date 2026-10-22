#!/usr/bin/env bun
// `ports.ensureDurableApp` reaches the session alike over both transports
// (audit SHI-10): colocated (Nimbus.fromEnv, the DO binding) and remote
// (Nimbus.connect through the worker's remote API), the session gets the
// owner, preferred port, visibility and name it was given. Remotely, each is
// checked as exposeApp's options are: a name that is not a string is refused.
// Its input is the session protocol's SessionDurableAppOptions, so a name is
// part of the SDK's type, and every input that compiled before still does.
//
// Red before: the remote API rebuilt the request without `name`, so a
// durable app's label survived only the colocated transport; and the SDK's
// own input type refused a name.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configOptions, programErrors } from './lib/tsrs-program.mjs';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const RESULT = { port: 3000, capability: 'cap', visibility: 'public' };

/** A NIMBUS_SESSION namespace whose stub records what ensureDurableApp gets. */
function binding(calls) {
  const stub = {
    _rpcReady: async () => ({ ok: true, preinstalled: [] }),
    _rpcEnsureDurableApp: async (input) => { calls.push(input); return RESULT; },
  };
  return { NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } };
}

const inputs = [
  { owner: 'auto:web', preferredPort: 3000, visibility: 'public', name: 'web' },
  { owner: 'auto:api', name: 'api' },
  { owner: 'auto:bare' },
  { owner: 'auto:scoped', visibility: 'scoped', preferredPort: 8080 },
];

const colocated = [];
const local = Nimbus.fromEnv(binding(colocated)).sandbox('box');
for (const input of inputs) assert.deepEqual(await local.ports.ensureDurableApp(input), RESULT);

const remoted = [];
const env = { JWT_SECRET: 'unit-durable-app-secret', ...binding(remoted) };
const token = await issueNimbusToken(env, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use'], sid: 'box' });
const remote = Nimbus.connect({
  endpoint: 'https://unit.test', token,
  fetch: (url, init) => handleNimbusRemoteApi(new Request(url, init), env, { remote: true }),
}).sandbox('box');
for (const input of inputs) assert.deepEqual(await remote.ports.ensureDurableApp(input), RESULT);

assert.deepEqual(colocated, inputs, 'colocated, the session gets each input whole');
assert.deepEqual(remoted, colocated, 'remotely, the session gets what it gets colocated: the name included');

await assert.rejects(remote.ports.ensureDurableApp({ owner: 'auto:bad', name: 7 }), /name/, 'a name that is not a string is refused remotely');
assert.equal(remoted.length, inputs.length, 'and never reaches the session');

// The SDK's input is the protocol's: a name is accepted, every input that compiled before still compiles, and the
// two types assign to each other.
const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-durable-app-types-'));
try {
  const entry = join(root, 'durable-app-types.ts');
  writeFileSync(entry, `import { Nimbus, type NimbusDurableAppOptions } from ${JSON.stringify(join(repo, 'packages/sdk/src/sandbox.ts'))};
import type { SessionDurableAppOptions } from ${JSON.stringify(join(repo, 'packages/core/src/runtime/session-protocol.ts'))};
const box = Nimbus.connect({ endpoint: 'https://types.test' }).sandbox('box');
type Input = Parameters<typeof box.ports.ensureDurableApp>[0];
type Before = { owner: string; preferredPort?: number; visibility?: 'scoped' | 'public' };
declare const input: Input, shared: SessionDurableAppOptions, named: NimbusDurableAppOptions, before: Before;
const toShared: SessionDurableAppOptions = input;
const fromShared: Input = shared;
const fromNamed: Input = named;
const fromBefore: Input = before;
void [toShared, fromShared, fromNamed, fromBefore];
void box.ports.ensureDurableApp({ owner: 'o', name: 'web' });
void box.ports.ensureDurableApp({ owner: 'o' });
void box.ports.ensureDurableApp({ owner: 'o', preferredPort: 3000 });
void box.ports.ensureDurableApp({ owner: 'o', visibility: 'scoped' });
void box.ports.ensureDurableApp({ owner: 'o', visibility: 'public', preferredPort: 1 });
// @ts-expect-error an owner is required
void box.ports.ensureDurableApp({ preferredPort: 1 });
// @ts-expect-error visibility is scoped or public
void box.ports.ensureDurableApp({ owner: 'o', visibility: 'private' });
// @ts-expect-error a name is a string
void box.ports.ensureDurableApp({ owner: 'o', name: 7 });
`);
  const options = { ...configOptions(join(repo, 'tsconfig.json')), noEmit: true, allowImportingTsExtensions: true };
  const errors = programErrors({ roots: [entry], options, cwd: repo });
  assert.deepEqual(errors.map((error) => error.message), [], 'the SDK takes the protocol\'s input, and every input it took before');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ok - sdk-durable-app-remote (ensureDurableApp\'s name reaches the session over both transports; the SDK takes SessionDurableAppOptions)');
