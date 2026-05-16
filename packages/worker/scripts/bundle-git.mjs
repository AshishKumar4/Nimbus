#!/usr/bin/env node
/**
 * bundle-git.mjs — Pre-bundle isomorphic-git for the git-network-facet.
 *
 * WHY this exists:
 *   The git-network-facet runs inside a dynamic worker loaded via
 *   env.LOADER.load(). Dynamic workers have NO access to node_modules —
 *   they only see modules explicitly passed in the `modules` object.
 *
 *   The main Worker's bundler (wrangler) inlines isomorphic-git into the
 *   supervisor, but that bundle is unreachable from the facet isolate.
 *
 *   This script bundles isomorphic-git + isomorphic-git/http/web into ONE
 *   ESM string that we can pass as a module to LOADER.load(). The facet
 *   imports it via `import('./isomorphic-git.js')`.
 *
 * Output:
 *   src/git-bundle.generated.ts — exports GIT_BUNDLE_CODE: string
 *
 * Runs as a postinstall step AND on every `bun run dev` / `bun run deploy`
 * via the "bundle:git" npm script.
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Entry that aggregates both namespaces into a single ESM bundle.
const ENTRY_CONTENTS = [
  "export * as git from 'isomorphic-git';",
  "export * as gitHttp from 'isomorphic-git/http/web';",
].join('\n');

const ENTRY_FILE = join(root, '.git-bundle-entry.js');

async function main() {
  try {
    writeFileSync(ENTRY_FILE, ENTRY_CONTENTS);

    const result = await build({
      entryPoints: [ENTRY_FILE],
      bundle: true,
      format: 'esm',
      target: 'esnext',
      platform: 'browser',
      conditions: ['worker', 'browser', 'import'],
      // Map bare node built-ins → node: prefixed (works with nodejs_compat).
      alias: {
        crypto: 'node:crypto',
      },
      // Anything else that might leak: leave as external. nodejs_compat
      // provides these at runtime in the dynamic worker.
      external: [
        'node:*',
        'cloudflare:workers',
      ],
      write: false,
      logLevel: 'warning',
    });

    if (!result.outputFiles || result.outputFiles.length === 0) {
      throw new Error('esbuild produced no output');
    }

    const code = result.outputFiles[0].text;

    // Emit as a TS module that exports the bundle as a string constant.
    // Using String.raw-equivalent: JSON-encode to preserve backticks/$/etc.
    const outPath = join(root, 'src', 'git-bundle.generated.ts');

    // We JSON.stringify the code to produce a valid JS string literal.
    // Then wrap in a TS const export. The supervisor imports this at build.
    const encoded = JSON.stringify(code);

    const tsWrapper = [
      '/**',
      ' * git-bundle.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
      ' *',
      ' * Produced by scripts/bundle-git.mjs from:',
      " *   - isomorphic-git (github:AshishKumar4/cf-git)",
      " *   - isomorphic-git/http/web",
      ' *',
      ' * Consumed by git-network-facet.ts: passed to LOADER.load()\'s',
      ' * `modules` record so the facet can `import` isomorphic-git.',
      ' *',
      ` * Generated at: ${new Date().toISOString()}`,
      ` * Size: ${(code.length / 1024).toFixed(1)} KiB`,
      ' */',
      '',
      `export const GIT_BUNDLE_CODE: string = ${encoded};`,
      '',
      `export const GIT_BUNDLE_SIZE = ${code.length};`,
      '',
    ].join('\n');

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, tsWrapper);

    console.log(`[bundle-git] wrote ${outPath} (${(code.length / 1024).toFixed(1)} KiB bundled)`);
  } finally {
    // Clean up the temp entry file
    try {
      if (existsSync(ENTRY_FILE)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(ENTRY_FILE);
      }
    } catch {}
  }
}

main().catch((e) => {
  console.error('[bundle-git] FAILED:', e?.message || e);
  process.exitCode = 1;
});
