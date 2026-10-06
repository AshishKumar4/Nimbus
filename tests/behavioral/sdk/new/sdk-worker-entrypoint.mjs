#!/usr/bin/env bun
// sdk/new/sdk-worker-entrypoint - @nimbus-sh/sdk exposes a compiled
// public Worker embedder subpath. Plain Bun cannot execute this module because
// the runtime implementation imports cloudflare:workers; Wrangler dry-runs
// cover Worker bundling. This probe checks the surface as its consumers see
// it: dist/worker.js re-exports each name as a binding from
// @nimbus-sh/worker (parsed, not grepped: a name in a comment is not an
// export), and a TypeScript consumer importing each one as a value from
// '@nimbus-sh/sdk/worker' compiles, which also proves @nimbus-sh/worker's
// declarations carry it.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/sdk-worker-entrypoint');

const pkg = JSON.parse(await Bun.file('packages/sdk/package.json').text());
const js = await Bun.file('packages/sdk/dist/worker.js').text();

a.check('package exports @nimbus-sh/sdk/worker',
  pkg.exports?.['./worker']?.import === './dist/worker.js'
  && pkg.exports?.['./worker']?.types === './dist/worker.d.ts'
  && pkg.exports?.['./worker']?.workspace === './src/worker.ts');

const NAMES = [
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
];

const ts = (await import('typescript')).default;

// dist/worker.js: the export bindings and where each comes from.
{
  const file = ts.createSourceFile('worker.js', js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const reexported = new Map();
  for (const node of file.statements) {
    if (!ts.isExportDeclaration(node) || !node.moduleSpecifier || !node.exportClause) continue;
    for (const spec of node.exportClause.elements) reexported.set(spec.name.text, node.moduleSpecifier.text);
  }
  for (const name of NAMES) {
    a.check(`dist js re-exports ${name} from @nimbus-sh/worker`, reexported.get(name) === '@nimbus-sh/worker',
      `source: ${reexported.get(name) ?? 'not exported'}`);
  }
}

// A consumer's compile against the published declarations.
{
  const consumer = `${process.cwd()}/apps/hosted-demo/__sdk-worker-consumer.ts`;
  const source = [
    `import { ${NAMES.join(', ')} } from '@nimbus-sh/sdk/worker';`,
    `export const surface = [${NAMES.join(', ')}];`,
  ].join('\n');
  const options = {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => (file === consumer ? source : readFile(file));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => file === consumer || fileExists(file);
  const program = ts.createProgram([consumer], options, host);
  const errors = ts.getPreEmitDiagnostics(program, program.getSourceFile(consumer))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  a.check('a consumer imports every name from @nimbus-sh/sdk/worker as a value', errors.length === 0, errors.join(' | '));
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
