#!/usr/bin/env bun
// A build under experimentalDecorators puts Oxc's decorator calls in tsc's
// order (instance members, static members, the class) by moving whole lines
// of rolldown's transform output (rolldown-build.ts, decorateInTscOrder);
// the source map's lines move with them, so each call still maps to the
// decorator it came from. tsconfig-jsx-differential checks what the calls do.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';

const fromWorker = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
const api = {
  rolldown: (await import(fromWorker.resolve('rolldown'))).rolldown,
  transformSync: (await import(fromWorker.resolve('rolldown/experimental'))).transformSync,
  parseSync: (await import(fromWorker.resolve('rolldown/experimental'))).parseSync,
};

/** The original line (1-based) a generated position maps to: the source map's `mappings`, decoded. */
function originalLine(sourceMap, line, column) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const state = [0, 0, 0, 0];
  let found = null;
  sourceMap.mappings.split(';').forEach((segments, generated) => {
    let col = 0;
    for (const segment of segments.split(',').filter(Boolean)) {
      const fields = [];
      for (let i = 0, value = 0, shift = 0; i < segment.length; i++) {
        const digit = B64.indexOf(segment[i]);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else { fields.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
      }
      col += fields[0];
      for (let i = 1; i < fields.length; i++) state[i - 1] += fields[i];
      if (generated === line - 1 && fields.length > 1 && col <= column) found = state[1] + 1;
    }
  });
  return found;
}

const SOURCE = `const order: string[] = [];
const d = (tag: string) => () => { order.push(tag); };
@d('class')
export class A {
  @d('static field')
  static s = 1;
  @d('field')
  x = 2;
  @d('static method')
  static sm() {}
  @d('method')
  m(@d('parameter') p: number) {}
}
export { order };
`;
const files = { 'home/user/p/a.ts': SOURCE };
const strip = (p) => p.replace(/^\/+/, '');
const fs = {
  exists: (p) => strip(p) in files || p === '/home/user/p',
  isDirectory: (p) => !(strip(p) in files),
  readFile: (p) => new TextEncoder().encode(files[strip(p)]),
  readFileString: (p) => files[strip(p)],
};
const service = new EsbuildService(fs, { buildHost: (options, plugin) => buildWithRolldown(api, options, plugin) });
const result = await service.build(['/home/user/p/a.ts'], {
  sourcemap: 'external',
  tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
});
const text = (f) => (typeof f.contents === 'string' ? f.contents : new TextDecoder().decode(f.contents));
const js = text(result.outputFiles.find((f) => f.path.endsWith('.js')));
const map = JSON.parse(text(result.outputFiles.find((f) => f.path.endsWith('.map'))));

const { order } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
assert.deepEqual(order, ['field', 'parameter', 'method', 'static field', 'static method', 'class'], 'tsc\'s order');

// Each decorator call, where it is in the output, maps to its decorator's line.
const lines = js.split('\n');
const sourceLines = SOURCE.split('\n');
for (const tag of ['field', 'method', 'static field', 'static method', 'class']) {
  const at = lines.findIndex((line) => line.includes(`d("${tag}")`));
  assert.ok(at >= 0, `the call of d("${tag}") is in the output`);
  const original = originalLine(map, at + 1, lines[at].indexOf(`d("${tag}")`));
  assert.equal(sourceLines[original - 1]?.trim().startsWith(`@d('${tag}')`), true, `d("${tag}") maps to line ${original}`);
}
console.log('build-decorators-sourcemap OK');
