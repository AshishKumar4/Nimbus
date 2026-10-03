#!/usr/bin/env bun
// The Vite dev server's stylesheets (facets/dev-stylesheet.ts): local
// @imports inlined by the CSS layer `vite build` bundles with, so an import's
// conditions, nesting and order mean in dev what they mean in a build, and
// url()s rooted under the dev server's base so an inlined sheet's url()s
// still name their files. Before this, a regex inlined `@import "x";` alone,
// one level deep, dropped conditions' meaning and left relative url()s of an
// inlined sheet pointing beside the importer.

import assert from 'node:assert/strict';
import { devStylesheet } from '../../packages/worker/src/facets/dev-stylesheet.ts';

const ROOT = 'home/user/app';
const BASE = '/s/sid/preview';

function vfs(files) {
  const at = new Map(Object.entries(files).map(([p, text]) => [`${ROOT}/${p}`, text]));
  const isDirectory = (p) => !at.has(p) && [...at.keys()].some((k) => k.startsWith(p.replace(/\/+$/, '') + '/'));
  return {
    exists: (p) => at.has(p) || isDirectory(p),
    isDirectory,
    readFileString: (p) => {
      if (!at.has(p)) throw new Error(`ENOENT ${p}`);
      return at.get(p);
    },
  };
}

const serve = (files, path = 'src/main.css') => devStylesheet(vfs(files), ROOT, BASE, `${ROOT}/${path}`);
const squash = (css) => css.replace(/\/\*[^*]*\*\/\n?/g, '').replace(/\s+/g, ' ').trim();

// Nested imports, conditions, an import's last place, remote imports hoisted.
{
  const css = await serve({
    'src/main.css': '@import "https://fonts.test/a.css";\n@import "./theme/vars.css" screen;\n@import "./base.css";\n@import "./theme/vars.css";\n.main { color: red }\n',
    'src/base.css': '@import "./theme/deep.css" layer(deep);\n.base { margin: 0 }\n',
    'src/theme/vars.css': ':root { --x: 1 }\n',
    'src/theme/deep.css': '.deep { padding: 0 }\n',
  });
  assert.equal(squash(css), '@import "https://fonts.test/a.css"; @layer deep { .deep{padding:0} } .base{margin:0} :root{--x: 1 } .main{color:red}');
  console.log('  ok  imports inlined as a build inlines them: nested, conditions kept, last place, remote hoisted');
}

// url()s, the importer's and an inlined sheet's, rooted at the dev server's base.
{
  const css = await serve({
    'src/main.css': '@import "./parts/card.css";\n.main { background: url(./img/a.png) }\n.abs { background: url(/public.png) }\n.ext { background: url(https://cdn.test/x.png), url(data:image/png;base64,AA==) }\n',
    'src/parts/card.css': '.card { background: url(../img/b.png?v=1#frag) }\n@font-face { src: url("./f o.woff2") format("woff2") }\n',
  });
  assert.equal(
    squash(css),
    `.card{background:url(${BASE}/src/img/b.png?v=1#frag)} @font-face{src:url(${BASE}/src/parts/f\\ o.woff2) format("woff2")} ` +
      `.main{background:url(${BASE}/src/img/a.png)} .abs{background:url(${BASE}/public.png)} .ext{background:url(https://cdn.test/x.png),url(data:image/png;base64,AA==)}`,
  );
  console.log('  ok  url()s of the sheet and of what it imports name their files from the project root');
}

// An import of no file stays an @import (hoisted, as a build hoists what it cannot inline).
{
  const css = await serve({ 'src/main.css': '@import "./missing.css";\n.main { color: red }\n' });
  assert.equal(squash(css), '@import "./missing.css"; .main{color:red}');
  console.log('  ok  an import of no file stays an @import for the browser');
}

// Tailwind's directives pass through for the dev server's own processing.
{
  const css = await serve({ 'src/main.css': '@tailwind base;\n@layer components { .btn { @apply px-4 py-2; } }\n' });
  assert.match(css, /@tailwind base;/);
  assert.match(css, /@layer components\{\.btn\{@apply px-4 py-2;?\}\}/);
  console.log('  ok  @tailwind and @apply pass through');
}

// A sheet the CSS layer refuses is served as written, the reason first.
{
  const css = await serve({ 'src/main.css': '@import ;\n.main { color: red }\n' });
  assert.match(css, /^\/\* Expected URL token \*\/\n@import ;\n/);
  console.log('  ok  a sheet the layer refuses is served as written, with the reason');
}

console.log('dev-stylesheet OK');
