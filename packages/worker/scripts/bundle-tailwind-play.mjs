#!/usr/bin/env node
/**
 * bundle-tailwind-play.mjs — vendor the Tailwind Play CDN bundle.
 *
 * Why this exists
 * ───────────────
 * Nimbus's preview HTML used to inject
 *
 *   <script src="https://cdn.tailwindcss.com/3.4.17"></script>
 *
 * (src/vite-dev-server.ts) so projects using Tailwind classes had a
 * working JIT compiler in the browser. That violates the 100% edge
 * contract: every preview load fetches a third-party CDN.
 *
 * The bundle is committed at public/_assets/tailwind-play.js, served
 * lazily via the ASSETS binding. The supervisor then serves it from
 *
 *   /preview/__nimbus_assets/tailwind-play.js
 *
 * with proper Content-Type + immutable cache headers, and the HTML
 * injection points at the local URL.
 *
 * Browser-runtime bytes: ~408 KiB raw. Rather than inline it as a JS
 * string in the supervisor bundle (which inflated the deploy upload
 * past the 6 MiB gate), it ships as a static asset alongside its
 * siblings (real-vite-bundle.js, cirrus-plugin-react.bundle.js) and is
 * fetched on first use via runtime/assets-loader.ts. The emitted
 * src/tailwind-play.generated.ts is a thin re-export of the async
 * getter + version + path constants.
 *
 * Sourcing and regeneration
 * ─────────────────────────
 * The version and the bundle's sha256 are pinned here. A plain run
 * regenerates from the committed bundle, offline: it checks those bytes
 * against the pin and writes the loader. `--fetch` is the one sourcing
 * path: it downloads the pinned version from the CDN, refuses bytes that
 * are not the pinned digest, and stages them. To move to a new version:
 *   1. set TAILWIND_PLAY_VERSION and run `bun run --cwd packages/worker
 *      source:tailwind`: it refuses the new bytes, naming their digest;
 *   2. review those bytes (curl the URL it names) and set
 *      TAILWIND_PLAY_SHA256 to the digest;
 *   3. run source:tailwind again: it stages the bundle and writes the
 *      loader; commit both, then regenerate the dist (remote-build).
 *
 * The Play CDN is a SEPARATE build from the `tailwindcss` npm
 * package — `packages/@tailwindcss-cdn/` in the upstream repo. It
 * embeds the JIT compiler + utility detection + style injection
 * pipeline as a self-contained browser IIFE. Not available via npm.
 *
 * Output:
 *   public/_assets/tailwind-play.js       (the raw bundle, served via ASSETS)
 *   src/tailwind-play.generated.ts        (thin loader shim)
 *     export const TAILWIND_PLAY_VERSION: string;
 *     export const TAILWIND_PLAY_INTEGRITY: string;       // sha256-<hex>
 *     export const TAILWIND_PLAY_BUNDLE_PATH: string;     // /_assets/tailwind-play.js
 *     export function getTailwindPlayBundle(env): Promise<string>;
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'tailwind-play.generated.ts');
const ASSETS_DIR = path.join(ROOT, 'public', '_assets');
const ASSET_PATH = '/_assets/tailwind-play.js';

const TAILWIND_PLAY_VERSION = '3.4.17';
const TAILWIND_PLAY_SHA256 = '176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15';
const SOURCE_URL = `https://cdn.tailwindcss.com/${TAILWIND_PLAY_VERSION}`;
const ASSET_FILE = path.join(ASSETS_DIR, 'tailwind-play.js');

/** The pinned bundle's bytes: fetched from the CDN when `fetching`, else the committed asset. Refuses any other bytes. */
async function pinnedBundle(fetching) {
  let code;
  if (fetching) {
    console.log(`[bundle-tailwind-play] fetching ${SOURCE_URL} ...`);
    const resp = await fetch(SOURCE_URL);
    if (!resp.ok) throw new Error(`[bundle-tailwind-play] download failed: ${resp.status} ${resp.statusText}`);
    code = await resp.text();
  } else {
    code = await fs.readFile(ASSET_FILE, 'utf8').catch(() => {
      throw new Error(`[bundle-tailwind-play] no committed bundle at ${path.relative(ROOT, ASSET_FILE)}: source it with --fetch`);
    });
  }
  const sha256 = createHash('sha256').update(code).digest('hex');
  if (sha256 !== TAILWIND_PLAY_SHA256) {
    throw new Error(
      `[bundle-tailwind-play] the ${fetching ? `bundle ${SOURCE_URL} served` : 'committed bundle'} has sha256 ${sha256}, ` +
        `not the pinned ${TAILWIND_PLAY_SHA256}. ${fetching ? 'Review those bytes; if they are the version you mean, pin their digest and fetch again (see the header).' : 'Restore it, or source it with --fetch.'}`,
    );
  }
  return { code, sha256 };
}

async function main() {
  const fetching = process.argv.includes('--fetch');
  const { code, sha256 } = await pinnedBundle(fetching);
  console.log(
    `[bundle-tailwind-play] version=${TAILWIND_PLAY_VERSION} size=${(code.length / 1024).toFixed(1)} KiB sha256=${sha256.slice(0, 16)}… (${fetching ? 'fetched' : 'committed'})`,
  );
  if (fetching) {
    await fs.mkdir(ASSETS_DIR, { recursive: true });
    await fs.writeFile(ASSET_FILE, code, 'utf8');
  }

  const header = `/**
 * tailwind-play.generated.ts — AUTO-GENERATED by scripts/bundle-tailwind-play.mjs
 * DO NOT EDIT.
 *
 * Vendored Tailwind Play CDN ${TAILWIND_PLAY_VERSION} bundle, served
 * from /preview/__nimbus_assets/tailwind-play.js so preview pages get
 * Tailwind JIT without fetching from cdn.tailwindcss.com (100% edge
 * contract).
 *
 * The ~408 KiB bundle ships as a static asset (public/_assets/tailwind-play.js)
 * and is fetched lazily via the ASSETS binding rather than inlined into the
 * supervisor bundle. Use {@link getTailwindPlayBundle}.
 *
 * Source: ${SOURCE_URL} (sourced by bundle-tailwind-play.mjs --fetch).
 * SHA-256: ${sha256}
 *
 * If you change this file by hand it WILL be overwritten by the next
 * predev / predeploy.
 */

import { loadAssetText, type AssetsFetcher } from '@nimbus-sh/core/runtime/assets-loader.js';

export const TAILWIND_PLAY_VERSION: string = ${JSON.stringify(TAILWIND_PLAY_VERSION)};
export const TAILWIND_PLAY_INTEGRITY: string = ${JSON.stringify('sha256-' + sha256)};

/** Asset path for the vendored Tailwind Play bundle. Use {@link getTailwindPlayBundle}. */
export const TAILWIND_PLAY_BUNDLE_PATH: string = ${JSON.stringify(ASSET_PATH)};

/**
 * Fetch the vendored Tailwind Play CDN bundle from the ASSETS binding.
 * Cached per-isolate.
 *
 * @param env Object exposing the \`ASSETS\` binding (Fetcher).
 * @returns The Tailwind Play bundle as a UTF-8 string.
 * @throws {NimbusAssetLoadError} when the binding is missing or fetch fails.
 */
export function getTailwindPlayBundle(env: { ASSETS: AssetsFetcher }): Promise<string> {
  return loadAssetText(env.ASSETS, TAILWIND_PLAY_BUNDLE_PATH);
}
`;

  await fs.writeFile(OUT, header, 'utf8');
  const stat = await fs.stat(OUT);
  console.log(
    `[bundle-tailwind-play] wrote ${path.relative(ROOT, OUT)} (${(stat.size / 1024).toFixed(1)} KiB shim) + ${path.relative(ROOT, ASSETS_DIR)}/tailwind-play.js (${(code.length / 1024).toFixed(1)} KiB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-tailwind-play] failed:', e);
  process.exit(1);
});
