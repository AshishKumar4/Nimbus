// npm packages tests/unit/prebundle-differential.mjs pre-bundles with
// esbuild-wasm 0.24.2 and with Nimbus's bundler, as the installer and the
// Vite dev server do: one specifier from the slice of its package files.
// Each package exercises one rule of the slice resolver or of the CommonJS
// shape the dev server serves (named exports synthesized from `exports.X`,
// external requires turned into imports).

const NM = 'home/user/app/node_modules';

// Every byte value once, for a binary module.
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

export const FILES = {
  // The shared React runtime every other package keeps external.
  [`${NM}/react/package.json`]: '{"name":"react","main":"index.js","exports":{".":"./index.js","./jsx-runtime":"./jsx-runtime.js","./package.json":"./package.json"}}',
  [`${NM}/react/index.js`]: "exports.useState = function useState(v) { return [v, function () {}]; }; exports.version = '19-fixture';",
  [`${NM}/react/jsx-runtime.js`]: "module.exports = require('./cjs/jsx.js');",
  [`${NM}/react/cjs/jsx.js`]: "var React = require('react'); exports.jsx = function jsx(type, props) { return { type, props, v: React.version }; }; exports.jsxs = exports.jsx; exports.Fragment = Symbol.for('react.fragment');",

  // CommonJS: exports.X, defineProperty, module.exports.X, a helper, an external require.
  [`${NM}/cjs-lib/package.json`]: '{"name":"cjs-lib","main":"index.js","dependencies":{"react":"*"}}',
  [`${NM}/cjs-lib/index.js`]: "const h = require('./helper'); const React = require('react'); exports.value = h(21); Object.defineProperty(exports, 'flag', { value: true, enumerable: true }); module.exports.named = 'N'; exports.reactKind = typeof React.useState; exports['quoted'] = 'q';",
  [`${NM}/cjs-lib/helper.js`]: 'module.exports = function (x) { return x * 2; };',
  [`${NM}/cjs-lib/sub/index.js`]: "exports.sub = 'SUB';",

  // ES module package: an exports map with import/require conditions, a subpath, a re-export.
  [`${NM}/esm-lib/package.json`]: '{"name":"esm-lib","type":"module","exports":{".":{"import":"./esm.js","require":"./cjs.cjs"},"./sub":"./sub.js"}}',
  [`${NM}/esm-lib/esm.js`]: "export default 'esm-default'; export const two = 2; export * from './more.js';",
  [`${NM}/esm-lib/more.js`]: "export const more = 'm'; export function fn(a, b) { return a + b; }",
  [`${NM}/esm-lib/cjs.cjs`]: "module.exports = 'cjs-only-for-require';",
  [`${NM}/esm-lib/sub.js`]: "export const sub = 'SUB';",

  // A `module` field beside `main`: the ESM entry wins under the import conditions.
  [`${NM}/modfield/package.json`]: '{"name":"modfield","main":"main.cjs","module":"module.mjs"}',
  [`${NM}/modfield/main.cjs`]: "module.exports = { which: 'main' };",
  [`${NM}/modfield/module.mjs`]: "export const which = 'module'; export default 'module-default';",

  // @babel/runtime's trick: `require` must take the CommonJS helper, whose
  // module.exports is the function itself.
  [`${NM}/helperpkg/package.json`]: '{"name":"helperpkg","exports":{"./helpers/extends":{"import":"./esm/extends.js","require":"./extends.js","default":"./extends.js"}}}',
  [`${NM}/helperpkg/extends.js`]: 'function _extends() { return Object.assign.apply(null, arguments); } module.exports = _extends, module.exports.__esModule = true, module.exports["default"] = module.exports;',
  [`${NM}/helperpkg/esm/extends.js`]: 'export default function _extends() { return Object.assign.apply(null, arguments); }',
  [`${NM}/uses-babel/package.json`]: '{"name":"uses-babel","main":"index.js","dependencies":{"helperpkg":"*"}}',
  [`${NM}/uses-babel/index.js`]: "var _extends = require('helperpkg/helpers/extends'); exports.merged = _extends({}, { a: 1 }, { b: 2 }); exports.kind = typeof _extends;",

  // `#name` imports, resolved against the package's own `imports`.
  [`${NM}/imports-lib/package.json`]: '{"name":"imports-lib","type":"module","main":"index.js","imports":{"#internal":"./internal.js","#cond":{"browser":"./browser.js","default":"./node.js"}}}',
  [`${NM}/imports-lib/index.js`]: "import { x } from '#internal'; import { where } from '#cond'; export const fromInternal = x; export { where };",
  [`${NM}/imports-lib/internal.js`]: "export const x = 'internal';",
  [`${NM}/imports-lib/browser.js`]: "export const where = 'browser';",
  [`${NM}/imports-lib/node.js`]: "export const where = 'node';",

  // A dependency of a dependency, JSON, a cycle, a dynamic import, a binary module and a stylesheet.
  [`${NM}/deep/package.json`]: '{"name":"deep","main":"index.js","dependencies":{"leaf":"*"}}',
  [`${NM}/deep/index.js`]: "const leaf = require('leaf'); const data = require('./data.json'); const a = require('./a'); exports.leaf = leaf.name; exports.greeting = data.greeting; exports.cycle = a.seen; exports.load = () => import('./lazy.js'); exports.bytes = Array.from(require('./blob.wasm')).join(',');",
  [`${NM}/deep/data.json`]: '{"greeting":"hi","list":[1,2]}',
  [`${NM}/deep/a.js`]: "exports.early = 'a-early'; const b = require('./b'); exports.seen = b.seen;",
  [`${NM}/deep/b.js`]: "const a = require('./a'); exports.seen = a.early + '+' + String(a.seen);",
  [`${NM}/deep/lazy.js`]: "export const lazy = 'lazy';",
  [`${NM}/deep/blob.wasm`]: ALL_BYTES,
  [`${NM}/leaf/package.json`]: '{"name":"leaf","main":"index.js"}',
  [`${NM}/leaf/index.js`]: "exports.name = 'leaf';",
  [`${NM}/styled/package.json`]: '{"name":"styled","main":"index.js"}',
  [`${NM}/styled/index.js`]: "require('./style.css'); exports.styled = true;",
  [`${NM}/styled/style.css`]: '.styled { color: red }',

  // The on-demand path's define: process.env.NODE_ENV and friends replaced.
  [`${NM}/envy/package.json`]: '{"name":"envy","main":"index.js"}',
  [`${NM}/envy/index.js`]: "exports.mode = process.env.NODE_ENV; exports.g = typeof global; if (process.env.NODE_ENV !== 'production') exports.dev = true;",

  // Unresolvable: a bare import the slice cannot answer stays external, with a warning.
  [`${NM}/loose/package.json`]: '{"name":"loose","main":"index.js"}',
  [`${NM}/loose/index.js`]: "exports.later = () => require('not-installed');",
};

/** Each case: the specifier, its entry in the slice, and the on-demand path's define where it has one. */
export const CASES = [
  { specifier: 'react', entry: 'react/index.js' },
  { specifier: 'react/jsx-runtime', entry: 'react/jsx-runtime.js' },
  { specifier: 'cjs-lib', entry: 'cjs-lib/index.js' },
  { specifier: 'cjs-lib/sub', entry: 'cjs-lib/sub/index.js' },
  { specifier: 'esm-lib', entry: 'esm-lib/esm.js' },
  { specifier: 'esm-lib/sub', entry: 'esm-lib/sub.js' },
  { specifier: 'modfield', entry: 'modfield/module.mjs' },
  { specifier: 'uses-babel', entry: 'uses-babel/index.js' },
  { specifier: 'imports-lib', entry: 'imports-lib/index.js' },
  { specifier: 'deep', entry: 'deep/index.js' },
  // A package that imports a stylesheet: no pre-bundle (the dev server bundles it on demand).
  { specifier: 'styled', entry: 'styled/index.js', expectFailure: true },
  { specifier: 'envy', entry: 'envy/index.js', define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' } },
  { specifier: 'loose', entry: 'loose/index.js' },
];

export const NODE_MODULES = '/' + NM;
