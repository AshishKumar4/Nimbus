// What the @opentui/core tests share: finding the real @opentui/core source
// (it is not vendored: it comes from an opencode build clone), the synthetic
// TTY a renderer draws to, and the WASI host the wasm backend runs on.

import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { OPENTUI_FFI_CHUNK_MARKER } from '../../../packages/worker/scripts/opencode/bundle-patches.ts';
import { loadWasiPreamble } from './wasi-authority.mjs';

/**
 * The @opentui/core dist directory whose index chunk carries the FFI the
 * Nimbus patch rewrites: NIMBUS_OPENTUI_CORE_DIR, else the first match in an
 * opencode clone (/tmp/opencode-research/opencode or NIMBUS_OPENCODE_CLONE).
 * Null when there is none.
 */
export function findOpenTUICoreDir() {
  if (process.env.NIMBUS_OPENTUI_CORE_DIR) return process.env.NIMBUS_OPENTUI_CORE_DIR;
  for (const root of ['/tmp/opencode-research/opencode', process.env.NIMBUS_OPENCODE_CLONE].filter(Boolean)) {
    if (!existsSync(root)) continue;
    let out = '';
    try {
      out = execSync(
        `find ${root} -path '*@opentui/core/index.js' -not -path '*core-*' 2>/dev/null | head -5`,
      ).toString();
    } catch {
      /* find may exit non-zero; ignore */
    }
    for (const main of out.split('\n').filter(Boolean)) {
      const dir = path.dirname(main);
      if (readdirSync(dir).some((f) => /^index(-[a-z0-9]+)?\.js$/.test(f) &&
        readFileSync(path.join(dir, f), 'utf8').includes(OPENTUI_FFI_CHUNK_MARKER))) {
        return dir;
      }
    }
  }
  return null;
}

/**
 * findOpenTUICoreDir, or exit 0 with a SKIP line naming `test` when there is
 * no @opentui/core source on this machine.
 */
export function openTUICoreDirOrSkip(test) {
  const dir = findOpenTUICoreDir();
  if (!dir) {
    console.log(`${test} SKIP: no @opentui/core source found ` +
      '(needs the opencode build clone; set NIMBUS_OPENTUI_CORE_DIR to run)');
    process.exit(0);
  }
  console.log(`${test} — @opentui/core source: ${dir}`);
  return dir;
}

/** A raw-mode-capable TTY stdin that never produces input. */
export function makeSyntheticStdin() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => { stdin.isRaw = !!mode; return stdin; };
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.read = () => null;
  return stdin;
}

/** A `width`×`height` 24-bit TTY stdout whose writes are pushed to `sink`. */
export function makeSyntheticStdout(width, height, sink) {
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = width;
  stdout.rows = height;
  stdout.write = (chunk, enc, cb) => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  stdout.getColorDepth = () => 24;
  stdout.hasColors = () => true;
  return stdout;
}

/** The WASI host the wasm backend takes: the real wasi-instance.ts preamble. */
export async function wasiHost() {
  const preamble = await loadWasiPreamble();
  return {
    makeImports: (opts) => preamble.__wasiMakeImports(opts),
    initFS: (opts) => preamble.__wasiInitFS(opts),
  };
}
