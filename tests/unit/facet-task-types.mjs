// Plain closures are a type error at every dispatch boundary, not a runtime
// convention a minifier can silently break. Check the actual public signatures.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-task-types-'));
try {
  const entry = join(root, 'task-types.ts');
  writeFileSync(entry, `import type { Facet } from ${JSON.stringify(join(repo, 'packages/core/src/runtime/facet-host.ts'))};
import type { IsolatePool } from ${JSON.stringify(join(repo, 'packages/fabric/src/isolate-pool.ts'))};
import type { Fanout } from ${JSON.stringify(join(repo, 'packages/fabric/src/fanout.ts'))};
import { facetTaskSource } from ${JSON.stringify(join(repo, 'packages/core/src/runtime/facet-task.ts'))};
declare const facet: Facet, pool: IsolatePool, fanout: Fanout;
const compiled = facetTaskSource<number, number>('value => value + 1');
const request = facetTaskSource<Request, Response>('request => new Response(request.url)');
facet.submit(compiled, 1); pool.submit(compiled, 1); pool.map(compiled, [1]);
pool.submitRequest(request, new Request('https://types.test/'));
fanout.submitMany([{key:'one',args:1}], compiled);
// @ts-expect-error a closure cannot cross the facet boundary
facet.submit((value: number) => value, 1);
// @ts-expect-error a closure cannot cross the pool boundary
pool.submit((value: number) => value, 1);
// @ts-expect-error map also requires a task-source value
pool.map((value: number) => value, [1]);
// @ts-expect-error request transport cannot accept a plain callback
pool.submitRequest((request: Request) => new Response(request.url), new Request('https://types.test/'));
// @ts-expect-error a fanout task cannot be a live closure
fanout.submitMany([{key:'one',args:1}], (value: number) => value);
`);
  const configPath = join(repo, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repo);
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: true, allowImportingTsExtensions: true });
  const source = program.getSourceFile(entry);
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  assert.deepEqual(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')), [], 'every accepted value and rejected closure is checked');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('facet-task-types: precompiled values accepted, live callbacks rejected');
