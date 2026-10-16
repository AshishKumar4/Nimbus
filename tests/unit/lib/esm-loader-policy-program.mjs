// One ES module program for the loader-policy parity tests
// (esm-loader-policy-parity.mjs, portable; esm-loader-policy-workerd.mjs,
// hosted): it prints, as JSON, how import() takes its arguments, how a data:
// URL module loads, and what node:module is. Host Node runs it as the oracle.
// Run with `lifo` as its argument, it adds what only Nimbus provides (esbuild,
// a provided package, as an ES module).

import { spawnSync } from 'node:child_process';

export const PROGRAM = `import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const out = {};
// A message names side.mjs by its URL, which is where the program runs: '<side>' in each.
const outcome = async (thunk) => {
  try { return ['ok', await thunk()]; } catch (e) { return [e?.constructor?.name ?? typeof e, String(e?.message ?? e).replaceAll(side, '<side>'), e?.code ?? null]; }
};
writeFileSync('side.mjs', 'globalThis.sideRan = (globalThis.sideRan ?? 0) + 1; export default 1;');
const side = new URL('./side.mjs', import.meta.url).href;
const loaded = (promise) => promise.then(() => 'loaded');

// import()'s arguments, refused before anything resolves or runs.
out.args = {
  symbol: await outcome(() => loaded(import(Symbol('s')))),
  one: await outcome(() => loaded(import(side, 1))),
  nullOptions: await outcome(() => loaded(import(side, null))),
  withNull: await outcome(() => loaded(import(side, { with: null }))),
  withOne: await outcome(() => loaded(import(side, { with: 1 }))),
  valueOne: await outcome(() => loaded(import(side, { with: { type: 1 } }))),
  laterGetter: await outcome(() => loaded(import(side, { with: { type: 1, get extra() { throw new Error('later getter'); } } }))),
  protoAttribute: await outcome(() => loaded(import(side, { with: JSON.parse('{"__proto__":"x"}') }))),
};
out.args.sideRanBefore = globalThis.sideRan ?? 0;
const callable = () => {};
callable.with = {};
out.args.callableOptions = await outcome(() => loaded(import(side, callable)));
out.args.callableWith = await outcome(() => loaded(import(side, { with: () => {} })));
const order = [];
out.args.order = await outcome(() => loaded(import(
  { toString() { order.push('specifier'); return side; } },
  { get with() { order.push('with'); return {}; } },
)));
out.args.orderSeen = order;

// data: URL modules: the format by MIME type, the source the body's bytes as UTF-8.
const data = (url, options) => outcome(async () => (await import(url, options)).default);
out.data = {
  textJavascript: await data('data:text/javascript,export default 1'),
  applicationJavascript: await data('data:application/javascript,export default 2'),
  charset: await data('data:text/javascript;charset=utf-8,export default 3'),
  suffix: await data('data:text/javascriptx,export default 4'),
  jsonBase64: await data('data:application/json;base64,IuKckyI=', { with: { type: 'json' } }),
  jsonPercent: await data('data:application/json,%22%E2%9C%93%22', { with: { type: 'json' } }),
  javascriptBase64: await data('data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgIuKckyI='),
  jsonSuffix: await data('data:application/jsonx,1'),
  plain: await data('data:text/plain,1'),
  // A no-break space is no ASCII whitespace: the body is not base64, but the source.
  nbspBase64: await data('data:text/javascript;base64\u00a0,export default 8'),
};

// node:module is Node's Module class, the same one by every route.
const Module = require('node:module');
out.module = {
  constructs: await outcome(() => typeof new Module('x')),
  self: Module.Module === Module,
  esmDefault: await outcome(async () => { const { default: M } = await import('node:module'); return [M === Module, typeof new M('y')]; }),
  isBuiltinAgrees: ['http2', 'fs', 'esbuild', 'node:test'].map((name) => Module.isBuiltin(name) === Module.Module.isBuiltin(name)),
  nodeEsbuild: await outcome(() => typeof require('node:esbuild')),
  importNodeEsbuild: await outcome(async () => typeof (await import('node:esbuild'))),
};
const fsCommon = require('node:fs');
const existsSync = fsCommon.existsSync;
fsCommon.existsSync = () => 'patched';
Module.syncBuiltinESMExports();
out.module.synced = (await import('node:fs')).existsSync('x');
fsCommon.existsSync = existsSync;
Module.syncBuiltinESMExports();

if (process.argv[2] === 'lifo') {
  const esbuild = require('esbuild');
  const namespace = await import('esbuild');
  out.esbuild = [typeof esbuild.version, namespace.version === esbuild.version, namespace.transform === esbuild.transform, namespace.default === esbuild];
}
console.log('POLICY ' + JSON.stringify(out));
`;

/** The program's report, from its output. */
export function report(stdout) {
  const line = stdout.split('\n').find((text) => text.startsWith('POLICY '));
  if (line === undefined) throw new Error(`no report in:\n${stdout}`);
  return JSON.parse(line.slice('POLICY '.length));
}

/** The oracle: host Node runs the program in `dir` (where it is written as policy.mjs). */
export function hostReport(dir) {
  const result = spawnSync('node', ['policy.mjs'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`host node: ${result.stderr}`);
  return report(result.stdout);
}
