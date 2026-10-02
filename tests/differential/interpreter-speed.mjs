#!/usr/bin/env bun
// The runtime-code interpreter's speed against V8's on the same code, under
// node on this machine (the Workers figures come from a throwaway):
//
//   - Astro 7's dev server: its first page render, and the render after an
//     edit to the page's Markdown; native, and with every function built from
//     a string interpreted (lib/interpret-preload.mjs), alternating, the best
//     of three each;
//   - a generated ajv validator, 200k validations, best of five;
//   - a tight numeric loop, 3e6 iterations, best of five.
//
// Uses the apps of interpreter-frameworks.mjs (.cache/, made on first use).
// Run: bun tests/differential/interpreter-speed.mjs

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildInterpreterFiles } from '../unit/lib/interpreter-build.mjs';
import { APPS, LIB, ensureApp, sleep, withServer } from './lib/apps.mjs';

const files = await buildInterpreterFiles();
const env = { NIMBUS_INTERPRETER: files.interpreterFile, NIMBUS_INTERPRETER_OPS: files.opsFile };
const INTERPRET = ['--disallow-code-generation-from-strings', '--import', join(LIB, 'interpret-preload.mjs')];

async function timed(port, path, marker) {
  for (;;) {
    const t0 = performance.now();
    const body = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(60000) }).then((r) => (r.status === 200 ? r.text() : '')).catch(() => '');
    const ms = performance.now() - t0;
    if (body.includes(marker)) return ms;
    await sleep(50);
  }
}

async function astroRun(dir, port, flags) {
  const proof = join(dir, 'src/pages/proof.md');
  writeFileSync(proof, '# Markdown proof\n\n**speed-marker**\n');
  return withServer(APPS.astro, dir, port, flags, env, async () => {
    // Ready: a static file answers, which renders no page.
    for (let i = 0; i < 600; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/favicon.svg`).catch(() => null);
      if (r && r.status === 200) { await r.arrayBuffer(); break; }
      await sleep(100);
    }
    const first = await timed(port, '/', '<strong>speed-marker</strong>');
    writeFileSync(proof, '# Markdown proof\n\n**speed-marker-edited**\n');
    const reload = await timed(port, '/', '<strong>speed-marker-edited</strong>');
    writeFileSync(proof, '# Markdown proof\n\n**differential**\n');
    return { first, reload };
  });
}

function child(work, cwd, flags) {
  const r = spawnSync('node', [...flags, join(LIB, 'speed-child.mjs'), work], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${work} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1)).ms;
}

const ratio = (a, b) => `${(a / b).toFixed(2)}x`;
try {
  const astro = ensureApp('astro');
  const ajv = ensureApp('ajv');
  const runs = { native: [], interpreted: [] };
  let port = 4830;
  for (let i = 0; i < 3; i++) {
    runs.native.push(await astroRun(astro, port++, []));
    runs.interpreted.push(await astroRun(astro, port++, INTERPRET));
  }
  const best = (list, key) => Math.min(...list.map((r) => r[key]));
  const [nf, nr, inf, ir] = [best(runs.native, 'first'), best(runs.native, 'reload'), best(runs.interpreted, 'first'), best(runs.interpreted, 'reload')];
  console.log(`Astro first render: native ${nf.toFixed(0)} ms, interpreted ${inf.toFixed(0)} ms (${ratio(inf, nf)})`);
  console.log(`Astro render after an edit: native ${nr.toFixed(0)} ms, interpreted ${ir.toFixed(0)} ms (${ratio(ir, nr)})`);
  for (const [work, cwd] of [['ajv', ajv], ['loop', ajv]]) {
    const native = child(work, cwd, []);
    const interpreted = child(work, cwd, INTERPRET);
    console.log(`${work}: native ${native.toFixed(1)} ms, interpreted ${interpreted.toFixed(1)} ms (${ratio(interpreted, native)})`);
  }
} finally {
  rmSync(files.dir, { recursive: true, force: true });
}
