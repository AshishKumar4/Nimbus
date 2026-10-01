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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInterpreterFiles } from '../unit/lib/interpreter-build.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CACHE = join(REPO, '.cache/interpreter-differential');
const LIB = fileURLToPath(new URL('./lib/', import.meta.url));
const only = new Set((process.argv[2] || 'astro,vite,nuxt,vinext').split(','));
mkdirSync(CACHE, { recursive: true });

function sh(cwd, command) {
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1', npm_config_yes: 'true' } });
  if (r.status !== 0) throw new Error(`${command} failed in ${cwd}:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
}

const VINEXT_FILES = {
  'package.json': JSON.stringify({ name: 'vinext-diff', private: true, type: 'module', dependencies: { vinext: '^1.0.0', vite: '^8.0.0', react: '^19.2.6', 'react-dom': '^19.2.6', '@vitejs/plugin-rsc': '^0.5.34', '@vitejs/plugin-react': '^5.1.4', 'react-server-dom-webpack': '^19.2.6' } }),
  'vite.config.ts': "import { defineConfig } from 'vite';\nimport vinext from 'vinext';\nexport default defineConfig({ plugins: [vinext()] });\n",
  'app/layout.tsx': 'export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n',
  'app/page.tsx': 'export default function Page() { return <h1>vinext-differential</h1>; }\n',
};

/** The apps: how each is made, and what of each run is compared. */
const APPS = {
  astro: {
    make(dir) {
      sh(CACHE, `npm create astro@7 astro -- --template minimal --no-install --no-git --skip-houston --yes`);
      sh(dir, 'npm install');
      writeFileSync(join(dir, 'src/pages/proof.md'), '# Markdown proof\n\n**differential**\n');
      writeFileSync(join(dir, 'src/pages/index.astro'), "---\nimport { Content } from './proof.md';\n---\n<html lang=\"en\"><head><title>Astro proof</title></head><body><Content /></body></html>\n");
    },
    serve: (port) => ['node_modules/astro/bin/astro.mjs', 'dev', '--force', '--port', String(port)],
    async observe(dir, port) {
      writeFileSync(join(dir, 'src/pages/proof.md'), '# Markdown proof\n\n**differential**\n');
      const first = await page(port, '/', 'differential');
      writeFileSync(join(dir, 'src/pages/proof.md'), '# Markdown proof\n\n**differential-edited**\n');
      const edited = await page(port, '/', 'differential-edited');
      writeFileSync(join(dir, 'src/pages/proof.md'), '# Markdown proof\n\n**differential**\n');
      return { '/': first, '/ after an edit': edited };
    },
  },
  vite: {
    make(dir) {
      sh(CACHE, 'npm create vite@8 vite -- --template react-ts --no-interactive');
      sh(dir, 'npm install');
    },
    build: (out) => ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'],
  },
  nuxt: {
    make(dir) {
      sh(CACHE, 'npx --yes nuxi@latest init nuxt -t minimal --no-install --gitInit=false --packageManager=npm');
      sh(dir, 'npm install');
    },
    serve: (port) => ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--no-fork', '--port', String(port)],
    async observe(dir, port) {
      return { '/': await page(port, '/', '__nuxt') };
    },
  },
  vinext: {
    make(dir) {
      for (const [name, text] of Object.entries(VINEXT_FILES)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      sh(dir, 'npm install');
    },
    serve: (port) => ['node_modules/.bin/vinext', 'dev', '--port', String(port)],
    async observe(dir, port) {
      writeFileSync(join(dir, 'app/page.tsx'), VINEXT_FILES['app/page.tsx']);
      // The inline scripts carry React's development flight data, whose row
      // numbering follows the call stacks it records (see normalize()): the
      // rendered document is compared without them.
      const html = await page(port, '/', 'vinext-differential');
      return { '/': html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>') };
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET `path` until its body contains `marker` (a dev server compiles on the first request). */
async function page(port, path, marker) {
  let last = '';
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(60000) }).then(async (res) => [res.status, await res.text()]).catch((e) => [0, e.message]);
    last = `${r[0]} ${r[1].slice(0, 300)}`;
    if (r[0] === 200 && r[1].includes(marker)) return r[1];
    await sleep(500);
  }
  throw new Error(`no page with ${marker} at ${path}: ${last}`);
}

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

async function runServer(app, dir, mode, files, port, report, corpus) {
  const { flags, env } = nodeArgs(mode, files, report, corpus);
  // Astro 7 backgrounds its dev server when it sees CI or an agent; this run needs it in the foreground.
  const serverEnv = { ...process.env, ...env };
  for (const name of ['CI', 'AGENT', 'CLAUDECODE', 'OMPCODE']) delete serverEnv[name];
  const child = spawn('node', [...flags, ...app.serve(port)], { cwd: dir, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    return await Promise.race([app.observe(dir, port), exited.then(() => { throw new Error(`${mode} server exited:\n${output.slice(-3000)}`); })]);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, sleep(10000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
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
    const dir = join(CACHE, name);
    if (!existsSync(join(dir, 'node_modules'))) {
      rmSync(dir, { recursive: true, force: true });
      app.make(dir);
    }
    const outputs = {};
    const reports = {};
    for (const mode of ['native', 'shadow', 'interpreted']) {
      const report = join(files.dir, `${name}-${mode}.json`);
      const corpus = join(CACHE, 'corpus', name);
      outputs[mode] = app.build ? runBuild(app, dir, mode, files, report, corpus) : await runServer(app, dir, mode, files, port++, report, corpus);
      if (mode === 'shadow') {
        const compared = spawnSync('node', [join(LIB, 'compare-modules.mjs'), report], { env: { ...process.env, ...nodeArgs(mode, files, report, corpus).env }, encoding: 'utf8' });
        if (compared.status !== 0) throw new Error(`comparing modules failed: ${compared.stderr}`);
        reports[mode] = JSON.parse(readFileSync(report, 'utf8'));
      }
    }
    const shadow = reports.shadow;
    const moduleDiffs = shadow.moduleResults.filter((m) => m.difference);
    console.log(`${name}: ${shadow.functions} functions built from strings (${shadow.ssrModules} Vite SSR modules), ${shadow.compared} runs compared, ${shadow.equal} equal; ${shadow.moduleResults.length} module files compared; corpus in .cache/interpreter-differential/corpus/${name}`);
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
