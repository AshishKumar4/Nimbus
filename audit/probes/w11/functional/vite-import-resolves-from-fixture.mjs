// W11 functional: §3.0 shared blocker probe.
// When a project is detected as one of {sveltekit, astro, remix, nuxt},
// `vite` MUST be installable into node_modules — i.e. NOT in SKIP_PACKAGES
// gate when framework is detected. This probe asserts the npm-resolver
// has the framework-aware skip gate wired in.
//
// We can't test the actual VFS install from a unit-level probe, so we
// statically check that src/npm-resolver.ts grew either:
//   (a) a function `shouldSkipPackageWithFramework` (Option A), or
//   (b) the `vite` entry is moved out of SKIP_PACKAGES with a comment
//       referencing the W11 reasoning, or
//   (c) the SKIP set is gated by an env/context flag.
// At least one of those signals must be present in the file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER = path.resolve(HERE, '..', '..', '..', '..', 'src', 'npm-resolver.ts');

await group('vite SKIP_PACKAGES blocker addressed', () => {
  ok('npm-resolver.ts exists', fs.existsSync(RESOLVER));
  let txt = '';
  try { txt = fs.readFileSync(RESOLVER, 'utf8'); } catch { /* RED phase */ }
  const hasFrameworkAware =
    txt.includes('shouldSkipPackageWithFramework') ||
    txt.includes('frameworkAware') ||
    txt.includes('W11');
  const viteRemoved = !/['"]vite['"]/.test(
    txt.replace(/W6:[^\n]*?vite[^\n]*?\n/g, '') // strip historical comments
       .split('SKIP_PACKAGES')[1]?.split(/SKIP_PREFIXES|^\}\)?\s*$/m)[0] || ''
  );
  ok(
    'either framework-aware skip gate OR vite removed from skip list',
    hasFrameworkAware || viteRemoved,
    `hasFrameworkAware=${hasFrameworkAware} viteRemoved=${viteRemoved}`,
  );
});

await summary('w11/functional/vite-import-resolves-from-fixture');
