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
import { originalPosition } from './lib/sourcemap-vlq.mjs';

const fromWorker = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
const api = {
  rolldown: (await import(fromWorker.resolve('rolldown'))).rolldown,
  transformSync: (await import(fromWorker.resolve('rolldown/experimental'))).transformSync,
  parseSync: (await import(fromWorker.resolve('rolldown/experimental'))).parseSync,
};


const FLAT = `const order: string[] = [];
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
// A decorated class in a decorator factory's callback, behind a static
// member: the outer run moves the lines holding the inner run.
const NESTED = `const order: string[] = [];
const d = (tag: string) => () => { order.push(tag); };
function factory(tag: string, body: () => void) { body(); return d(tag); }
export class Outer {
  @d('outer static')
  static t = 1;
  @factory('outer method', () => {
    @d('inner class')
    class Inner {
      @d('inner static')
      static s = 1;
      @d('inner field')
      x = 2;
    }
  })
  m() {}
  @d('outer field')
  y = 2;
}
export { order };
`;
const strip = (p) => p.replace(/^\/+/, '');
const text = (f) => (typeof f.contents === 'string' ? f.contents : new TextDecoder().decode(f.contents));

for (const [name, SOURCE, expected, calls] of [
  ['flat', FLAT, ['field', 'parameter', 'method', 'static field', 'static method', 'class'], ['d("field")', 'd("method")', 'd("static field")', 'd("static method")', 'd("class")']],
  ['nested', NESTED, ['inner field', 'inner static', 'inner class', 'outer method', 'outer field', 'outer static'],
    ['d("inner field")', 'd("inner static")', 'd("inner class")', 'factory("outer method"', 'd("outer field")', 'd("outer static")']],
]) {
  const files = { 'home/user/p/a.ts': SOURCE };
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
  const js = text(result.outputFiles.find((f) => f.path.endsWith('.js')));
  const map = JSON.parse(text(result.outputFiles.find((f) => f.path.endsWith('.map'))));

  const { order } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  assert.deepEqual(order, expected, `${name}: tsc's order`);

  // Each decorator call, where it is in the output, maps to its decorator's line.
  const lines = js.split('\n');
  const sourceLines = SOURCE.split('\n');
  for (const call of calls) {
    const at = lines.findIndex((line) => line.includes(call));
    assert.ok(at >= 0, `${name}: the call ${call} is in the output`);
    const [original] = originalPosition(map, at + 1, lines[at].indexOf(call)) ?? [];
    const decorator = `@${call.replace(/"/g, "'")}`;
    assert.equal(sourceLines[original - 1]?.trim().startsWith(decorator), true, `${name}: ${call} maps to line ${original}: ${sourceLines[original - 1]}`);
  }
  console.log(`  ok  ${name}: tsc's order, each call mapped to its decorator`);
}
console.log('build-decorators-sourcemap OK');
