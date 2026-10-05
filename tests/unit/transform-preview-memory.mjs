#!/usr/bin/env bun
// Concurrent Vite module requests must serve renderable default exports under
// a facet memory budget, not error-overlay scripts lacking those exports.
// Uses the production facet module and actual wasm memory allocations; the
// fixture models the platform's finite memory envelope at instantiation.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { transform } from 'esbuild';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { oxcTransformHost } from '../../packages/worker/src/facets/oxc-transform.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { durableObject, freshFacetClass, instances, releaseFacetHarness, resetInstances } from './lib/oxc-facet-harness.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const root = 'home/user/app';
const components = Array.from({ length: 12 }, (_, i) => `Panel${i}`);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const write = (path, content) => {
  kernel.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kernel.writeFile(path, new TextEncoder().encode(content), { mode: 0o644 });
};
write(`${root}/package.json`, JSON.stringify({ name: 'app' }));
write(`${root}/src/components/Card.tsx`, `import type { ReactNode } from 'react';
interface CardProps { children: ReactNode; className?: string }
export default function Card({ children, className = '' }: CardProps) {
  return <div className={'card ' + className}>{children}</div>;
}
`);
for (const name of components) {
  write(`${root}/src/components/${name}.tsx`, `import Card from './Card';
export default function ${name}() {
  return <Card className="${name}">{'${name}'}</Card>;
}
`);
}

resetInstances();
// Far less than a Worker has: the facet's one shared instance must fit it.
instances.memoryLimitBytes = 16 * 1024 * 1024;
const { ctx, env } = durableObject(await freshFacetClass());
const esbuild = new EsbuildService(undefined, { transformHost: oxcTransformHost(ctx, env) });
const server = new ViteDevServer({ vfs, cred: CRED_KERNEL, esbuild, root, onHmrMessage() {}, basePath: '/preview', port: 5173 });
const names = ['Card', ...components];
const responses = await Promise.all(names.map((name) => {
  const path = `/src/components/${name}`;
  return server.handleRequest(new Request(`http://localhost/preview${path}`), path);
}));

// Evaluate the served modules and their imports, not their printed export
// spelling. Lowering to CommonJS supplies a loader in Bun for the same served
// graph, with the real React JSX runtime; Chrome live-probes exercise ESM.
const compiled = new Map();
for (const [i, response] of responses.entries()) {
  const body = await response.text();
  assert.equal(response.status, 200, `${names[i]}: ${body.slice(0, 200)}`);
  compiled.set(`/src/components/${names[i]}`, (await transform(body, { format: 'cjs', loader: 'js' })).code);
}
const requireReact = createRequire(new URL('../../packages/react/package.json', import.meta.url));
// The dev runtime: the dev server compiles JSX with jsxDev, as Vite does.
const jsx = requireReact('react/jsx-dev-runtime');
const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path).exports;
  const code = compiled.get(path);
  assert.ok(code !== undefined, `served graph is missing ${path}`);
  const module = { exports: {} };
  cache.set(path, module);
  const require = (specifier) => specifier === '/preview/@modules/react/jsx-dev-runtime'
    ? jsx
    : load(posix.resolve(posix.dirname(path), specifier));
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return module.exports;
}
const Card = load('/src/components/Card').default;
assert.equal(typeof Card, 'function', 'Card must provide the default export its importers request');
for (const name of components) {
  const Panel = load(`/src/components/${name}`).default;
  assert.equal(typeof Panel, 'function', `${name} must provide a default component`);
  const element = Panel();
  assert.equal(element.type, Card, `${name} imports the shared Card component`);
  const rendered = Card(element.props);
  assert.equal(rendered.type, 'div');
  assert.deepEqual(rendered.props, { className: `card ${name}`, children: name });
}
assert.equal(instances.created, 1, 'the thirteen requests shared one instance');
releaseFacetHarness();
console.log('transform-preview-memory OK: thirteen concurrent requests render through Card under the wasm budget');
