#!/usr/bin/env bun
// useNimbusSession takes what it uses: an endpoint and a token, the session
// to attach to, the iframe its events must come from, a reload key and its
// callbacks. Identity (tenant, sub) is the component's, which shows it on its
// iframe; the hook reads neither, so an embedder of the headless hook is not
// asked for one. Compiled with @nimbus-sh/react's own TypeScript settings.
//
// Red before: tenant was required of the hook, so a call without it did not
// compile.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configOptions, programErrors } from './lib/tsrs-program.mjs';

const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-react-hook-options-'));
try {
  const entry = join(root, 'react-hook-options.ts');
  writeFileSync(entry, `import { useNimbusSession } from ${JSON.stringify(join(repo, 'packages/react/src/index.ts'))};
declare const iframeRef: NonNullable<Parameters<typeof useNimbusSession>[0]['iframeRef']>;
void useNimbusSession({ endpoint: 'https://nimbus.test', token: 't' });
void useNimbusSession({ endpoint: 'https://nimbus.test', token: 't', sessionId: 's', iframeRef, reloadKey: 1, onReady() {}, onError(error) { void error.code; } });
// @ts-expect-error identity is the component's to show, not the hook's
void useNimbusSession({ endpoint: 'https://nimbus.test', token: 't', tenant: 'acme' });
// @ts-expect-error a token is required
void useNimbusSession({ endpoint: 'https://nimbus.test' });
`);
  const options = { ...configOptions(join(repo, 'packages/react/tsconfig.json')), noEmit: true, allowImportingTsExtensions: true };
  const errors = programErrors({ roots: [entry], options, cwd: join(repo, 'packages/react') });
  assert.deepEqual(errors.map((error) => error.message), [],
    'the headless hook takes its options without an identity, and refuses one');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ok - react-hook-options (the headless hook asks for no tenant or sub)');
