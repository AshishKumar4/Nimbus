// Projects tests/unit/build-differential.mjs builds with esbuild-wasm 0.24.2
// and with Nimbus's bundler (rolldown through rolldown-build.ts), with each
// caller's options, then runs both outputs and compares what they do.
//
// `run` says how an output is exercised:
//   worker   wrangler's Worker: its exports, and its fetch answers to REQUESTS
//   module   a module: its namespace's names and each value's shape
//   config   real Vite's config bundle: the config object it exports
//   failure  the build fails: the failure message and its diagnostics

export const WRANGLER_OPTIONS = {
  bundle: true, format: 'esm', target: 'esnext', platform: 'neutral', minify: false,
  external: ['cloudflare:*', 'node:*', 'fs', 'path', 'os', 'crypto', 'util', 'stream', 'events', 'buffer', 'url', 'querystring', 'http', 'https', 'net', 'tls', 'child_process', 'worker_threads', 'perf_hooks', 'zlib', 'assert', 'fs/promises', 'process'],
};
export const REAL_VITE_CONFIG_OPTIONS = {
  bundle: true, format: 'esm', target: 'es2022', platform: 'neutral',
  external: ['node:*', 'fs', 'path', 'url', 'util', 'os', 'crypto', 'events', 'stream', 'buffer', 'module', 'perf_hooks', 'esbuild', 'esbuild-wasm', 'vite', 'vite/*', '@vitejs/plugin-react', '@vitejs/plugin-react/*'],
  define: { 'import.meta.url': '"file:///user-vite-config.js"' },
  keepNames: true,
};
export const COLD_MODULE_OPTIONS = {
  bundle: true, format: 'esm', platform: 'browser', target: 'esnext',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'true', global: 'globalThis' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
};

export const REQUESTS = [['GET', '/'], ['GET', '/u/7?q=a'], ['POST', '/items', { name: 'x', n: 1 }], ['POST', '/items', { name: '', n: 1.5 }], ['GET', '/ns'], ['OPTIONS', '/']];

const cjsAndEsmPackages = {
  'node_modules/cjsdep/package.json': '{"name":"cjsdep","main":"index.js"}',
  'node_modules/cjsdep/index.js': "const h = require('./helper'); exports.value = h(21); exports.named = 'N'; exports.helper = h;",
  'node_modules/cjsdep/helper.js': 'module.exports = function (x) { return x * 2; };',
  'node_modules/esmdep/package.json': '{"name":"esmdep","type":"module","exports":{".":{"import":"./esm.js","require":"./cjs.cjs"},"./sub":"./sub.js"}}',
  'node_modules/esmdep/esm.js': "export default 'esm-default'; export const two = 2;",
  'node_modules/esmdep/cjs.cjs': "module.exports = 'cjs-only-for-require';",
  'node_modules/esmdep/sub.js': "export const sub = 'SUB';",
  'node_modules/babelish/package.json': '{"name":"babelish","main":"lib/index.js"}',
  'node_modules/babelish/lib/index.js': 'Object.defineProperty(exports, "__esModule", { value: true }); exports.default = function babelDefault() { return "BD"; }; exports.extra = 1;',
  'node_modules/browserish/package.json': '{"name":"browserish","main":"node.js","browser":{"./node.js":"./browser.js"},"module":"esm.js"}',
  'node_modules/browserish/node.js': "module.exports = 'node-build';",
  'node_modules/browserish/browser.js': "module.exports = 'browser-build';",
  'node_modules/browserish/esm.js': "export default 'module-build';",
};

export const PROJECTS = {
  // ── wrangler dev ──────────────────────────────────────────────────────────
  'worker-routes': {
    options: WRANGLER_OPTIONS, run: 'worker', entry: 'src/index.ts',
    files: {
      'src/index.ts': `import { Router } from './router'; import { Buffer } from 'node:buffer';
const router = new Router();
router.get('/', () => new Response('hello ' + typeof Buffer));
router.get('/u/:id', (req, p) => Response.json({ id: p.id, q: new URL(req.url).searchParams.get('q') }));
router.post('/items', async (req) => { const b = await req.json(); return b.name ? Response.json({ ok: true, b64: Buffer.from(b.name).toString('base64') }) : Response.json({ ok: false }, { status: 400 }); });
export default { fetch: (req: Request) => router.handle(req) };`,
      'src/router.ts': `type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export class Router { private routes: Array<[string, RegExp, string[], Handler]> = [];
  get(p: string, h: Handler) { this.add('GET', p, h); } post(p: string, h: Handler) { this.add('POST', p, h); }
  private add(m: string, p: string, h: Handler) { const keys: string[] = []; const re = new RegExp('^' + p.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); this.routes.push([m, re, keys, h]); }
  async handle(req: Request) { const path = new URL(req.url).pathname; for (const [m, re, keys, h] of this.routes) { const hit = re.exec(path); if (hit && m === req.method) return h(req, Object.fromEntries(keys.map((k, i) => [k, hit[i + 1]]))); } return new Response('not found', { status: 404 }); } }`,
    },
  },
  'worker-module-shapes': {
    options: WRANGLER_OPTIONS, run: 'worker', entry: 'src/index.js',
    files: {
      'src/index.js': `import { format } from './lib/format.js'; import data from './data.json'; import * as ns from './lib/ns';
export class Counter { constructor(state) { this.state = state; } async fetch() { return new Response('do'); } }
export const tagged = 1;
export default { async fetch(req) { const u = new URL(req.url); if (u.pathname === '/ns') return Response.json(Object.keys(ns).sort()); return new Response(format(data, u.pathname)); } };`,
      'src/lib/format.js': "export function format(d, p) { return d.greeting + ' ' + p + ' ' + [1, 2, 3].map((x) => x * 2).join(','); }",
      'src/lib/ns.ts': 'export const a: number = 1; export function b() {} export default 3; export enum E { X, Y = 5 } export namespace N { export const v = 2; }',
      'src/data.json': '{"greeting":"hi","list":[1,2]}',
    },
  },
  'worker-interop': {
    options: WRANGLER_OPTIONS, run: 'worker', entry: 'src/index.js',
    files: {
      'src/index.js': `import cjs, { named } from 'cjsdep'; import esm, { two } from 'esmdep'; import { sub } from 'esmdep/sub'; import babel, { extra } from 'babelish';
const required = require('esmdep');
export default { fetch() { return Response.json({ cjs: cjs.value, named, esm, two, sub, req: typeof cjs.helper, babel: babel(), extra, required: String(required) }); } };`,
      ...cjsAndEsmPackages,
    },
  },
  'worker-order-and-cycles': {
    options: WRANGLER_OPTIONS, run: 'worker', entry: 'src/index.js',
    files: {
      'src/index.js': "import './a.js'; import { log } from './log.js'; import { even } from './even.js'; import('./lazy.js').then((m) => log.push(m.lazy));\nexport default { async fetch() { await 0; return Response.json({ log, even: even(10) }); } };",
      'src/log.js': 'export const log = [];',
      'src/a.js': "import { log } from './log.js'; import './b.js'; log.push('a');",
      'src/b.js': "import { log } from './log.js'; log.push('b');",
      'src/even.js': "import { odd } from './odd.js'; export function even(n) { return n === 0 ? true : odd(n - 1); }",
      'src/odd.js': "import { even } from './even.js'; export function odd(n) { return n === 0 ? false : even(n - 1); }",
      'src/lazy.js': "export const lazy = 'lazy';",
    },
  },
  'worker-top-level-await': {
    options: WRANGLER_OPTIONS, run: 'worker', entry: 'src/index.js',
    files: {
      'src/index.js': "import { config } from './config.js';\nexport default { fetch() { return Response.json(config); } };",
      'src/config.js': 'export const config = await Promise.resolve({ ready: true, n: 3 });',
    },
  },
  'worker-unresolved': {
    options: WRANGLER_OPTIONS, run: 'failure', entry: 'src/index.js',
    files: { 'src/index.js': "import { x } from './missing.js';\nexport default { fetch() { return new Response(x); } };" },
  },
  'worker-syntax-error': {
    options: WRANGLER_OPTIONS, run: 'failure', entry: 'src/index.ts',
    files: { 'src/index.ts': 'export default {\n  fetch() { let a = ; }\n};' },
    // Oxc's parser words its errors ("Unexpected token"), esbuild's its own ('Unexpected ";"').
    sameExceptText: 'parse errors are worded by each parser',
  },
  'worker-unresolved-bare-is-external': {
    options: WRANGLER_OPTIONS, run: 'module', entry: 'src/index.js',
    files: { 'src/index.js': "export const spec = 'kept'; export function later() { return import('not-installed-pkg'); }" },
  },
  'worker-alias-free-node-builtins': {
    options: WRANGLER_OPTIONS, run: 'module', entry: 'src/index.js',
    files: { 'src/index.js': "import { join } from 'node:path'; import path from 'path'; export const joined = join('a', 'b') + '|' + path.sep;" },
  },

  // ── real Vite's config bundle ──────────────────────────────────────────────
  'vite-config': {
    options: REAL_VITE_CONFIG_OPTIONS, run: 'config', entry: 'vite.config.ts',
    files: {
      'vite.config.ts': `import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; import { fileURLToPath } from 'node:url'; import { ports } from './config/ports';
class PortPicker { pick() { return ports.dev; } }
const picker = new PortPicker();
export default defineConfig({ plugins: [react()], server: { port: picker.pick(), host: true }, define: { __WHERE__: JSON.stringify(fileURLToPath(import.meta.url)) }, resolve: { alias: { '@': '/src' } }, build: { outDir: 'dist', sourcemap: true }, meta: { picker: picker.constructor.name, fn: (function named() {}).name } });`,
      'config/ports.ts': 'export const ports = { dev: 5173 as number, preview: 4173 };',
    },
  },

  // ── Vite dev's cold module (no pre-bundle pool) ────────────────────────────
  'cold-cjs-package': {
    options: COLD_MODULE_OPTIONS, run: 'module', entry: 'node_modules/cjsdep/index.js',
    files: { ...cjsAndEsmPackages },
  },
  'cold-browser-field': {
    options: COLD_MODULE_OPTIONS, run: 'module', entry: 'src/entry.js',
    files: { 'src/entry.js': "export { default as which } from 'browserish'; export * from 'esmdep'; export { default as esm } from 'esmdep';", ...cjsAndEsmPackages },
  },
  'cold-define-and-env': {
    options: COLD_MODULE_OPTIONS, run: 'module', entry: 'src/entry.js',
    files: { 'src/entry.js': 'export const mode = process.env.NODE_ENV; export const dev = import.meta.env.DEV; export const g = typeof global; export const other = typeof process.env.OTHER;' },
  },
  'cold-react-external': {
    options: COLD_MODULE_OPTIONS, run: 'module', entry: 'src/hooks.js',
    files: { 'src/hooks.js': "import { useState } from 'react'; import { createRoot } from 'react-dom/client'; export function useToggle() { return useState(false); } export const root = typeof createRoot;" },
  },
};
