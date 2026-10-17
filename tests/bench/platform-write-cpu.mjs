#!/usr/bin/env node
// Platform write and UTF-8 workloads under V8, as workerd runs them.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cpuMs } from './lib/paired-cpu.mjs';
import { PLATFORM_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

let checksum = 0;

/** Bundle each arm on its own. The baseline site encoded its UTF-8 count. */
async function arm(name, dir, encodes, scratch) {
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
const paths = Array.from({ length: 2048 }, (_, i) => i % 8 === 0
  ? `home/user/app/node_modules/pkg${i % 64}/lib/naïve/日本語-${i}.js`
  : `home/user/app/node_modules/pkg${i % 64}/lib/sub${i % 4}/file${i}.js`);

function workloads(short) {
  const files = short ? 16 : 2000;
  const rounds = short ? 1 : 64;
  const asciiTexts = Array.from({ length: short ? 2 : 16 }, (_, i) => `// ${i}\n${'export const value = "abcdefghijklmnopqrstuvwxyz0123456789";\n'.repeat(short ? 64 : 8192)}`);
  const mixedTexts = Array.from({ length: short ? 2 : 16 }, (_, i) => `// ${i}\n${'export const value = "abcdefghijklmnopqrstuvwxyz — naïve 日本語";\n'.repeat(short ? 64 : 8192)}`);
  return {
    async 'wave-writer'({ WaveWriter }) {
      const writer = new WaveWriter({ supervisor, root: 'home/user/app', mtimeMs: 1 });
      for (let i = 0; i < files; i++) await writer.file(paths[i % paths.length], 0o644, content);
      await writer.flush();
    },
    'utf8-paths'({ utf8Length }) {
      for (let round = 0; round < rounds; round++) for (const path of paths) checksum += utf8Length(path);
    },
    'site-paths'({ siteLength }) {
      for (let round = 0; round < rounds; round++) for (const path of paths) checksum += siteLength(path);
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
}

await runPairedBenchmark({
  source: PLATFORM_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    const scratch = mkdtempSync(join(tmpdir(), 'platform-cpu-'));
    cleanup(() => rmSync(scratch, { recursive: true, force: true }));
    const work = workloads(short);
    await withArms((from, name) => arm(name, from, name !== 'real', scratch), async (arms) => {
      for (const kind of Object.keys(work)) {
        await sample(kind, arms, (exports) => cpuMs(() => work[kind](exports)), { pairs: 30, warm: 8, iterations: 1 });
      }
    });
    assert.ok(checksum > 0);
  },
});
