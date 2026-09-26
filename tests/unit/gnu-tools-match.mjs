#!/usr/bin/env bun
// The shell's text tools answer as GNU's do (util-linux's for rev), byte for
// byte: stdout and exit status. Each fixture in tests/fixtures/gnu/ holds
// input files and, per command line, what the reference tool printed (as
// latin1, one character per byte) and its status; the tool and version are
// recorded in the fixture. A case's `%T` stands for the tool, so a case can
// pipe into it; otherwise the arguments follow the tool's name. Every case
// runs through the workspace shell on the same files, its stdout captured
// through a redirect so the bytes are compared, not a decoding of them.
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
    const line = args.includes('%T') ? args.replaceAll('%T', fixture.tool) : `${fixture.tool} ${args}`;
    const r = await ws.exec(`cd /home/user && ${line} > /tmp/.gnu-out`);
    const got = Buffer.from(await ws.fs.readFile('/tmp/.gnu-out')).toString('latin1');
    if (got !== stdout || (r.exitCode === 0) !== (exit === 0) || (exit === 1) !== (r.exitCode === 1)) {
      failures.push(`${fixture.tool} ${args}\n    reference (${exit}): ${JSON.stringify(stdout).slice(0, 200)}\n    ours (${r.exitCode}): ${JSON.stringify(got).slice(0, 200)} ${JSON.stringify(r.stderr).slice(0, 120)}`);
    }
  }
  await ws.close();
}
for (const failure of failures.slice(0, 20)) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} of ${cases} cases differ from the reference tools`);
console.log(`gnu-tools-match: ${cases} cases match the reference tools`);
