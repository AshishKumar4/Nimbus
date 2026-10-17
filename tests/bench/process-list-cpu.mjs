#!/usr/bin/env bun
// Independent module copies and databases for main, main's null arm, and head.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const source = new URL('../../packages/core/src/', import.meta.url).pathname;
const measured = { vfs: ['sqlite-vfs.ts', 'path.ts', 'composite.ts', 'sqlite-files.ts'], runtime: ['process-files.ts', 'sqlite-runtime-fs-bridge.ts'] };
const scratch = [];
const results = [];
let checksum = 0;

async function load(from) {
  const fixture = mkdtempSync(join(source, '.process-list-cpu-'));
  scratch.push(fixture);
  for (const entry of readdirSync(source)) {
    if (entry.startsWith('.process-list-cpu-')) continue;
    if (!Object.hasOwn(measured, entry)) { symlinkSync(join(source, entry), join(fixture, entry)); continue; }
    mkdirSync(join(fixture, entry));
    for (const file of readdirSync(join(source, entry))) {
      const target = join(fixture, entry, file);
      if (measured[entry].includes(file)) writeFileSync(target, readFileSync(join(from, entry, file)));
      else symlinkSync(join(source, entry, file), target);
    }
  }
  const at = (path) => import(pathToFileURL(join(fixture, path)).href);
  const [{ SqliteVFS }, { ProcessFiles }] = await Promise.all(['vfs/sqlite-vfs.ts', 'runtime/process-files.ts'].map(at));
  return { SqliteVFS, ProcessFiles };
}

async function make({ SqliteVFS, ProcessFiles }, size) {
  const host = await hostSqlite();
  const engine = new SqliteVFS(host.sql, host.transactions);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('tree');
  for (let offset = 0; offset < size; offset += 64) {
    root.writeBatch({ inodes: Array.from({ length: Math.min(64, size - offset) }, (_, i) => ({
      path: `tree/f${String(offset + i).padStart(6, '0')}`, parentPath: 'tree', isDir: false,
      size: 0, mtime: 1, mode: 0o644, chunkCount: 0, uid: 0, gid: 0,
    })), chunks: [] });
  }
  root.writeFile('tree/mutated', 'initial');
  const files = new ProcessFiles(engine);
  const bridge = files.bind({ pid: 71, cred: CRED_KERNEL });
  const page = bridge.list(null, 256);
  assert.equal(page instanceof Promise, false);
  return { engine, root, files, bridge, writes: 0, nextPid: 72 };
}

try {
  const modules = {};
  const sources = { A: baseline, null: baseline, real: source };
  for (const name of shuffled(Object.keys(sources))) modules[name] = await load(sources[name]);
  for (const [label, size] of [['small', 64], ['large', 8192]]) {
    const arms = {};
    for (const name of shuffled(Object.keys(sources))) arms[name] = await make(modules[name], size);
    const cpu = async (arm, kind) => {
      const cursor = { epoch: arm.engine.epoch, rev: arm.engine.revision() };
      if (kind === 'acquire-one') arm.root.writeFile('tree/mutated', `write-${++arm.writes}`);
      return cpuMs(async () => {
        const count = kind === 'cold-first-list' ? 20 : kind === 'first-list' ? 80 : 2000;
        for (let i = 0; i < count; i++) {
          if (kind === 'cold-first-list') {
            const pid = arm.nextPid++;
            const bridge = arm.files.bind({ pid, cred: CRED_KERNEL });
            const page = bridge.list(null, 256);
            assert.equal(page instanceof Promise, false);
            checksum += page.entries.length;
            await arm.files.releaseProcess(pid);
          } else if (kind === 'first-list') {
            const page = arm.bridge.list(null, 256);
            assert.equal(page instanceof Promise, false);
            checksum += page.entries.length;
          } else {
            const answer = arm.bridge.acquire(cursor.epoch, cursor.rev, { namespace: true });
            assert.equal(answer.poison, false);
            assert.equal(answer.paths.length > 0, kind === 'acquire-one');
            checksum += answer.rev + answer.paths.length;
          }
        }
      });
    };
    for (const kind of ['acquire-none', 'acquire-one', 'first-list', 'cold-first-list']) {
      const iterations = kind === 'cold-first-list' ? 20 : kind === 'first-list' ? 80 : 2000;
      const result = await pairedKind(kind, arms, cpu, { pairs: 30, warm: 8, iterations });
      result.kind = `${label}/${kind}`;
      results.push(result);
      writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
      const { samples, ...summary } = result;
      console.log(JSON.stringify(summary));
    }
    for (const arm of Object.values(arms)) await arm.files.releaseProcess(71);
  }
  assert.ok(checksum > 0);
} finally {
  for (const fixture of scratch) rmSync(fixture, { recursive: true, force: true });
}
