#!/usr/bin/env bun
// A launch's module map never goes past the platform's ceiling on it
// (fabric budgets.ts DYNAMIC_WORKER_CODE_LIMIT_BYTES, a total every member
// shares), whatever earlier runs learned.
//
// An astro project's first `astro dev` served; its second, in the same
// session, carried what the first had learned beside the same 39.4 MB of
// wasm, and its map was 68.5 MB: the facet host refused it at start, and the
// session's isolate reset holding it. What a launch must carry is its
// program's closure and the runtime; what earlier runs learned rides beside
// them only as far as the ceiling allows, the code the runs needed first
// kept first. What does not fit runs as it did in the run that learned it.
//
// Pinned on launches whose closure carries a wasm image sized to leave their
// map a little under the ceiling, relaunched after their run reports what it
// needed and the map lacked, in the order it needed it: runtime code it
// produced (resident and one-shot), and modules it executed late (resident).

import assert from 'node:assert/strict';
import { ModuleSource } from '../../packages/platform/src/module-source.ts';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from '../../packages/fabric/src/budgets.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { runtimeCodeKey, runtimeCodeModuleName } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { FacetManager, generatedMapTextBytes, learnedRuntimeCodeWithin } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';
import { moduleMapText } from './lib/module-map-bundle.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const CEILING = DYNAMIC_WORKER_CODE_LIMIT_BYTES;
const encoder = new TextEncoder();
/** What an assembled map carries, as the platform counts it. */
function mapBytes(modules) {
  let bytes = 0;
  for (const member of Object.values(modules)) {
    if (typeof member === 'string') bytes += encoder.encode(member).byteLength;
    else if (member?.wasm instanceof ArrayBuffer) bytes += member.wasm.byteLength;
    else for (const value of Object.values(member ?? {})) bytes += typeof value === 'string' ? encoder.encode(value).byteLength : value?.byteLength ?? 0;
  }
  return bytes;
}

const LIB = 'home/user/node_modules/dep/lib';
/** A program whose dependency reads a wasm image beside it, not yet written. */
function seedProgram(vfs) {
  const fs = vfs.as(CRED_KERNEL);
  fs.mkdir(LIB, { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/index.js' }), { mode: 0o644 });
  fs.writeFile(`${LIB}/index.js`,
    "const bytes = require('fs').readFileSync(require('path').join(__dirname, 'big.wasm'));\nmodule.exports = bytes.length;\n",
    { mode: 0o644 });
  return fs;
}
/** The image that leaves a map that held `bare` bytes without it `room` bytes under the ceiling. */
function writeImage(fs, bare, room) {
  const image = new Uint8Array(CEILING - bare - room);
  image.set([0, 97, 115, 109, 1, 0, 0, 0]);
  fs.writeFile(`${LIB}/big.wasm`, image, { mode: 0o644 });
}
/** Six pieces of code a run produced and could not compile, a megabyte each, in the order it needed them. */
const learnedCode = Array.from({ length: 6 }, (_, i) => ({ kind: 'expression', code: `"${String(i).repeat(1_000_000)}"` }));
/** Which of `learnedCode` a map stages, and that it is what was needed first. */
function stagedCode(modules) {
  const staged = learnedCode.map((entry) => modules[runtimeCodeModuleName(runtimeCodeKey(entry))] !== undefined);
  assert.ok(staged[0] && staged[1], `the code the run needed first is staged: ${JSON.stringify(staged)}`);
  assert.ok(!staged[5], `the code it needed last is what the ceiling leaves out: ${JSON.stringify(staged)}`);
  assert.deepEqual(staged, [...staged].sort((a, b) => Number(b) - Number(a)), `what is staged is what was needed first: ${JSON.stringify(staged)}`);
  return staged.filter(Boolean).length;
}

/** A resident manager, and a launch of the program that answers with the map it booted. */
function residentWorld(label) {
  const { manager, world, vfs } = launchManager(label, { session: launchSession() });
  const launch = async () => {
    const before = world.configs.size;
    let pid;
    try {
      ({ pid } = await manager.spawnNode("require('dep');", { filename: '/home/user/run.js', cwd: '/home/user', command: 'dep-server' }));
    } catch (error) {
      return { config: null, output: String(error?.message ?? error) };
    }
    for (let i = 0; i < 2000 && world.configs.size === before && manager.processes.get(pid)?.state === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const config = world.configs.size > before ? [...world.configs.values()].at(-1) : null;
    return { pid, config, output: manager.processes.allLogs(pid).map((chunk) => chunk.data).join('') };
  };
  return { manager, fs: seedProgram(vfs), launch };
}

try {
  // ── 0. the count, and the choice, a map is made under ──────────────────
  {
    const texts = ['plain ascii', `two-byte é€ and a pair 😀, ${'x'.repeat(300_000)}`, 'lone \ud800 surrogate', ''];
    const generated = { code: texts[0], source: new ModuleSource([texts[0]]), immutableModules: {}, modules: { a: texts[1] }, codeModules: { b: texts[2], c: texts[3] } };
    const exact = texts.reduce((sum, text) => sum + encoder.encode(text).byteLength, 0);
    assert.equal(generatedMapTextBytes(generated, 0), exact, 'a map is counted as the platform counts it, in UTF-8 bytes');
    assert.equal(generatedMapTextBytes(generated, 3 * exact), null, 'a map that cannot reach its room is not read');

    // Six pieces in the order they were needed; the second does not fit
    // beside the first, the third and fourth do.
    const key = (i) => String(i).repeat(64);
    const listed = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => key(i))).length;
    const learned = [[key(0), 400], [key(1), 900], [key(2), 100], [key(3), 50], [key(4), 500], [key(5), 10]];
    const held = 10_000;
    const bytes = held + learned.reduce((sum, [, size]) => sum + size, 0) + listed(6) - 2;
    const room = held + 400 + 100 + 50 + 10 + listed(4);
    const { kept, over } = learnedRuntimeCodeWithin(bytes, learned, room);
    assert.deepEqual(kept, [key(0), key(2), key(3), key(5)], 'each piece that still fits is kept, in the order it was needed');
    assert.equal(over, 0);
    assert.deepEqual(learnedRuntimeCodeWithin(bytes, learned, held - 7), { kept: [], over: 7 }, 'a map over with none of it says by how much');
    console.log('  a map is counted in UTF-8 bytes, and keeps its learned code first-needed first');
  }

  // ── 1. a resident relaunch stages the runtime code its run needed first ──
  {
    const { manager, fs, launch } = residentWorld('module-map-under-ceiling');
    const bare = await launch();
    assert.ok(bare.config, `the launch without its wasm image started: ${bare.output}`);
    writeImage(fs, mapBytes(bare.config.modules), 3_000_000);
    const first = await launch();
    assert.ok(first.config, `the launch with its wasm image started: ${first.output}`);
    assert.ok(mapBytes(first.config.modules) <= CEILING - 3_000_000 + 64 * 1024, 'the image is in the map');

    await manager.noteProcessRuntimeCode(first.pid, learnedCode);
    const second = await launch();
    assert.ok(second.config, `the relaunch started rather than being refused at its ceiling: ${second.output.slice(-600)}`);
    const bytes = mapBytes(second.config.modules);
    assert.ok(bytes <= CEILING, `the relaunch's map is ${bytes} bytes, within the ${CEILING}-byte ceiling`);
    console.log(`  a resident relaunch stages the runtime code its run needed first, as far as its ceiling allows: ${stagedCode(second.config.modules)} of 6, ${bytes} bytes`);
  }

  // ── 2. a resident relaunch stages the modules its run executed first ─────
  //
  // Modules a run executed late are roots of the next launch's walk, their
  // imports with them. Over the ceiling with none of the runtime code, the
  // launch is walked again under a bound that much lower, those roots
  // optional: each staged whole or not at all, the first-learned first.
  {
    const { manager, fs, launch } = residentWorld('module-map-under-ceiling-roots');
    fs.mkdir('home/user/node_modules/late', { recursive: true, mode: 0o755 });
    fs.writeFile('home/user/node_modules/late/a.js', `module.exports = "A-executed-first ${'a'.repeat(600_000)}";\n`, { mode: 0o644 });
    fs.writeFile('home/user/node_modules/late/b.js', `module.exports = "B-executed-next ${'b'.repeat(700_000)}";\n`, { mode: 0o644 });
    const bare = await launch();
    assert.ok(bare.config, `the launch without its wasm image started: ${bare.output}`);
    writeImage(fs, mapBytes(bare.config.modules), 1_000_000);
    const first = await launch();
    assert.ok(first.config, `the launch with its wasm image started: ${first.output}`);

    await manager.noteProcessRuntimeCode(first.pid, [], ['home/user/node_modules/late/a.js', 'home/user/node_modules/late/b.js']);
    const second = await launch();
    assert.ok(second.config, `the relaunch started rather than being refused at its ceiling: ${second.output.slice(-600)}`);
    const bytes = mapBytes(second.config.modules);
    assert.ok(bytes <= CEILING, `the relaunch's map is ${bytes} bytes, within the ${CEILING}-byte ceiling`);
    const text = moduleMapText(second.config.modules);
    assert.ok(text.includes('A-executed-first'), 'the module the run executed first is staged');
    assert.ok(!text.includes('B-executed-next'), 'the one it executed next, which the ceiling has no room for, loads late');
    console.log(`  a resident relaunch stages the modules its run executed first, as far as its ceiling allows: ${bytes} bytes`);
  }

  // ── 3. a one-shot rerun stages the runtime code its run needed first ─────
  {
    const loads = [];
    let report = {};
    const env = {
      LOADER: {
        load(config) {
          loads.push(config);
          return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '', ...report }); } }) };
        },
        get() { throw new Error('a one-shot never takes the keyed loader path'); },
      },
      ASSETS: stagedAssets,
    };
    const manager = new FacetManager(
      createFacetCtx(createFacetWorld(() => ({})), 'module-map-under-ceiling-one-shot'),
      env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
    );
    const { vfs } = launchSession();
    manager.setVfs(vfs, new ProcessFiles(vfs));
    const fs = seedProgram(vfs);
    const run = async () => {
      const result = await manager.exec("require('dep');", { filename: '/home/user/run.js', cwd: '/home/user', captureOutput: true });
      return { result, config: loads.at(-1) };
    };

    const bare = await run();
    assert.equal(bare.result.exitCode, 0, `the run without its wasm image ran: ${bare.result.stderr}`);
    writeImage(fs, mapBytes(bare.config.modules), 3_000_000);
    report = { runtimeCode: learnedCode };
    const first = await run();
    assert.equal(first.result.exitCode, 0, `the run with its wasm image ran: ${first.result.stderr}`);
    report = {};
    const second = await run();
    assert.equal(second.result.exitCode, 0, `the rerun ran rather than being refused at its ceiling: ${second.result.stderr}`);
    const bytes = mapBytes(second.config.modules);
    assert.ok(bytes <= CEILING, `the rerun's map is ${bytes} bytes, within the ${CEILING}-byte ceiling`);
    console.log(`  a one-shot rerun stages the runtime code its run needed first, as far as its ceiling allows: ${stagedCode(second.config.modules)} of 6, ${bytes} bytes`);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

console.log('module-map-under-ceiling: OK');
process.exit(0);
