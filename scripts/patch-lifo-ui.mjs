import { mkdirSync, writeFileSync, existsSync } from 'fs';
const dir = 'node_modules/@lifo-sh/ui';
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(dir + '/package.json', JSON.stringify({ name: '@lifo-sh/ui', version: '0.0.1', main: 'index.js' }, null, 2));
writeFileSync(dir + '/index.js', 'module.exports = {};');
writeFileSync(dir + '/index.d.ts', 'export {};');
console.log('@lifo-sh/ui stub created');

// Patch isomorphic-git (cf-git fork) exports map — source files are under src/
import { readFileSync } from 'fs';
const igPkg = 'node_modules/isomorphic-git/package.json';
if (existsSync(igPkg)) {
  try {
    const pkg = JSON.parse(readFileSync(igPkg, 'utf8'));
    if (pkg.exports?.['.']?.worker === './index.js' && !existsSync('node_modules/isomorphic-git/index.js')) {
      pkg.exports['.'] = { types: './src/index.d.ts', worker: './src/index.js', import: './src/index.js', default: './src/index.js' };
      if (pkg.exports['./http/web']) {
        pkg.exports['./http/web'] = { import: { types: './src/http/web/index.d.ts', default: './src/http/web/index.js' } };
      }
      if (pkg.exports['./http/node']) {
        pkg.exports['./http/node'] = { import: { types: './src/http/node/index.d.ts', default: './src/http/node/index.js' } };
      }
      pkg.main = './src/index.js';
      writeFileSync(igPkg, JSON.stringify(pkg, null, 2) + '\n');
      console.log('isomorphic-git (cf-git) exports patched');
    }
  } catch (e) { console.warn('isomorphic-git patch skipped:', e.message); }
}

// Symlink cf-git's missing deps from root node_modules into its nested node_modules.
// cf-git (installed from GitHub) has a partial node_modules/ with some deps bundled,
// but others (clean-git-ref, crc-32, sha.js, etc.) are only in the root.
// Wrangler's esbuild resolves from the nested dir first and fails if not found there.
import { symlinkSync, readdirSync } from 'fs';
const igNm = 'node_modules/isomorphic-git/node_modules';
if (existsSync(igNm)) {
  const needed = ['clean-git-ref', 'is-git-ref-name-valid', 'crc-32', 'sha.js', 'simple-get', 'minimisted'];
  for (const pkg of needed) {
    const target = igNm + '/' + pkg;
    const source = '../../' + pkg;
    if (!existsSync(target) && existsSync('node_modules/' + pkg)) {
      try { symlinkSync(source, target); console.log('cf-git dep linked:', pkg); }
      catch (e) { console.warn('cf-git symlink failed:', pkg, e.message); }
    }
  }
}
