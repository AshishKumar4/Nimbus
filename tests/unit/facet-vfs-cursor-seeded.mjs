#!/usr/bin/env bun
// Every facet body that carries a staged VFS snapshot also carries the cursor
// that snapshot was read at: its store adopts the snapshot at that cursor, and
// its program's first ACQUIRE asks with it.
//
// The cursor is what dates the snapshot. Without one the store cannot tell
// how old the staged cells are, adopts none of them and reads every staged
// file from the session again at boot; and a barrier that asks about a null
// epoch, which no delta can be computed from, is answered with poison — drop
// the whole resident set and list it again. (Before the resident store, the
// next synchronous read of a staged cell after that raised EAGAIN.)
//
// Three generators each assemble a facet body around the same snapshot; the
// one-shot body gained the cursor and the other two did not, and the gap held
// for as long as nobody ran a resident process that read a staged data file
// synchronously after touching async fs. So each body is run, as it is
// launched, with a program that does exactly that: one async read, then a
// synchronous read of a staged file nothing changed. Every body carrying a
// snapshot is enumerated here, so a fourth cannot be added without answering
// for it.
//
// Each body runs in a child process of its own (runScenarios).

import assert from 'node:assert/strict';

import { VFS_CURSOR_SEED_SOURCE } from '../../packages/core/src/_shared/facet-vfs-cursor.ts';
import {
  generateEntrypointCode,
  generateLongRunningNodeCode,
} from '../../packages/worker/src/facets/manager.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { CRED, createAuthority, facetSupervisor, launchResident, runScenarios, until } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';

const DIR = 'home/user/app';
// The program each body runs: an async read, then a synchronous read of a
// staged, unchanged file. It marks where it begins, so the ACQUIREs of its own
// reads are told apart from its boot's.
const PROGRAM = `
const fs = require("fs");
(async () => {
  globalThis.__cursorTestProgram = true;
  await fs.promises.readFile("/${DIR}/other.txt", "utf8");
  let line;
  try { line = "read:" + fs.readFileSync("/${DIR}/data.txt", "utf8"); }
  catch (error) { line = "error:" + error.code; }
  process.stdout.write(line + "\\n");
})();
`;

/** A session whose working tree holds the staged file and the one read first. */
function session() {
  const authority = createAuthority();
  authority.kfs.mkdir(DIR, { recursive: true, mode: 0o755 });
  authority.kfs.writeFile(`${DIR}/data.txt`, 'staged');
  authority.kfs.writeFile(`${DIR}/other.txt`, 'other');
  return authority;
}

/**
 * What a body asks the session, seen at its SUPERVISOR: the cursor of each
 * ACQUIRE its program's reads ask with (fsAcquire's (epoch, rev), fsAcquired's
 * { epoch, cursor }), and every path whose bytes it reads (fsReadBatch, alone
 * or carried by an fsAcquired).
 */
function observer() {
  const seen = { acquires: [], reads: [] };
  seen.note = (op, args) => {
    if (globalThis.__cursorTestProgram === true) {
      if (op === 'fsAcquire') seen.acquires.push({ epoch: args[0], rev: args[1] });
      if (op === 'fsAcquired') seen.acquires.push({ epoch: args[0].epoch, rev: args[0].cursor });
    }
    const [name, batch] = op === 'fsAcquired' ? [args[1], args[2]?.[0]] : [op, args[0]];
    if (name !== 'fsReadBatch' || !Array.isArray(batch)) return;
    for (const entry of batch) if ('offset' in entry) seen.reads.push(entry.path.replace(/^\/+/, ''));
  };
  return seen;
}

/**
 * What a body's run must show: the staged file served from its snapshot, not
 * read from the session again; its program's first ACQUIRE asked at the
 * snapshot's cursor; and the file read synchronously after it. `staged` is
 * the cursor the snapshot was read at; for a launch that reads its own (the
 * manager's, which may advance the clock first), the session's cursor when
 * the launch began.
 */
function assertCoherent(label, seen, staged, line, { launched = false } = {}) {
  assert.deepEqual(seen.reads.filter((path) => path === `${DIR}/data.txt`), [], `${label}: the staged file is the snapshot's, never fetched again (reads: ${JSON.stringify(seen.reads)})`);
  assert.ok(seen.acquires.length > 0, `${label}: the async read asked an ACQUIRE`);
  const [first] = seen.acquires;
  assert.equal(first.epoch, staged.epoch, `${label}: the program's first ACQUIRE asks in the session's epoch, not a null one (${JSON.stringify(first)})`);
  if (launched) assert.ok(first.rev >= staged.rev, `${label}: at the revision its snapshot was read at (${first.rev}, launched at ${staged.rev})`);
  else assert.equal(first.rev, staged.rev, `${label}: at the revision the snapshot was read at`);
  assert.equal(line, 'read:staged', `${label}: the staged file still reads synchronously after the async read`);
}

const scenarios = {
  async 'one-shot node facet'() {
    const authority = session();
    const seen = observer();
    let out = '';
    // SUPERVISOR as the session serves the run, what it is asked observed.
    adoptCtxExports({
      SupervisorRPC: ({ props }) => {
        const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid: props?.pid }));
        return supervisorDouble(async (op, args) => {
          if (op === 'stdout' || op === 'stderr') { out += new TextDecoder().decode(args[0]); return; }
          if (op === 'reportExit') return;
          seen.note(op, args);
          return send(op, args);
        });
      },
    });
    const fm = oneShotManager('facet-vfs-cursor-seeded', { host: authority.host, rawVfs: authority.rawVfs, loader: runnerLoader('facet-vfs-cursor-seeded') });
    const cursor = authority.cursor();
    const result = await fm.exec(PROGRAM, { filename: `/${DIR}/main.js`, dirname: `/${DIR}`, cwd: `/${DIR}`, captureOutput: true });
    assert.equal(result.exitCode, 0, `the run exits 0: ${result.stderr}`);
    assertCoherent('one-shot', seen, cursor, (result.stdout || out).trim(), { launched: true });
  },

  async 'long-running node facet'() {
    const authority = session();
    const seen = observer();
    let forward = null;
    const observed = (op) => async (...args) => { seen.note(op, args); return forward(op, args); };
    const facet = facetSupervisor(authority, { fsAcquire: observed('fsAcquire'), fsReadBatch: observed('fsReadBatch') });
    forward = facet.forward;
    const cursor = authority.cursor();
    await launchResident({
      program: PROGRAM,
      env: { SUPERVISOR: facet.supervisor },
      cwd: `/${DIR}`,
      bundle: { [`${DIR}/data.txt`]: 'staged' },
      cursor,
      authority,
    });
    await until(() => facet.log.stdout.includes('\n'), 'the program\'s line', 10_000);
    assertCoherent('resident', seen, cursor, facet.log.stdout.trim());
  },

  async 'staged-artifact (opencode) facet'() {
    const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
    const authority = session();
    const { pid } = authority.host.processes.spawn('opencode', ['opencode'], `/${DIR}`, { cred: CRED });
    const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
    const seen = observer();
    const supervisor = supervisorDouble(async (op, args) => {
      if (op === 'stdout' || op === 'stderr' || op === 'reportExit') return;
      seen.note(op, args);
      return send(op, args);
    });
    const cursor = authority.cursor();
    // opencode's code is an ES module bundle, its fs the shims' (the map's node:fs bridge).
    const program = `
const fs = globalThis.__nimbusOpencodeBuiltins.fs;
export async function nimbusMain() {
  globalThis.__cursorTestProgram = true;
  await fs.promises.readFile("/${DIR}/other.txt", "utf8");
  let line;
  try { line = "read:" + fs.readFileSync("/${DIR}/data.txt", "utf8"); }
  catch (error) { line = "error:" + error.code; }
  process.stdout.write(line + "\\n");
}
`;
    const { runner } = await importOpencodeRunner({
      mode: 'oneshot', program, cwd: `/${DIR}`,
      vfsBundle: JSON.stringify({ [`${DIR}/data.txt`]: 'staged' }), vfsCursor: JSON.stringify(cursor),
    });
    const response = await runner.default.fetch(new Request('http://facet/run', { method: 'POST', body: JSON.stringify({ env: {} }) }), { SUPERVISOR: supervisor });
    const result = await response.json();
    assert.equal(result.exitCode, 0, `the run exits 0: ${result.stderr}`);
    assertCoherent('opencode', seen, cursor, result.stdout.trim());
  },
};

if (!process.env.NIMBUS_RESIDENT_BODY_SCENARIO) {
  // The other half of the same invariant. Both node bodies are addressed by the
  // bytes they generate — the one-shot by hash(code + bundle + manifest), the
  // resident one by the digest its facet image is named for — so a cursor in the
  // text gives the same program a different identity on every spawn, and hands a
  // body shared across sessions an epoch belonging to one of them. Two cursors,
  // one program, byte-identical output.
  const SOURCES = nodeFacetSources('/* __SHIMS_MARKER__ */');
  const at = (cursor) => ({
    bundle: { [`${DIR}/data.txt`]: 'staged' },
    manifest: { [DIR]: ['data.txt'] },
    metadata: { [`${DIR}/data.txt`]: { size: 6 } },
    cursor,
    reachableCount: 1,
    truncated: false,
  });
  const one = { epoch: 'epoch-under-test', rev: 4242 };
  const other = { epoch: 'a-different-incarnation', rev: 9 };
  assert.equal(
    (await generateEntrypointCode('', at(one), false, SOURCES)).code,
    (await generateEntrypointCode('', at(other), false, SOURCES)).code,
    'the one-shot body is addressed by its program, not by the cursor it runs at',
  );
  assert.equal(
    (await generateLongRunningNodeCode('', at(one), { cred: CRED }, false, SOURCES)).code,
    (await generateLongRunningNodeCode('', at(other), { cred: CRED }, false, SOURCES)).code,
    'the resident body is addressed by its program, not by the cursor it runs at',
  );

  // A facet built without a VFS has no state to be coherent with, and must not
  // invent a cursor for one — the seed is a no-op, not a fabricated epoch.
  const scope = { __nimbusVfsCursor: undefined };
  new Function('globalThis', `const __MODULE_VFS_CURSOR = null;\n${VFS_CURSOR_SEED_SOURCE}`)(scope);
  assert.equal(scope.__nimbusVfsCursor, undefined, 'a snapshot-less facet is left with no cursor rather than a fabricated one');
}

await runScenarios(import.meta.path, scenarios);
console.log('facet-vfs-cursor-seeded: OK');
