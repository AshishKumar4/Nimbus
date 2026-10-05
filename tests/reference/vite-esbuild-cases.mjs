// The projects the built-in Vite dev server is compared with real Vite on
// (tests/unit/vite-esbuild-differential.mjs): create-vite's TypeScript
// templates as they are, and projects that each turn one of the settings
// Vite's esbuild plugin reads — a tsconfig's eleven fields (found by
// tsconfck: solutions, extends, nested configs), vite.config's `esbuild`,
// and what @vitejs/plugin-react and @preact/preset-vite put in it.
//
// tests/reference/record-vite.mjs runs real Vite on each and writes what its
// `vite:esbuild` transform made of each module to
// tests/fixtures/vite-esbuild-reference.json; the differential fails when
// this list and that file drift apart. Each module's source exports what
// running it makes observable: JSX as recorded calls, class fields' own keys
// and setter calls, decorator order, which imports load, whether `import()`
// and `import.meta` survive.

import { createHash } from 'node:crypto';

/** JSX in a .tsx module, an `import()` and `import.meta` beside it. */
const JSX_APP = `function Item(props: { label: string }) {
  return <li>{props.label}</li>;
}
const rest = { id: 'r' };
export const tree = (
  <>
    <div className="a" {...rest} key="k">text</div>
    <Item label="x" />
  </>
);
export const meta = typeof import.meta.url;
export const loaded = await import('dep').then((m) => m.name, (e) => 'failed: ' + e.constructor.name);
`;

/** The same in a .jsx module. */
const JSX_PLAIN = `function Item(props) {
  return <li>{props.label}</li>;
}
export const tree = (
  <>
    <div className="a">text</div>
    <Item label="x" />
  </>
);
`;

/** Classic JSX with React in scope. */
const JSX_REACT_CLASSIC = `import React from 'react';
export const tree = <><div id="a">x</div></>;
export const scope = typeof React;
`;

/** Preact's own classic factory in scope. */
const JSX_PREACT_CLASSIC = `import { h, Fragment } from 'preact';
export const tree = <><b>hi</b></>;
export const scope = [typeof h, typeof Fragment];
`;

/** JSX with nothing in scope: automatic runtimes import their own. */
const JSX_BARE = `export const tree = <><b>hi</b></>;
`;

/** Class fields: own keys under define semantics, setter calls under assign semantics. */
const FIELDS = `const log: string[] = [];
class Base {
  set x(v: number) { log.push('set ' + v); }
}
export class Model extends Base {
  x = 1;
  declare y: number;
  static s = 2;
}
export const keys = Object.keys(new Model());
export { log };
export const statics = Model.s;
export const meta = typeof import.meta.url;
export const loaded = await import('dep').then((m) => m.name, (e) => 'failed: ' + e.constructor.name);
`;

/** Legacy decorators, in the order they run. */
const DECORATORS = `const order: string[] = [];
function d(name: string) {
  return (_target: unknown, key?: string) => { order.push(name + ':' + (key ?? 'class')); };
}
@d('class')
export class Element {
  @d('field') field = 1;
  @d('method') method() {}
}
export const made = typeof Element;
export { order };
`;

/** Value and type imports, some unused: which a module keeps. */
const IMPORTS = `import { used, unused } from 'dep';
import type { Shape } from 'dep';
import { type Kind, other } from 'dep';
export const value: Shape | Kind | string = used;
`;

/** A define the transform replaces. */
const DEFINED = `export const flag: string = __FLAG__;
`;

// ── create-vite's templates (6.5.0), their TypeScript configs as written ──

const REACT_TS_APP = `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}
`;
const NODE_TS = `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["vite.config.ts"]
}
`;
const SOLUTION = `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
`;
const PREACT_TS_APP = REACT_TS_APP.replace(
  '    "jsx": "react-jsx",\n',
  '    "jsx": "react-jsx",\n    "jsxImportSource": "preact",\n',
).replace('    "skipLibCheck": true,\n', `    "skipLibCheck": true,
    "paths": {
      "react": ["./node_modules/preact/compat/"],
      "react-dom": ["./node_modules/preact/compat/"]
    },
`);
const VANILLA_TS = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}
`;
const LIT_TS = VANILLA_TS.replace('    "useDefineForClassFields": true,\n', '    "experimentalDecorators": true,\n    "useDefineForClassFields": false,\n');

const reactConfig = (call = 'react()', extra = '') => `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [${call}],${extra}
})
`;
const preactConfig = `import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact()],
})
`;

/** A tsconfig as JSON text. */
const tsconfig = (value) => JSON.stringify(value, null, 2) + '\n';

/**
 * Each case: the project's files (under its root; `node_modules/` holds
 * packages a tsconfig extends), and the modules transformed. `versions`
 * says why Vite 5 or 6 makes another module of it than Vite 7, where one
 * does; the server makes Vite 7's. `fallback`
 * names a case where the built-in server keeps its own JSX defaults (no
 * vite.config and no tsconfig JSX setting, decided 2026-10-05) or reads
 * vite.config statically and cannot; the differential expects it to differ
 * from Vite there, and says how.
 */
export const CASES = {
  // ── create-vite's templates ──
  'create-vite react-ts': {
    files: {
      'vite.config.ts': reactConfig(), 'tsconfig.json': SOLUTION, 'tsconfig.app.json': REACT_TS_APP, 'tsconfig.node.json': NODE_TS,
      'src/App.tsx': JSX_APP, 'src/model.ts': FIELDS, 'src/imports.ts': IMPORTS,
    },
    modules: ['src/App.tsx', 'src/model.ts', 'src/imports.ts'],
  },
  'create-vite preact-ts': {
    files: {
      'vite.config.ts': preactConfig, 'tsconfig.json': SOLUTION, 'tsconfig.app.json': PREACT_TS_APP, 'tsconfig.node.json': NODE_TS,
      'src/app.tsx': JSX_APP, 'src/model.ts': FIELDS,
    },
    modules: ['src/app.tsx', 'src/model.ts'],
  },
  'create-vite vanilla-ts': {
    files: { 'tsconfig.json': VANILLA_TS, 'src/model.ts': FIELDS, 'src/imports.ts': IMPORTS },
    modules: ['src/model.ts', 'src/imports.ts'],
  },
  'create-vite lit-ts': {
    files: { 'tsconfig.json': LIT_TS, 'src/my-element.ts': DECORATORS, 'src/model.ts': FIELDS },
    modules: ['src/my-element.ts', 'src/model.ts'],
  },

  // ── The tsconfig, as tsconfck finds and reads it ──
  'no tsconfig: useDefineForClassFields false': {
    files: { 'vite.config.ts': reactConfig(), 'src/model.ts': FIELDS, 'src/App.tsx': JSX_APP },
    modules: ['src/model.ts', 'src/App.tsx'],
  },
  'tsconfig target ES2020 alone': {
    files: { 'vite.config.ts': reactConfig(), 'tsconfig.json': tsconfig({ compilerOptions: { target: 'ES2020' } }), 'src/model.ts': FIELDS },
    modules: ['src/model.ts'],
  },
  'tsconfig target ESNext alone': {
    files: { 'vite.config.ts': reactConfig(), 'tsconfig.json': tsconfig({ compilerOptions: { target: 'ESNext' } }), 'src/model.ts': FIELDS },
    modules: ['src/model.ts'],
  },
  'tsconfig extends a package subpath': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ extends: '@nimbus-test/tsconfig/preact.json', include: ['src'] }),
      'node_modules/@nimbus-test/tsconfig/package.json': JSON.stringify({ name: '@nimbus-test/tsconfig', version: '1.0.0', exports: { './preact.json': './preact.json' } }),
      'node_modules/@nimbus-test/tsconfig/preact.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact', useDefineForClassFields: false } }),
      'src/app.tsx': JSX_BARE, 'src/model.ts': FIELDS,
    },
    modules: ['src/app.tsx', 'src/model.ts'],
  },
  'tsconfig extends a package by name': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ extends: '@nimbus-test/tsconfig-base' }),
      'node_modules/@nimbus-test/tsconfig-base/package.json': JSON.stringify({ name: '@nimbus-test/tsconfig-base', version: '1.0.0' }),
      'node_modules/@nimbus-test/tsconfig-base/tsconfig.json': tsconfig({ compilerOptions: { experimentalDecorators: true, verbatimModuleSyntax: true } }),
      'src/my-element.ts': DECORATORS, 'src/imports.ts': IMPORTS,
    },
    modules: ['src/my-element.ts', 'src/imports.ts'],
  },
  'tsconfig extends an array, the later winning': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ extends: ['./base.json', './jsx'], compilerOptions: { useDefineForClassFields: true } }),
      'base.json': tsconfig({ compilerOptions: { jsx: 'react', jsxFactory: 'h', useDefineForClassFields: false } }),
      'jsx.json': '\ufeff{\n  // A BOM, comments and a dangling comma, as TypeScript reads them.\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact", },\n}\n',
      'src/app.tsx': JSX_BARE, 'src/model.ts': FIELDS,
    },
    modules: ['src/app.tsx', 'src/model.ts'],
  },
  'a solution whose reference includes ${configDir}': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ files: [], references: [{ path: './config/tsconfig.app.json' }] }),
      'config/tsconfig.app.json': tsconfig({ extends: '../tsconfig.shared.json', compilerOptions: { jsx: 'react-jsx' } }),
      'tsconfig.shared.json': tsconfig({ compilerOptions: { jsxImportSource: 'preact' }, include: ['${configDir}/../src'] }),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
    versions: 'Vite 5.4.21 bundles a tsconfck that replaces ${configDir} only in the config it finds, not in a solution\'s references '
      + '(tsconfck 3.1.5 replaces it in both): its reference includes nothing, and the module compiles with no tsconfig. '
      + 'The server reads as tsconfck 3.1.6, as Vite 6 and 7 do.',
  },
  'a nested tsconfig for its directory': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: true } }),
      'src/legacy/tsconfig.json': tsconfig({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }),
      'src/App.tsx': JSX_APP, 'src/model.ts': FIELDS, 'src/legacy/my-element.ts': DECORATORS, 'src/legacy/model.ts': FIELDS,
    },
    modules: ['src/App.tsx', 'src/model.ts', 'src/legacy/my-element.ts', 'src/legacy/model.ts'],
  },
  'a solution with files and exclude': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({
        compilerOptions: { jsx: 'react-jsx' },
        references: [{ path: './tsconfig.listed.json' }, { path: './tsconfig.rest.json' }],
        include: ['src/root'],
      }),
      'tsconfig.listed.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' }, files: ['src/listed.tsx'] }),
      'tsconfig.rest.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@emotion/react' }, include: ['src/**/*'], exclude: ['src/skipped*'] }),
      'src/root/app.tsx': JSX_BARE, 'src/listed.tsx': JSX_BARE, 'src/other.tsx': JSX_BARE, 'src/skipped.tsx': JSX_BARE,
    },
    modules: ['src/root/app.tsx', 'src/listed.tsx', 'src/other.tsx', 'src/skipped.tsx'],
  },
  'tsconfig extends a package whose exports conditions come in order': {
    files: {
      'tsconfig.json': tsconfig({ extends: '@nimbus-test/cond' }),
      // Node takes the first key that matches, in the object's order: `default` here, before `require`.
      'node_modules/@nimbus-test/cond/package.json': JSON.stringify({
        name: '@nimbus-test/cond', version: '1.0.0', exports: { '.': { default: './preact.json', require: './emotion.json' } },
      }),
      'node_modules/@nimbus-test/cond/preact.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }),
      'node_modules/@nimbus-test/cond/emotion.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@emotion/react' } }),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
  },
  'a solution\'s reference extends \'.\'': {
    files: {
      'tsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' }, files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': tsconfig({ extends: '.', include: ['src'] }),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
    versions: 'Vite 5.4.21 and 6.4.3 bundle a tsconfig reader older than tsconfck 3.1.6, which resolves an `extends` of \'.\' with '
      + 'require.resolve: the project directory, which has no index.js, so the module fails. tsconfck 3.1.6, which Vite 7.3.6 bundles, '
      + 'reads \'./tsconfig.json\'; so does the server.',
  },
  'esbuild.tsconfigRaw as a string, beside a tsconfig that cannot be read': {
    files: {
      'vite.config.js': `export default {\n  esbuild: { tsconfigRaw: ${JSON.stringify(JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }))} },\n};\n`,
      'tsconfig.json': tsconfig({ extends: '@nimbus-test/missing/tsconfig.json' }),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
  },
  'a jsconfig.json is not a tsconfig': {
    files: {
      'vite.config.ts': reactConfig(),
      'jsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
  },
  'tsconfig extends what does not resolve': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ extends: '@nimbus-test/missing/tsconfig.json' }),
      'src/model.ts': FIELDS,
    },
    modules: ['src/model.ts'],
  },
  'preserveValueImports and importsNotUsedAsValues': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ compilerOptions: { preserveValueImports: true, importsNotUsedAsValues: 'error' } }),
      'src/imports.ts': IMPORTS,
    },
    modules: ['src/imports.ts'],
  },
  'a .jsx module reads no tsconfig': {
    files: {
      'vite.config.ts': reactConfig(),
      'tsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }),
      'src/App.jsx': JSX_PLAIN, 'src/app.tsx': JSX_BARE,
    },
    modules: ['src/App.jsx', 'src/app.tsx'],
  },

  // ── vite.config's esbuild options, and the plugins' ──
  'esbuild JSX options win over the tsconfig\'s': {
    files: {
      'vite.config.js': "export default {\n  esbuild: { jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment' },\n};\n",
      'tsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }),
      'src/view.tsx': JSX_PREACT_CLASSIC,
    },
    modules: ['src/view.tsx'],
  },
  'esbuild jsxInject': {
    files: {
      'vite.config.js': "export default {\n  esbuild: { jsxInject: \"import React from 'react'\", jsx: 'transform' },\n};\n",
      'src/app.tsx': JSX_BARE, 'src/model.ts': FIELDS,
    },
    modules: ['src/app.tsx', 'src/model.ts'],
  },
  'esbuild define': {
    files: { 'vite.config.ts': reactConfig('react()', "\n  esbuild: { define: { __FLAG__: '\"on\"' } },"), 'src/flag.ts': DEFINED },
    modules: ['src/flag.ts'],
  },
  'esbuild jsxDev false': {
    files: { 'vite.config.ts': reactConfig('react()', '\n  esbuild: { jsxDev: false },'), 'src/app.tsx': JSX_BARE },
    modules: ['src/app.tsx'],
  },
  'esbuild jsxImportSource beside plugin-react': {
    files: { 'vite.config.ts': reactConfig('react()', "\n  esbuild: { jsxImportSource: '@emotion/react' },"), 'src/app.tsx': JSX_BARE },
    modules: ['src/app.tsx'],
  },
  'plugin-react jsxImportSource': {
    files: { 'vite.config.ts': reactConfig("react({ jsxImportSource: '@emotion/react' })"), 'src/app.tsx': JSX_BARE },
    modules: ['src/app.tsx'],
  },
  'plugin-react classic runtime': {
    files: {
      'vite.config.ts': reactConfig("react({ jsxRuntime: 'classic' })"),
      'tsconfig.json': tsconfig({ compilerOptions: { jsx: 'react-jsx' } }),
      'src/app.tsx': JSX_REACT_CLASSIC,
    },
    modules: ['src/app.tsx'],
  },
  'no vite.config, no plugin': {
    files: { 'tsconfig.json': tsconfig({ compilerOptions: { strict: true } }), 'src/app.tsx': JSX_REACT_CLASSIC },
    modules: ['src/app.tsx'],
    fallback: 'with no vite.config and no tsconfig JSX setting the built-in server keeps its own JSX default, the automatic React runtime, where Vite with no plugin compiles React.createElement',
  },
  'no vite.config, a module importing preact': {
    files: { 'src/view.tsx': JSX_PREACT_CLASSIC },
    modules: ['src/view.tsx'],
    fallback: 'with no vite.config and no tsconfig JSX setting the built-in server compiles a module importing preact with h and Fragment; Vite compiles React.createElement',
  },
  'a computed esbuild value': {
    files: {
      'vite.config.ts': reactConfig('react()', "\n  esbuild: { jsxImportSource: process.env.NIMBUS_TEST_UNSET ?? 'preact' },"),
      'src/app.tsx': JSX_BARE,
    },
    modules: ['src/app.tsx'],
    fallback: 'vite.config is read statically: a computed esbuild option is warned about once and left out, where Vite evaluates it',
  },
};

/** A case's identity: what it is made of. The differential recomputes it, and fails where the fixture's differs. */
export function caseDigest(definition) {
  const { files, modules } = definition;
  const ordered = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return createHash('sha256').update(JSON.stringify({ files: ordered, modules })).digest('hex').slice(0, 32);
}
