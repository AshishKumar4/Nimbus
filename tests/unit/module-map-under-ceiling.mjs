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
// Pinned here on a resident launch whose closure carries a wasm image sized
// to leave its map 3 MB under the ceiling, relaunched after its run reports
// 6 MB of runtime code it produced, in the order it needed it.

import assert from 'node:assert/strict';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from '../../packages/fabric/src/budgets.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { runtimeCodeKey, runtimeCodeModuleName } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

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

try {
  const { manager, world, vfs } = launchManager('module-map-under-ceiling');
  const fs = vfs.as(CRED_KERNEL);
  const LIB = 'home/user/node_modules/dep/lib';
  fs.mkdir(LIB, { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/index.js' }), { mode: 0o644 });
  fs.writeFile(`${LIB}/index.js`,
    "const bytes = require('fs').readFileSync(require('path').join(__dirname, 'big.wasm'));\nmodule.exports = bytes.length;\n",
    { mode: 0o644 });

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

  // What the program's map holds without the image, so the image can be sized
  // to leave it 3 MB under the ceiling.
  const bare = await launch();
  assert.ok(bare.config, `the launch without its wasm image started: ${bare.output}`);
  const room = 3_000_000;
  const image = new Uint8Array(DYNAMIC_WORKER_CODE_LIMIT_BYTES - mapBytes(bare.config.modules) - room);
  image.set([0, 97, 115, 109, 1, 0, 0, 0]);
  fs.writeFile(`${LIB}/big.wasm`, image, { mode: 0o644 });

  const first = await launch();
  assert.ok(first.config, `the launch with its wasm image started: ${first.output}`);
  const firstBytes = mapBytes(first.config.modules);
  assert.ok(firstBytes <= DYNAMIC_WORKER_CODE_LIMIT_BYTES - room + 64 * 1024,
    `the image is in the map (${firstBytes} bytes)`);

  // Its run produced six pieces of code it could not compile, a megabyte each,
  // in this order: the next launch stages them, as far as the ceiling allows.
  const learned = Array.from({ length: 6 }, (_, i) => ({ kind: 'expression', code: `"${String(i).repeat(1_000_000)}"` }));
  await manager.noteProcessRuntimeCode(first.pid, learned);

  const second = await launch();
  assert.ok(second.config, `the relaunch started rather than being refused at its ceiling: ${second.output.slice(-600)}`);
  const secondBytes = mapBytes(second.config.modules);
  assert.ok(secondBytes <= DYNAMIC_WORKER_CODE_LIMIT_BYTES,
    `the relaunch's map is ${secondBytes} bytes, within the ${DYNAMIC_WORKER_CODE_LIMIT_BYTES}-byte ceiling`);
  const staged = learned.map((entry) => second.config.modules[runtimeCodeModuleName(runtimeCodeKey(entry))] !== undefined);
  assert.ok(staged[0] && staged[1], `the code the run needed first is staged: ${JSON.stringify(staged)}`);
  assert.ok(!staged[5], `the code it needed last is what the ceiling leaves out: ${JSON.stringify(staged)}`);
  assert.deepEqual(staged, [...staged].sort((a, b) => Number(b) - Number(a)),
    `what is staged is what was needed first: ${JSON.stringify(staged)}`);
  console.log(`  a relaunch carries what its runs learned as far as its ceiling allows: ${staged.filter(Boolean).length} of 6, ${secondBytes} bytes`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

console.log('module-map-under-ceiling: OK');
