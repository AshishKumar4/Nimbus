#!/usr/bin/env bun
/**
 * scanProjectImports reads a project's browser source once for both things
 * the pre-bundle needs: every bare specifier imported (subpaths and their
 * package roots, dynamic and side-effect imports, react's JSX runtimes) and
 * the names imported from each package root (for barrel packages). Both come
 * from the same files: six directories deep, without node_modules, .git,
 * dist, build, non-JS files, or the build tools' configs at the project root.
 * An import inside a comment names nothing; one after JSX is still read,
 * after a generic function type too, and a file the lexer cannot decide is
 * read by the parser it is given.
 *
 * With a budget, it reads no file over its per-file bytes, none past its
 * total, and stops at the first file past its count; what it left unread is
 * said (`unread`), and with nothing left unread, `unread` is null.
 */

import assert from 'node:assert/strict';
import { scanProjectImports } from '../../packages/worker/src/runtime/barrel-synthesizer.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const files = {
  'app/src/main.tsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { Home, Zap as Z, type IconProps } from 'lucide-react';\nimport './style.css';\nimport 'normalize.css?inline';\nconst m = import('lodash-es/debounce');\n",
  // JSX before an import: a closing tag's slash is not a regex, JSX text is
  // not code (an apostrophe opens no string, a URL opens no comment), and an
  // expression inside JSX is code again.
  'app/src/view.tsx': "const view = <div></div>; import { Icon } from '@scope/icons';\nconst page = (\n  <p>See http://example.com <Icon /> {cond && <b>x</b>} {import('lazy-pkg')}</p>\n);\nconst note = <p>Don't</p>; import Quoted from 'after-apostrophe';\nfunction render() { return <a href=\"/x\">open</a>; }\nimport Tail from 'tail-pkg';\n// A generic arrow and a type argument are not JSX.\nconst id = <T,>(x: T) => x; const n = useState<number>(0);\nimport { After } from 'after-generics';\n",
  // A generic function type before JSX: its `<T>` is no element, and the JSX
  // after it is still read as JSX.
  'app/src/typed.tsx': "type F = <T>(x: T) => T; const view = <div></div>; import { Icon } from '@scope/icons';\nimport { Typed } from '@scope/typed';\n",
  // An element the lexer cannot close: this file is read by the parser.
  'app/src/unclosed.jsx': "const a = <div>never closed; import Parsed from '@scope/parsed';\n",
  'app/src/util.ts': "export { a } from '@scope/pkg/sub';\nimport D, { b } from '@scope/pkg';\nimport { x } from 'node:fs';\nimport { y } from './local';\n// import { Gone } from 'commented-out';\n/* import 'also-commented'; */\nexport{c}from\"minified\";\n",
  // Six directories below the project: read.
  'app/src/a/b/c/d/e/deep.js': "import { Deep } from 'lucide-react';\nimport 'deep-pkg';\n",
  // Seven: not read.
  'app/src/a/b/c/d/e/f/deeper.js': "import { Deeper } from 'lucide-react';\nimport 'deeper-pkg';\n",
  // A build tool's config runs server-side: not browser source.
  'app/vite.config.ts': "import { defineConfig } from 'vite';\nimport { Cfg } from 'lucide-react';\n",
  'app/src/config/site.config.ts': "import { Site } from 'site-config-pkg';\n",
  'app/node_modules/x/index.js': "import 'skipped';\n",
  'app/dist/out.js': "import 'skipped-dist';\n",
  'app/readme.md': "import 'not-js';\n",
};
const vfs = new FakeVfs(files);

// The parser a file the lexer cannot decide is read with: here, a stand-in
// that answers that one file as a transform would.
const parsed = [];
const parse = async (path) => {
  parsed.push(path);
  return "const a = 1;\nimport Parsed from '@scope/parsed';\n";
};
const { bareSpecifiers, namedImports, unread } = await scanProjectImports(vfs, 'app', parse);
assert.equal(unread, null, 'a scan without a budget reads every file');
assert.deepEqual(parsed, ['app/src/unclosed.jsx'], 'only the file the lexer cannot decide is parsed');
assert.deepEqual([...bareSpecifiers].sort(), [
  '@scope/icons', '@scope/parsed', '@scope/pkg', '@scope/pkg/sub', '@scope/typed', 'after-apostrophe', 'after-generics', 'deep-pkg', 'lazy-pkg', 'lodash-es', 'lodash-es/debounce',
  'lucide-react', 'minified', 'node:fs', 'normalize.css', 'react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime',
  'react/jsx-runtime', 'site-config-pkg', 'tail-pkg',
]);
assert.deepEqual(
  Object.fromEntries([...namedImports].map(([pkg, names]) => [pkg, [...names].sort()])),
  {
    '@scope/icons': ['Icon'], '@scope/pkg': ['b'], '@scope/typed': ['Typed'], 'after-generics': ['After'],
    'lucide-react': ['Deep', 'Home', 'IconProps', 'Zap'], 'site-config-pkg': ['Site'],
  },
);

// ── With a budget ──────────────────────────────────────────────────────────
{
  const sized = new FakeVfs({
    'proj/src/a.ts': "import { A } from 'pkg';\n",
    'proj/src/b.ts': `import { B } from 'pkg';\n// ${'x'.repeat(200)}\n`,
    'proj/src/c.ts': `import { C } from 'pkg';\n// ${'x'.repeat(60)}\n`,
    'proj/src/d.ts': "import { D } from 'pkg';\n",
  });
  // Every read the scan makes.
  const reads = [];
  const readFileString = sized.readFileString.bind(sized);
  sized.readFileString = (path) => (reads.push(path), readFileString(path));
  const scan = (budget) => {
    reads.length = 0;
    return scanProjectImports(sized, 'proj', parse, budget);
  };
  const names = (result) => [...(result.namedImports.get('pkg') ?? [])].sort();

  const roomy = await scan({ files: 10, fileBytes: 1024, totalBytes: 4096 });
  assert.deepEqual(names(roomy), ['A', 'B', 'C', 'D'], 'a budget it stays within changes nothing');
  assert.equal(roomy.unread, null, 'and leaves nothing unread');

  const perFile = await scan({ files: 10, fileBytes: 100, totalBytes: 4096 });
  assert.deepEqual(names(perFile), ['A', 'C', 'D'], 'a file over the per-file bytes adds no names');
  assert.ok(!reads.includes('proj/src/b.ts'), 'and is not read');
  assert.match(perFile.unread ?? '', /^1 file\(s\) over 100 bytes \(proj\/src\/b\.ts\)$/, perFile.unread);

  const total = await scan({ files: 10, fileBytes: 1024, totalBytes: 280 });
  assert.deepEqual(names(total), ['A', 'B', 'D'], 'a file past what is left of the total adds no names');
  assert.ok(!reads.includes('proj/src/c.ts'), 'and is not read');
  assert.match(total.unread ?? '', /^1 file\(s\) past 280 bytes in all \(proj\/src\/c\.ts\)$/, total.unread);

  const count = await scan({ files: 2, fileBytes: 1024, totalBytes: 4096 });
  assert.deepEqual(names(count), ['A', 'B'], 'the walk stops at the first file past its count');
  assert.deepEqual(reads, ['proj/src/a.ts', 'proj/src/b.ts'], 'reading none after it');
  assert.equal(count.unread, 'the files from proj/src/c.ts on, past 2 files', count.unread);

  const exact = await scan({ files: 4, fileBytes: 1024, totalBytes: 4096 });
  assert.equal(exact.unread, null, 'a count that ends at the last file leaves nothing unread');
}

console.log('project-imports-scan: ok');
