// Projects tests/unit/vite-build-differential.mjs builds as the built-in
// `vite build` does (VITE_BUILD_OPTIONS: browser ESM, minified, hashed names
// under assets/, Vite's asset semantics) with esbuild-wasm 0.24.2 and with
// Nimbus's bundler. An app reports what it computed by assigning
// `globalThis.__result`; stylesheets are compared by meaning (see the test).

export const vitePublicDir = (name) => `/home/user/${name}/public`;
export const viteBuildOptions = (name) => ({
  bundle: true, format: 'esm', target: 'es2020', platform: 'browser', minify: true,
  outdir: `home/user/${name}/dist`,
  entryNames: 'assets/[name]-[hash]', chunkNames: 'assets/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  viteAssets: true, vitePublicDir: vitePublicDir(name),
});

// Bytes that are not UTF-8, for loaders that must keep bytes whole.
export const PNG = '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u00ff\u00fe';

export const VITE_PROJECTS = {
  'vite-asset-loaders': {
    entry: 'src/main.js',
    files: {
      'src/main.js': `import logo from './img/logo.png'; import raw from './img/note.txt?raw'; import inl from './img/logo.png?inline';
import url from './img/note.txt?url'; import pub from '/vite.svg'; import b64 from './img/logo.png?base64'; import svgInline from './img/icon.svg?inline';
import cssText from './styles/inline-me.css?inline'; import wasm from './img/mod.wasm';
globalThis.__result = { logo, raw, inl, url, pub, b64, svgInline, cssText, wasm, same: logo === new URL(logo, 'file:///x/').pathname.slice(3) };`,
      'src/img/logo.png': PNG,
      'src/img/note.txt': 'note text\n# with a hash % and 100%\n',
      'src/img/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
      'src/img/mod.wasm': '\u0000asm\u0001\u0000\u0000\u0000',
      'src/styles/inline-me.css': '.inlined { color: red }',
      'public/vite.svg': '<svg/>',
    },
  },
  // Every byte value through each byte loader: emitted (file, `.wasm` too under Vite), a data URL, base64, and binary.
  'vite-asset-bytes': {
    entry: 'src/main.js',
    files: {
      'src/main.js': `import file from './all.png'; import inl from './all.png?inline'; import b64 from './all.png?base64'; import wasm from './all.wasm'; import blob from './all.node';
globalThis.__result = { file, inl, b64, wasm, blob: Array.from(blob).join(','), kind: Object.prototype.toString.call(blob) };`,
      'src/all.png': Uint8Array.from({ length: 256 }, (_, i) => i),
      'src/all.wasm': Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
      'src/all.node': Uint8Array.from({ length: 256 }, (_, i) => (i * 7) & 255),
    },
  },
  // Required rather than imported: each asset module is its value, not a namespace.
  'vite-asset-required': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import assets from './assets.cjs';\nglobalThis.__result = assets;",
      'src/assets.cjs': "module.exports = { logo: require('./all.png'), inl: require('./all.png?inline'), b64: require('./all.png?base64'), raw: require('./note.txt?raw'), blob: Array.from(require('./all.node')).join(',') };",
      'src/all.png': Uint8Array.from({ length: 256 }, (_, i) => i),
      'src/all.node': Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
      'src/note.txt': 'note text\n',
    },
  },
  // ── The 3b review (InstitutionalPinniped): each a reproduced difference ──
  // A 13-sheet chain, each importing the next twice: every sheet is resolved
  // and loaded once, as esbuild does (the expansion was 8,190 of each).
  'vite-review-import-chain': {
    entry: 'src/main.js',
    compareReads: true,
    files: {
      'src/main.js': "import './c0.css';\nglobalThis.__result = 1;\n",
      ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`src/c${i}.css`, i < 12 ? `@import "./c${i + 1}.css";\n@import "./c${i + 1}.css";\n.c${i} { color: red }\n` : '.c12 { color: blue }\n'])),
    },
  },
  // Asset paths are written into the script as strings, escaped: a file name
  // with a backtick or `${`, and a user string that looks like a marker.
  'vite-review-asset-names-escaped': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import tick from './a`b.png'; import tpl from './logo${1+1}.png';\nglobalThis.__result = { tick, tpl, user: '__NIMBUS_ASSET_0__', user2: `__NIMBUS_ASSET_1__` };\n",
      'src/a`b.png': PNG,
      'src/logo${1+1}.png': PNG + 'x',
    },
  },
  // A layer-ordering statement may come before @import.
  'vite-review-layer-statement-before-import': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@layer low, high;\n@import "./a.css" layer(high);\n.m { color: m }\n',
      'src/a.css': '.a { color: a }\n',
    },
  },
  // Dropping an earlier duplicate keeps the layer order it set (esbuild: an empty `@layer a;`).
  'vite-review-duplicate-named-layer': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" layer(a);\n@import "./b.css" layer(b);\n@import "./a.css" layer(a);\n',
      'src/a.css': '.x { color: red }\n',
      'src/b.css': '.x { color: blue }\n',
    },
  },
  // An external import inside an imported sheet keeps its importers' conditions.
  'vite-review-external-inherits-conditions': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" layer(a);\n@import "./b.css" screen;\n.m { color: m }\n',
      'src/a.css': '@import "https://e.test/a.css";\n.a { color: a }\n',
      'src/b.css': '@import "https://e.test/b.css" print;\n.b { color: b }\n',
    },
  },
  // Duplicate external imports keep their last place.
  'vite-review-external-last-occurrence': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "https://e.test/A.css";\n@import "https://e.test/B.css";\n@import "https://e.test/A.css";\n.m { color: m }\n',
    },
  },
  // Conditions compare by token: whitespace inside a string is significant.
  'vite-review-condition-string-whitespace': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" supports(font-variation-settings: "wght" 400);\n@import "./a.css" supports(font-variation-settings: "w g h t" 400);\n',
      'src/a.css': '.a { color: red }\n',
    },
  },
  // A `;` inside a nested block of a condition does not end the @import.
  'vite-review-semicolon-in-supports': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" supports(--x: {foo:bar;});\n.y { color: y }\n',
      'src/a.css': '.a { color: red }\n',
    },
  },
  // A comment between two compound selectors is not whitespace; NBSP is a name character.
  'vite-review-selectors': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      // UTF-8 bytes: a no-break space in a class name.
      'src/main.css': new TextEncoder().encode('.x/**/.y { color: red }\n.p\u00a0q { color: blue }\n.r /* c */ .s { color: green }\n'),
    },
  },
  // An escaped at-keyword is still @import.
  'vite-review-escaped-import': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@\\69mport "./a.css";\n.m { color: m }\n',
      'src/a.css': '.a { color: a }\n',
    },
  },
  // A bad url() token is not a URL to resolve.
  'vite-review-bad-url': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '.a { background: url(./a b.png) }\n.b { color: b }\n',
      'src/a b.png': PNG,
    },
  },
  // A stylesheet cannot @import a module of another loader.
  'vite-review-import-text-loader': {
    entry: 'src/main.js',
    fails: true,
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.txt";\n.m { color: m }\n',
      'src/a.txt': 'not css',
    },
  },
  'vite-review-import-raw-css': {
    entry: 'src/main.js',
    fails: true,
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css?raw";\n.m { color: m }\n',
      'src/a.css': '.a { color: a }\n',
    },
  },
  // Data URLs keep every byte (a UTF-8 BOM too) and take esbuild's MIME type,
  // by extension or else by sniffing the bytes.
  'vite-review-data-urls': {
    entry: 'src/main.js',
    files: {
      'src/main.js': `import bom from './bom.txt?inline'; import manifest from './app.webmanifest?inline'; import page from './page.unknownext?inline';
import bin from './bin.txt?inline'; import eot from './f.eot?inline'; import md from './r.md?inline'; import xhtml from './p.xhtml?inline';
import sfnt from './f.sfnt?inline'; import gifish from './g.data?inline'; import plain from './t.data?inline';
globalThis.__result = { bom, manifest, page, bin, eot, md, xhtml, sfnt, gifish, plain };`,
      'src/bom.txt': '\u00ef\u00bb\u00bfwith a bom\n',
      'src/app.webmanifest': '{"name":"app"}',
      'src/page.unknownext': '<!DOCTYPE html><html><body>hi</body></html>',
      'src/bin.txt': '\u0000\u0001\u0002\u00ff binary',
      'src/f.eot': 'eot',
      'src/r.md': '# readme',
      'src/p.xhtml': '<html/>',
      'src/f.sfnt': 'sfnt',
      'src/g.data': 'GIF89a....',
      'src/t.data': 'just some text',
    },
  },
  // Two different files at one output path are an error, as in esbuild.
  'vite-review-asset-name-collision': {
    entry: 'src/main.js',
    fails: true,
    options: { assetNames: 'assets/[name]' },
    files: {
      'src/main.js': "import a from './a/img.png'; import b from './b/img.png';\nglobalThis.__result = { a, b };\n",
      'src/a/img.png': PNG,
      'src/b/img.png': PNG + 'b',
    },
  },
  // esbuild's layer bookkeeping, each branch: names inside layer blocks,
  // anonymous layers, a sheet that only orders layers, statements merged.
  'vite-css-layers-graph': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@layer base;\n@import "./nested.css" layer(z);\n@import "./order.css" supports(display: grid);\n@import "./anon.css" layer;\n@import "./order.css" supports(display: grid);\n@import "./nested.css" layer(z) screen;\n@import "./anon.css" layer;\n@import "./plain.css";\n@import "./plain.css" layer(p);\n.m { color: m }\n',
      'src/nested.css': '@layer x { @layer y { .n { color: n } } }\n@layer w;\n@media print { @layer v { .p { color: p } } }\n',
      'src/order.css': '@layer one, two;\n@layer three;\n',
      'src/anon.css': '@layer inner { .a { color: a } }\n.a2 { color: a2 }\n',
      'src/plain.css': '.plain { color: plain }\n',
    },
  },
  'vite-css-layers-external': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nimport './second.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@layer first;\n@import "https://e.test/a.css" layer(ext) screen;\n@import "./child.css" layer(c) supports(display: flex) print;\n.m { color: m }\n',
      'src/child.css': '@import "https://e.test/b.css" layer(inner) supports(display: grid) (min-width: 1px);\n@import url(//cdn.test/c.css);\n.c { color: c }\n',
      'src/second.css': '@import "https://e.test/a.css" layer(ext) screen;\n@import "./child.css" layer(c) supports(display: flex) print;\n.s { color: s }\n',
    },
  },
  'vite-css-charset-and-legal': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './a.css';\nimport './b.css';\nglobalThis.__result = 1;\n",
      'src/a.css': '@charset "utf-8";\n/*! license a */\n@import "./b.css";\n.a { color: a /* inner */ }\n/* @preserve kept */\n',
      'src/b.css': '/*! license b */\n.b { color: b }\n',
    },
  },
  'vite-css-rules': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './a.css';\nimport './j1.css';\nimport { o } from './other.js';\nimport './base.css';\nglobalThis.__result = { o };\n",
      'src/other.js': "import './j2.css';\nimport './j1.css';\nexport const o = 1;\n",
      'src/a.css': '@charset "utf-8";\n@import "./base.css";\n@import url(./theme.css);\n@import "./base.css";\n@import "./m.css" screen;\n@import \'./s.css\' supports(display: grid);\n@import "./l.css" layer(lay);\n@import "./all.css" layer(x) supports(display: flex) print and (min-width: 1px);\n@import url(http://e.test/x.css);\n@import "//cdn.test/y.css" screen;\n@layer one, two;\n.a { color: #ff0000; margin: 0px 0px; }\n.a > .b , .c:hover::after { content: "a } b ; c"; }\n',
      'src/base.css': '/* base */\nhtml { box-sizing: border-box }\n.base { color: blue; }\n',
      'src/theme.css': '@import "./deep.css";\n.theme { color: green; }\n',
      'src/deep.css': '.deep { color: gray; }\n',
      'src/m.css': '.m { color: #000 }\n',
      'src/s.css': '.s { display: grid }\n',
      'src/l.css': '.l { width: calc(100% - 2px) }\n',
      'src/all.css': '.all { color: rgb(1, 2, 3) }\n',
      'src/j1.css': `.j1 { background: url(./img/x.png) no-repeat; b: url( "./img/x.png" ); c: url('./img/y.svg'); d: url(data:image/png;base64,AA==); e: url(#frag); f: url(https://e.test/z.png); g: url(//cdn.test/q.png); }
@font-face { font-family: F; src: url(./img/font.woff2) format("woff2"), url("./img/font.woff2"); }
@media (max-width: 10px) { .j1 { padding: 2px } }
.esc { background: url(./img/sp\\ ace.png) }\n`,
      'src/j2.css': '.j2 { color: j2 } /*! legal */\n',
      'src/img/x.png': PNG,
      'src/img/y.svg': '<svg/>',
      'src/img/font.woff2': 'wOF2\u0000\u0001',
      'src/img/sp ace.png': 'space',
    },
  },
  'vite-css-import-cycle-and-conditions': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './one.css';\nimport './two.css';\nglobalThis.__result = 1;\n",
      'src/one.css': '@import "./two.css" screen;\n.one { color: red }\n',
      'src/two.css': '@import "./one.css";\n.two { color: blue }\n',
    },
  },
  'vite-css-edges': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './edges.css';\nconst lazy = () => import('./lazy.js');\nglobalThis.__result = { lazy: typeof lazy };\n",
      'src/lazy.js': "import './lazy.css';\nexport default 1;\n",
      'src/lazy.css': '.lazy { color: purple }\n',
      'src/edges.css': [
        '@import "./anon.css" layer;',
        '@import "./twice.css" screen;',
        '@import "./twice.css" print;',
        '@import url("./both.css") supports(display:grid) (min-width: 2px);',
        '.e { content: "url(./not-a-url.png)"; background: url( ./img/a.png?inline ) ; color: red !important }',
        '.e2 { background: url(./img/a\\.png), url("./img/a.png") }',
        '@keyframes spin { 0% { transform: rotate(0deg) } 100% { transform: rotate(360deg) } }',
        '.parent { color: red; & .child { color: blue } }',
        '@font-face { font-family: "X Y"; src: url(./img/f.woff) format("woff") }',
        '/* url(./img/missing.png) in a comment */',
      ].join('\n'),
      'src/anon.css': '.anon { color: anon }\n',
      'src/twice.css': '.twice { color: twice }\n',
      'src/both.css': '.both { color: both }\n',
      'src/img/a.png': PNG,
      'src/img/f.woff': 'wOFF',
    },
  },
  // @import conditions with tokens a re-scan of their text misreads: quoted
  // parens and commas, url() with parens, escapes, layer() then media, comments.
  'vite-css-cond-quoted-paren': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" supports(selector([data-x=")"]));\n.m { color: m }\n',
      'src/a.css': '.a { color: a }',
    },
  },
  'vite-css-cond-quoted-comma': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" supports(content: "a, b") screen, print;\n@import "./b.css" supports(font-family: "x)y") (min-width: 2px);\n.m { color: m }\n',
      'src/a.css': '.a { color: a }',
      'src/b.css': '.b { color: b }',
    },
  },
  'vite-css-cond-url-parens': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import url("./a(1).css") supports(background: url("x)y.png"));\n@import url(./b\\(2\\).css) supports(background: url(x\\)y.png)) print;\n.m { color: m }\n',
      'src/a(1).css': '.a { color: a }',
      'src/b(2).css': '.b { color: b }',
    },
  },
  'vite-css-cond-escapes': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" layer(x\\.y) screen;\n@import "./b.css" supports(--x: "\\)") print;\n.m { color: m }\n',
      'src/a.css': '.a { color: a }',
      'src/b.css': '.b { color: b }',
    },
  },
  'vite-css-cond-layer-media': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" layer(base) screen and (min-width: 1px);\n@import "./b.css" layer(top)screen and (min-width: 2px);\n.m { color: m }\n',
      'src/a.css': '.a { color: a }',
      'src/b.css': '.b { color: b }',
    },
  },
  'vite-css-cond-comments': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./a.css" /* c */ layer(x) /* ) */ supports(display: /* ( */ grid) /* m */ screen;\n.m { color: m }\n',
      'src/a.css': '.a { color: a }',
    },
  },
  // Conditions nest: an imported sheet's own @import conditions inside its importer's.
  'vite-css-cond-nested': {
    entry: 'src/main.js',
    files: {
      'src/main.js': "import './main.css';\nglobalThis.__result = 1;\n",
      'src/main.css': '@import "./outer.css" layer(l) screen;\n.m { color: m }\n',
      'src/outer.css': '@import "./inner.css" supports(content: "a)") print;\n.o { color: o }\n',
      'src/inner.css': '.i { color: i }\n',
    },
  },
  'vite-react-app': {
    entry: 'src/main.tsx',
    files: {
      'src/main.tsx': `import React from 'react';
import './index.css';
import logo from './assets/react.svg';
import { App } from './App';
const el = <App logo={logo} />;
globalThis.__result = { type: (el as any).type === App, props: Object.keys((el as any).props), html: App({ logo }) };`,
      'src/App.tsx': `import React from 'react';
import './App.css';
type Props = { logo: string };
export function App({ logo }: Props) { const items = [1, 2].map((n) => <li key={n}>{n}</li>); return <div className="app"><img src={logo} alt="logo" />{items}</div>; }`,
      'src/index.css': ':root { font-family: Inter, system-ui; color-scheme: light dark; }\nbody { margin: 0; display: flex; }\n',
      'src/App.css': '.app { text-align: center } .app img { height: 6em; background: url(./assets/react.svg) }\n',
      'src/assets/react.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    },
  },
  'vite-no-css': {
    entry: 'src/main.js',
    files: { 'src/main.js': "import { n } from './n.js';\nconst p = import('./lazy.js');\nglobalThis.__result = { n, lazy: typeof p.then };\n", 'src/n.js': 'export const n = 2 ** 10;', 'src/lazy.js': 'export default 1;' },
  },
  'vite-css-public-url-fails': {
    entry: 'src/main.js', fails: true,
    files: { 'src/main.js': "import './a.css';", 'src/a.css': '.a { background: url("/vite.svg") }\n', 'public/vite.svg': '<svg/>' },
  },
  'vite-css-unknown-suffix-fails': {
    entry: 'src/main.js', fails: true,
    files: { 'src/main.js': "import './a.css';", 'src/a.css': '@font-face { src: url(./f.woff2?#iefix) }\n', 'src/f.woff2': 'x' },
  },
  'vite-css-bare-url-fails': {
    entry: 'src/main.js', fails: true,
    files: { 'src/main.js': "import './a.css';", 'src/a.css': '.a { background: url(img/x.png) }\n', 'src/img/x.png': 'x' },
  },
  'vite-css-missing-import-fails': {
    entry: 'src/main.js', fails: true,
    files: { 'src/main.js': "import './a.css';", 'src/a.css': '@import "./missing.css";\n.x { color: red }\n' },
  },
  'vite-css-misplaced-import-kept': {
    // After a rule an @import does nothing in a browser; neither bundler follows it.
    entry: 'src/main.js',
    files: { 'src/main.js': "import './a.css';", 'src/a.css': '.x { color: red }\n@import "./missing.css";\n' },
  },
  'vite-unknown-import-suffix-fails': {
    entry: 'src/main.js', fails: true,
    files: { 'src/main.js': "import W from './w.js?worker';\nglobalThis.__result = W;", 'src/w.js': 'self.onmessage = () => {};' },
  },
};
