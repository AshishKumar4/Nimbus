#!/usr/bin/env node
// Paired in-process CPU comparison, under V8, of the platform's write path
// (WaveWriter buffering, encoding and sending waves of small files) and of
// counting a string's UTF-8 bytes, one run. remote-platform-write-cpu
// supplies the baseline's packages/platform/src and judges the runs together.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const head = new URL('../../packages/platform/src/', import.meta.url).pathname;
const PAIRS = 30;
const scratch = mkdtempSync(join(tmpdir(), 'platform-cpu-'));
let checksum = 0;
const results = [];

/**
 * An arm: the platform's sources from `dir`, bundled on their own, so no
 * arm shares a module, or its JIT state, with another. `siteLength` is how
 * a site that only wants a string's UTF-8 length measured it: the baseline
 * encoded the string.
 */
async function arm(name, dir, encodes) {
  const at = (file) => JSON.stringify(join(dir, file));
  const contents = [
    `export { WaveWriter } from ${at('wave-writer.ts')};`,
    `export { utf8Length } from ${at('utf8.ts')};`,
    encodes
      ? 'const encoder = new TextEncoder();\nexport const siteLength = (text) => encoder.encode(text).byteLength;'
      : `export { utf8Length as siteLength } from ${at('utf8.ts')};`,
  ].join('\n');
  const bundled = await build({ stdin: { contents, resolveDir: dir, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'esnext' });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

// What a session's supervisor does with a wave, as far as the producer can
// tell: reads its stream to the end, and answers.
const supervisor = {
  async writeBatchStream(stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      checksum += value.byteLength;
    }
    return { ok: true };
  },
};
const content = new Uint8Array(512).fill(97);
const FILES = 2000;
const paths = Array.from({ length: 2048 }, (_, i) => i % 8 === 0
  ? `home/user/app/node_modules/pkg${i % 64}/lib/naïve/日本語-${i}.js`
  : `home/user/app/node_modules/pkg${i % 64}/lib/sub${i % 4}/file${i}.js`);
// Module-sized texts, distinct strings so no count is of one already seen.
const asciiTexts = Array.from({ length: 16 }, (_, i) => `// ${i}\n${'export const value = "abcdefghijklmnopqrstuvwxyz0123456789";\n'.repeat(8192)}`);
const mixedTexts = Array.from({ length: 16 }, (_, i) => `// ${i}\n${'export const value = "abcdefghijklmnopqrstuvwxyz — naïve 日本語";\n'.repeat(8192)}`);

const work = {
  async 'wave-writer'({ WaveWriter }) {
    const writer = new WaveWriter({ supervisor, root: 'home/user/app', mtimeMs: 1 });
    for (let i = 0; i < FILES; i++) await writer.file(paths[i % paths.length], 0o644, content);
    await writer.flush();
  },
  'utf8-paths'({ utf8Length }) {
    for (let round = 0; round < 64; round++) for (const path of paths) checksum += utf8Length(path);
  },
  'site-paths'({ siteLength }) {
    for (let round = 0; round < 64; round++) for (const path of paths) checksum += siteLength(path);
  },
  'site-module-ascii'({ siteLength }) {
    for (const text of asciiTexts) checksum += siteLength(text);
  },
  'site-module-mixed'({ siteLength }) {
    for (const text of mixedTexts) checksum += siteLength(text);
  },
  'utf8-module-ascii'({ utf8Length }) {
    for (const text of asciiTexts) checksum += utf8Length(text);
  },
};

try {
  const sources = { A: [baseline, true], null: [baseline, true], real: [head, false] };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(name, ...sources[name]);
  const cpu = (exports, kind) => cpuMs(() => work[kind](exports));
  for (const kind of Object.keys(work)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: 8, iterations: 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  assert.ok(checksum > 0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
