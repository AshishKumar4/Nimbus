#!/usr/bin/env bun
// The runtime-code interpreter against V8 on the code real frameworks
// generate: Astro 7's dev server, Vite 8's build of the react-ts template,
// Nuxt's and Vinext's dev servers. Each runs three ways under node:
//
//   native       V8 compiles everything (the reference);
//   shadow       V8 runs, and every function the program builds from a string
//                is also built by the interpreter and run on shadow outputs
//                with the same inputs (lib/shadow-preload.mjs): each Vite SSR
//                module's exports, each other function's result, compared;
//                the config module Vite bundles and imports is compared too
//                (lib/compare-modules.mjs);
//   interpreted  string code generation refused, as in a Worker, and the
//                interpreter answers every refusal (lib/interpret-preload.mjs).
//
// It fails on any difference the shadow run finds, any code the interpreter
// refuses, and any page or build output of the interpreted run that differs
// from the native one (see normalize() for what is not compared).
//
// The apps are scaffolded and installed from npm into the gitignored .cache/
// once (the network on the first run); delete .cache/interpreter-differential
// to start over. Run: bun tests/differential/interpreter-frameworks.mjs [astro,vite,nuxt,vinext]

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildInterpreterFiles } from '../unit/lib/interpreter-build.mjs';
import { APPS, CACHE, LIB, ensureApp, withServer } from './lib/apps.mjs';
import { readReport } from './lib/report.mjs';

const only = new Set((process.argv[2] || 'astro,vite,nuxt,vinext').split(','));

/**
 * Pages and build output as compared: the per-launch values a server or
 * build stamps on them, out (timestamps, UUIDs, cache tokens, React's RSC timing rows). And the
 * call stacks React's development build records for each server component
 * (an RSC row's "stack", and the rows of frames it refers to): a stack taken in interpreted code shows the
 * interpreter's frames, not the interpreted file's lines, which is the one
 * observable difference this run accepts.
 */
function normalize(text) {
  return text
    .replace(/:N\d+(\.\d+)?/g, ':NTIME')
    .replace(/(\\*"time\\*":)[\d.]+/g, '$1TIME')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
    .replace(/\$\$cache=[0-9a-z]+/g, '$$$$cache=C')
    .replace(/([?&]t=)\d+/g, '$1T')
    .replace(/\d{13}/g, 'TIME')
    .replace(/(\\*"stack\\*":)\[(?:[^\[\]]|\[[^\[\]]*\])*\]/g, '$1[STACK]')
    .replace(/(\\n[0-9a-f]+:)\[(?:\[[^\[\]]*\],?)*\]/g, '$1[STACK]')
    .replace(/"buildId":"[^"]+"/g, '"buildId":"B"');
}

function nodeArgs(mode, files, report, corpus) {
  const env = { NIMBUS_INTERPRETER: files.interpreterFile, NIMBUS_INTERPRETER_OPS: files.opsFile, NIMBUS_DIFF_REPORT: report, NIMBUS_DIFF_CORPUS: corpus };
  if (mode === 'shadow') return { flags: ['--import', join(LIB, 'shadow-preload.mjs')], env };
  if (mode === 'interpreted') return { flags: ['--disallow-code-generation-from-strings', '--import', join(LIB, 'interpret-preload.mjs')], env };
  return { flags: [], env };
}

function runServer(app, dir, mode, files, port, report, corpus) {
  const { flags, env } = nodeArgs(mode, files, report, corpus);
  return withServer(app, dir, port, flags, env, () => app.observe(dir, port));
}

function runBuild(app, dir, mode, files, report, corpus) {
  const { flags, env } = nodeArgs(mode, files, report, corpus);
  const out = `dist-${mode}`;
  const r = spawnSync('node', [...flags, ...app.build(out)], { cwd: dir, env: { ...process.env, ...env, CI: '1' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${mode} build failed:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  const output = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else output[`${prefix}${name}`] = readFileSync(p, 'utf8');
    }
  };
  walk(join(dir, out), '');
  return output;
}

const files = await buildInterpreterFiles();
const failures = [];
let port = 4700;
try {
  for (const [name, app] of Object.entries(APPS)) {
    if (!only.has(name)) continue;
    const dir = ensureApp(name);
    const outputs = {};
    const reports = {};
    for (const mode of ['native', 'shadow', 'interpreted']) {
      const report = join(files.dir, `${name}-${mode}.json`);
      const corpus = join(CACHE, 'corpus', name);
      outputs[mode] = app.build ? runBuild(app, dir, mode, files, report, corpus) : await runServer(app, dir, mode, files, port++, report, corpus);
      if (mode === 'shadow') {
        const compared = spawnSync('node', [join(LIB, 'compare-modules.mjs'), report], { env: { ...process.env, ...nodeArgs(mode, files, report, corpus).env }, encoding: 'utf8' });
        if (compared.status !== 0) throw new Error(`comparing modules failed: ${compared.stderr}`);
      }
      if (mode !== 'native') reports[mode] = readReport(report);
    }
    const shadow = { functions: 0, ssrModules: 0, vmExpressions: 0, compared: 0, equal: 0, mismatches: [], refused: [], moduleResults: [], ...reports.shadow };
    const moduleDiffs = shadow.moduleResults.filter((m) => m.difference);
    const vm = reports.interpreted.vmExpressions ?? [];
    console.log(`${name}: ${shadow.functions} functions built from strings (${shadow.ssrModules} Vite SSR modules), ${shadow.vmExpressions} vm.runInThisContext expressions, ${shadow.compared} runs compared, ${shadow.equal} equal; ${shadow.moduleResults.length} module files compared; corpus in .cache/interpreter-differential/corpus/${name}`);
    console.log(`${name}: the interpreted run interpreted ${vm.length} vm.runInThisContext expressions`);
    // Nuxt's config reaches the program only through jiti's vm path: the interpreted run must have interpreted it.
    if (app.vmConfig && !vm.some((code) => app.vmConfig.test(code))) failures.push(`${name}: the interpreted run did not interpret its config through vm.runInThisContext`);
    for (const m of shadow.mismatches) failures.push(`${name}: ${m.label} ${m.key}: ${m.difference}`);
    for (const r of shadow.refused) failures.push(`${name}: refused ${r.kind} ${r.key}: ${r.error}`);
    for (const m of moduleDiffs) failures.push(`${name}: module ${m.url}: ${m.difference}`);
    for (const [key, native] of Object.entries(outputs.native)) {
      const interpreted = outputs.interpreted[key];
      if (interpreted === undefined) failures.push(`${name}: the interpreted run has no ${key}`);
      else if (normalize(interpreted) !== normalize(native)) {
        const at = [...normalize(native)].findIndex((ch, i) => ch !== normalize(interpreted)[i]);
        failures.push(`${name}: ${key} differs between the native and interpreted runs at ${at}: ${JSON.stringify(normalize(native).slice(Math.max(0, at - 80), at + 120))} vs ${JSON.stringify(normalize(interpreted).slice(Math.max(0, at - 80), at + 120))}`);
      }
    }
    for (const key of Object.keys(outputs.interpreted)) if (!(key in outputs.native)) failures.push(`${name}: the interpreted run has an extra ${key}`);
    console.log(`${name}: ${Object.keys(outputs.native).length} ${app.build ? 'build files' : 'pages'} compared between the native and interpreted runs`);
  }
} finally {
  rmSync(files.dir, { recursive: true, force: true });
}
for (const f of failures.slice(0, 50)) console.log(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} differences` : 'no differences');
process.exit(failures.length ? 1 : 0);
