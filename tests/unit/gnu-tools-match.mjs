#!/usr/bin/env bun
// The shell's text tools answer as GNU's do (util-linux's for rev), byte for
// byte: stdout and exit status. Each fixture in tests/fixtures/gnu/ holds
// input files and, per command line, what the reference tool printed (as
// latin1, one character per byte) and its status; the tool and version are
// recorded in the fixture. A case's `%T` stands for the tool, so a case can
// pipe into it; otherwise the arguments follow the tool's name. Every case
// runs through the workspace shell on the same files, its stdout captured
// through a redirect so the bytes are compared, not a decoding of them. A
// case that writes files (sed -i, w) names them in `after`: each file's bytes
// afterwards, or null where the file must not exist. Its inputs are written
// afresh before it runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const dir = new URL('../fixtures/gnu/', import.meta.url);
const failures = [];
let cases = 0;
for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const writeInputs = async () => {
    for (const [file, base64] of Object.entries(fixture.inputs)) {
      if (file.includes('/')) await ws.fs.mkdir(`/home/user/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
      await ws.fs.writeFile(`/home/user/${file}`, new Uint8Array(Buffer.from(base64, 'base64')));
    }
  };
  await writeInputs();
  for (const { args, stdout, exit, after } of fixture.cases) {
    cases++;
    if (after) {
      await writeInputs();
      for (const file of Object.keys(after)) {
        if (!(file in fixture.inputs)) await ws.fs.unlink(`/home/user/${file}`).catch(() => {});
      }
    }
    const line = args.includes('%T') ? args.replaceAll('%T', fixture.tool) : `${fixture.tool} ${args}`;
    // Grouped, so a case's own 2>&1 folds stderr into what is compared.
    const r = await ws.exec(`cd /home/user && { ${line}
} > /tmp/.gnu-out`);
    const got = Buffer.from(await ws.fs.readFile('/tmp/.gnu-out')).toString('latin1');
    if (got !== stdout || (r.exitCode === 0) !== (exit === 0) || (exit === 1) !== (r.exitCode === 1)) {
      failures.push(`${fixture.tool} ${args}\n    reference (${exit}): ${JSON.stringify(stdout).slice(0, 200)}\n    ours (${r.exitCode}): ${JSON.stringify(got).slice(0, 200)} ${JSON.stringify(r.stderr).slice(0, 120)}`);
    }
    for (const [file, want] of Object.entries(after ?? {})) {
      let have = null;
      try { have = Buffer.from(await ws.fs.readFile(`/home/user/${file}`)).toString('latin1'); } catch {}
      if (have !== want) failures.push(`${fixture.tool} ${args}: ${file}\n    reference: ${JSON.stringify(want)}\n    ours: ${JSON.stringify(have)}`);
    }
  }
  await ws.close();
}
for (const failure of failures.slice(0, 20)) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} of ${cases} cases differ from the reference tools`);
console.log(`gnu-tools-match: ${cases} cases match the reference tools`);
