#!/usr/bin/env bun
/**
 * scanProjectImports reads a project's browser source once for both things
 * the pre-bundle needs: every bare specifier imported (subpaths and their
 * package roots, dynamic and side-effect imports, react's JSX runtimes) and
 * the names imported from each package root (for barrel packages). Both come
 * from the same files: six directories deep, without node_modules, .git,
 * dist, build, non-JS files, or the build tools' configs at the project root.
 * An import inside a comment names nothing.
 */

import assert from 'node:assert/strict';
import { scanProjectImports } from '../../packages/worker/src/runtime/barrel-synthesizer.ts';

const files = {
  'app/src/main.tsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { Home, Zap as Z, type IconProps } from 'lucide-react';\nimport './style.css';\nimport 'normalize.css?inline';\nconst m = import('lodash-es/debounce');\n",
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
const dirs = new Set(['app']);
for (const path of Object.keys(files)) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}
const vfs = {
  readdir(dir) {
    const out = new Map();
    for (const path of [...dirs, ...Object.keys(files)]) {
      const rest = path.slice(dir.length + 1);
      if (path.startsWith(dir + '/') && !rest.includes('/')) out.set(rest, dirs.has(path) ? 'directory' : 'file');
    }
    return [...out].map(([name, type]) => ({ name, type }));
  },
  readFileString(path) {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  },
};

const { bareSpecifiers, namedImports } = scanProjectImports(vfs, 'app');
assert.deepEqual([...bareSpecifiers].sort(), [
  '@scope/pkg', '@scope/pkg/sub', 'deep-pkg', 'lodash-es', 'lodash-es/debounce', 'lucide-react', 'minified', 'node:fs',
  'normalize.css', 'react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', 'react/jsx-runtime',
  'site-config-pkg',
]);
assert.deepEqual(
  Object.fromEntries([...namedImports].map(([pkg, names]) => [pkg, [...names].sort()])),
  { '@scope/pkg': ['b'], 'lucide-react': ['Deep', 'Home', 'IconProps', 'Zap'], 'site-config-pkg': ['Site'] },
);

console.log('project-imports-scan: ok');
