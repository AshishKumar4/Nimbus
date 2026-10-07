#!/usr/bin/env bun
// A build honouring a tsconfig maps its output to the source as written: no
// setting edits a module's text before rolldown reads it, so each token
// after an import, on the import's own line, maps to its own column, and the
// map's sourcesContent is the source. importsNotUsedAsValues "preserve" with
// every import used (where it is honoured, not refused) is the case an edit
// once moved; a fragment that is a string of a line separator, the case a
// raw one would move every line after it.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { originalPosition } from './lib/sourcemap-vlq.mjs';

const fromWorker = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
const experimental = await import(fromWorker.resolve('rolldown/experimental'));
const api = {
  rolldown: (await import(fromWorker.resolve('rolldown'))).rolldown,
  transformSync: experimental.transformSync,
  parseSync: experimental.parseSync,
};


const SOURCE = `import { used } from './a'; export const y = used + 1;
import /* a comment */ { other } from './b'; export const z = other * 2;
`;
const files = {
  'home/user/p/main.ts': SOURCE,
  'home/user/p/a.ts': 'export const used = 1;\n',
  'home/user/p/b.ts': 'export const other = 2;\n',
  'home/user/p/frag.tsx': 'export const e = <>x</>; export const after = 1;\nexport const later = 2;\n',
};
const strip = (p) => p.replace(/^\/+/, '');
const fs = {
  exists: (p) => strip(p) in files || strip(p) === 'home/user/p',
  isDirectory: (p) => !(strip(p) in files),
  readFile: (p) => new TextEncoder().encode(files[strip(p)]),
  readFileString: (p) => files[strip(p)],
};
const service = new EsbuildService(fs, { buildHost: (options, plugin) => buildWithRolldown(api, options, plugin) });
const text = (f) => (typeof f.contents === 'string' ? f.contents : new TextDecoder().decode(f.contents));

for (const compilerOptions of [{ importsNotUsedAsValues: 'preserve' }, { preserveValueImports: true }, { verbatimModuleSyntax: true }]) {
  const result = await service.build(['/home/user/p/main.ts'], { sourcemap: 'external', tsconfigRaw: JSON.stringify({ compilerOptions }) });
  const js = text(result.outputFiles.find((f) => f.path.endsWith('.js')));
  const map = JSON.parse(text(result.outputFiles.find((f) => f.path.endsWith('.map'))));
  const lines = js.split('\n');
  const sourceLines = SOURCE.split('\n');
  for (const [token, expected] of [['used + 1', 'used + 1'], ['other * 2', 'other * 2']]) {
    const at = lines.findIndex((line) => line.includes(token));
    assert.ok(at >= 0, `${token} is in the output`);
    const [line, column] = originalPosition(map, at + 1, lines[at].indexOf(token)) ?? [];
    assert.equal(sourceLines[line - 1]?.slice(column, column + expected.length), expected,
      `${JSON.stringify(compilerOptions)}: ${token} maps to line ${line}, column ${column}`);
  }
  const index = map.sources.findIndex((s) => s.endsWith('main.ts'));
  assert.equal(map.sourcesContent[index], SOURCE, `${JSON.stringify(compilerOptions)}: the map's source is the module as written`);
}

for (const jsxFragment of ['"\u2028"', "'\u2029'"]) {
  const result = await service.build(['/home/user/p/frag.tsx'], { sourcemap: 'external', jsxFragment });
  const js = text(result.outputFiles.find((f) => f.path.endsWith('.js')));
  const map = JSON.parse(text(result.outputFiles.find((f) => f.path.endsWith('.map'))));
  assert.doesNotMatch(js, /[\u2028\u2029]/, `${jsxFragment}: no raw separator in the output`);
  const lines = js.split('\n');
  const sourceLines = files['home/user/p/frag.tsx'].split('\n');
  for (const token of ['after = 1', 'later = 2']) {
    const at = lines.findIndex((line) => line.includes(token));
    const [line, column] = originalPosition(map, at + 1, lines[at].indexOf(token)) ?? [];
    assert.equal(sourceLines[line - 1]?.slice(column, column + token.length), token, `${jsxFragment}: ${token} maps to line ${line}, column ${column}`);
  }
}
console.log('build-tsconfig-sourcemap OK');
