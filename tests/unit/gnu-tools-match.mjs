#!/usr/bin/env bun
// The shell's od, cut and grep answer as GNU's do, byte for byte (stdout and
// exit status). Each
// fixture in tests/fixtures/gnu/ holds input files and, per argument list,
// the stdout and exit status GNU's own tool gave (the version is recorded in
// the fixture). Every case runs through the workspace shell on the same files.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const dir = new URL('../fixtures/gnu/', import.meta.url);
const failures = [];
let cases = 0;
for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  for (const [file, base64] of Object.entries(fixture.inputs)) {
    if (file.includes('/')) await ws.fs.mkdir(`/home/user/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    await ws.fs.writeFile(`/home/user/${file}`, new Uint8Array(Buffer.from(base64, 'base64')));
  }
  for (const { args, stdout, exit } of fixture.cases) {
    cases++;
    const r = await ws.exec(`cd /home/user && ${fixture.tool} ${args}`);
    if (r.stdout !== stdout || (r.exitCode === 0) !== (exit === 0) || (exit === 1) !== (r.exitCode === 1)) {
      failures.push(`${fixture.tool} ${args}\n    GNU (${exit}): ${JSON.stringify(stdout).slice(0, 200)}\n    ours (${r.exitCode}): ${JSON.stringify(r.stdout).slice(0, 200)} ${JSON.stringify(r.stderr).slice(0, 120)}`);
    }
  }
  await ws.close();
}
for (const failure of failures.slice(0, 20)) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} of ${cases} cases differ from GNU`);
console.log(`gnu-tools-match: ${cases} cases match GNU`);
