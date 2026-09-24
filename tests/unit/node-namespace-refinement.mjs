#!/usr/bin/env bun
// The refinement bridge for the coherence model of a resident node facet's
// namespace and pushed content (Lean: Nimbus.Coherence.Namespace.apply).
//
// The model generates lean/fixtures/node-namespace.json: cases of an initial
// filesystem and a sequence of authority mutations and facet steps, each facet
// observation carrying the value the model proves. This runs every case on
// the deployed TypeScript — the real generated resident body and shims over a
// real SqliteVFS — and requires the same observations. A case the code
// answers differently is a refinement failure, whichever side is wrong.
//
// Fixture paths are rooted in the process's working tree, so every file is in
// the launch's data plan and under its push roots, as the model assumes.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
} from './lib/resident-body.mjs';

const FIXTURE = 'lean/fixtures/node-namespace.json';
const ROOT = 'home/user/app';
const at = (p) => ROOT + (p === '/' ? '' : p);

/** Cases checked here whatever the model has emitted: the invariants' corner cases. */
const LOCAL = [
  {
    name: 'peer create, delete, recreate within one delta',
    initial: { '/a': { kind: 'dir' }, '/a/f': { kind: 'file', bytes: 'x' } },
    steps: [
      { auth: 'rm', path: '/a/f' }, { auth: 'write', path: '/a/f', bytes: 'y' }, { auth: 'write', path: '/a/g', bytes: 'g' },
      { facet: 'acquire' },
      { facet: 'read', path: '/a/f', expect: 'y' },
      { facet: 'readdir', path: '/a', expect: ['f', 'g'] },
    ],
  },
  {
    name: 'peer rename of a directory moves its subtree',
    initial: { '/a': { kind: 'dir' }, '/a/d': { kind: 'dir' }, '/a/d/f': { kind: 'file', bytes: 'x' } },
    steps: [
      { auth: 'rename', path: '/a/d', to: '/a/e' },
      { facet: 'acquire' },
      { facet: 'stat', path: '/a/d/f', expect: 'ENOENT' },
      { facet: 'stat', path: '/a/e/f', expect: { kind: 'file' } },
      { facet: 'read', path: '/a/e/f', expect: 'x' },
    ],
  },
  {
    // The model's counterexample: a log naming only the removed root leaves
    // /d/y as a ghost once /d is recreated. The session logs every path.
    name: 'recursive removal then recreation leaves no ghost',
    initial: { '/d': { kind: 'dir' }, '/d/y': { kind: 'file', bytes: 'y' }, '/d/s': { kind: 'dir' }, '/d/s/z': { kind: 'file', bytes: 'z' } },
    steps: [
      { auth: 'rmrf', path: '/d' }, { auth: 'mkdir', path: '/d' },
      { facet: 'acquire' },
      { facet: 'readdir', path: '/d', expect: [] },
      { facet: 'stat', path: '/d/y', expect: 'ENOENT' },
      { facet: 'stat', path: '/d/s/z', expect: 'ENOENT' },
    ],
  },
  {
    name: 'rename onto a recreated source leaves no ghost',
    initial: { '/d': { kind: 'dir' }, '/d/y': { kind: 'file', bytes: 'y' } },
    steps: [
      { auth: 'rename', path: '/d', to: '/e' }, { auth: 'mkdir', path: '/d' },
      { facet: 'acquire' },
      { facet: 'readdir', path: '/d', expect: [] },
      { facet: 'read', path: '/e/y', expect: 'y' },
    ],
  },
  {
    name: 'own write survives a peer barrier until flushed, then a peer write wins',
    initial: { '/a': { kind: 'dir' }, '/a/f': { kind: 'file', bytes: 'x' } },
    steps: [
      { facet: 'writeSync', path: '/a/f', bytes: 'mine' },
      { facet: 'acquire' },
      { facet: 'read', path: '/a/f', expect: 'mine' },
      { facet: 'flush', path: '/a/f' },
      { auth: 'write', path: '/a/f', bytes: 'peer' },
      { facet: 'acquire' },
      { facet: 'read', path: '/a/f', expect: 'peer' },
    ],
  },
  {
    name: 'a trimmed log (poison) relists the namespace',
    initial: { '/a': { kind: 'dir' }, '/a/f': { kind: 'file', bytes: 'x' } },
    steps: [
      { auth: 'rmrf', path: '/a' }, { auth: 'mkdir', path: '/b' }, { auth: 'write', path: '/b/h', bytes: 'h' },
      { auth: 'trim' },
      { facet: 'acquire' },
      { facet: 'stat', path: '/a', expect: 'ENOENT' },
      { facet: 'readdir', path: '/b', expect: ['h'] },
      { facet: 'read', path: '/b/h', expect: 'h' },
    ],
  },
];

const fixture = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const cases = [...LOCAL, ...(fixture?.cases ?? []).map((c, i) => ({ name: c.name ?? `${fixture.fixture} #${i}`, initial: {}, ...c }))];

/** The facet's whole namespace under ROOT, as the fixture states it: path → {kind, bytes}. */
function snapshot(fs) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = dir + '/' + name;
      const key = rel + '/' + name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) { out[key] = { kind: 'dir' }; walk(abs, key); }
      else out[key] = { kind: 'file', bytes: fs.readFileSync(abs, 'utf8') };
    }
  };
  walk('/' + ROOT, '');
  return out;
}

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = {
  fs,
  run: (f) => { try { return f(); } catch (e) { return "ERR:" + e.code; } },
  resume: () => new Promise((resolve) => setTimeout(resolve, 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

function authStep(authority, step) {
  const { kfs, rawVfs } = authority;
  const p = at(step.path);
  switch (step.auth) {
    case 'write': kfs.writeFile(p, step.bytes); return;
    case 'mkdir': kfs.mkdir(p, { recursive: true, mode: 0o755 }); return;
    case 'rm': kfs.unlink(p); return;
    case 'rmrf': kfs.removeRecursive(p); return;
    case 'rename': kfs.rename(p, at(step.to)); return;
    case 'trim': {
      // Churn past the retained invalidation log, so the next delta is a poison.
      kfs.mkdir(at('/.churn'), { recursive: true, mode: 0o755 });
      const floor = rawVfs.revision();
      for (let i = 0; rawVfs.invalidatedSince(rawVfs.epoch, floor).poison === false; i++) {
        kfs.writeFile(at(`/.churn/${'c'.repeat(200)}${i}`), 'x');
      }
      kfs.removeRecursive(at('/.churn'));
      return;
    }
    default: throw new Error(`unknown authority step ${step.auth}`);
  }
}

async function facetStep(probe, step) {
  const { fs } = probe;
  const p = '/' + at(step.path);
  switch (step.facet) {
    case 'acquire': {
      await probe.resume();
      // The model's claim: after the barrier the namespace (and every held
      // file's bytes) is exactly the authority's.
      if (step.expect) assert.deepEqual(snapshot(fs), step.expect, 'namespace after ACQUIRE');
      return;
    }
    case 'writeSync': fs.writeFileSync(p, step.bytes); return;
    case 'flush': await globalThis.__nimbusVfsReleaseBarrier(); return;
    case 'read': {
      const got = probe.run(() => fs.readFileSync(p, 'utf8'));
      assert.equal(got.replace(/^ERR:/, ''), step.expect, `read ${step.path}`);
      return;
    }
    case 'stat': {
      const got = probe.run(() => fs.statSync(p));
      if (typeof got === 'string') assert.equal(got.replace(/^ERR:/, ''), step.expect, `stat ${step.path}`);
      else assert.deepEqual({ kind: got.isDirectory() ? 'dir' : got.isSymbolicLink() ? 'symlink' : 'file' }, step.expect, `stat ${step.path}`);
      return;
    }
    case 'readdir': {
      const got = probe.run(() => fs.readdirSync(p));
      assert.deepEqual(got, step.expect, `readdir ${step.path}`);
      return;
    }
    default: throw new Error(`unknown facet step ${step.facet}`);
  }
}

await runScenarios(import.meta.path, Object.fromEntries(cases.map((c) => [c.name, async () => {
  const authority = createAuthority();
  authority.kfs.mkdir(ROOT, { recursive: true, mode: 0o755 });
  for (const [path, entry] of Object.entries(c.initial).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.kind === 'dir') authority.kfs.mkdir(at(path), { recursive: true, mode: 0o755 });
    else authority.kfs.writeFile(at(path), entry.bytes ?? '');
  }
  const { supervisor } = facetSupervisor(authority);
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: supervisor }, cursor: authority.cursor() });
  const probe = globalThis.__probe;
  for (const step of c.steps) {
    if (step.auth) authStep(authority, step);
    else await facetStep(probe, step);
  }
}])), { barrierFailures: false });

