#!/usr/bin/env bun
// Backslash escapes as the shell's echo builtin, its registry echo (what
// `xargs echo` runs) and printf expand them: one engine
// (substrate/lifo/utils/backslash-escapes.ts) in three dialects. Each case's
// output was recorded from the reference on 2026-10-05: printf's from GNU
// coreutils 9.7's printf, echo's from GNU bash 5.2's builtin echo. printf's
// %b had its own replace chain, which read only \\ \n \t \r and turned `\\`
// into a NUL; and the echo builtin dropped the backslash of an escape it did
// not know, read no \c or \e, and printf's format no \NNN.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CASES = [
  ["printf", ["%b|\\n", "a\\tb\\\\c\\x41\\0101\\101\\n"], "a\tb\\cAAA\n|\n"],
  ["printf", ["%b|\\n", "\\a\\b\\f\\v\\e"], "\u0007\b\f\u000b\u001b|\n"],
  ["printf", ["%b|\\n", "x\\cy"], "x"],
  ["printf", ["%s-%b\\n", "p", "q\\cr", "s", "t"], "p-q"],
  ["printf", ["%b\\n", "a\\\\b"], "a\\b\n"],
  ["printf", ["\\101\\x41\\0101|%s\\n", "z"], "AA\b1|z\n"],
  ["printf", ["a\\cb%s\\n", "q"], "a"],
  ["printf", ["%b\\n", "\\u00e9\\q\\\""], "\u00c3\u00a9\\q\"\n"],
  ["printf", ["\\\"\\q|\\n"], "\"\\q|\n"],
  ["echo", ["-e", "a\\tb\\\\c\\x41\\0101\\101"], "a\tb\\cAA\\101\n"],
  ["echo", ["-e", "x\\cy"], "x"],
  ["echo", ["-ne", "a\\nb"], "a\nb"],
  ["echo", ["-e", "\\e\\E\\q\\\""], "\u001b\u001b\\q\\\"\n"],
  ["echo", ["-E", "a\\tb"], "a\\tb\n"],
  ["echo", ["-en", "x"], "x"],
  ["echo", ["-e", "\\u00e9"], "\u00c3\u00a9\n"],
  ["echo", ["a", "-e"], "a -e\n"],
];

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const quote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
try {
  // The bytes written, read back through a redirect as latin1, one char per byte.
  const run = async (line) => {
    const r = await ws.exec(`{ ${line}\n} > /tmp/.escapes-out`);
    assert.equal(r.exitCode, 0, `${line}: ${r.stderr}`);
    return Buffer.from(await ws.fs.readFile('/tmp/.escapes-out')).toString('latin1');
  };
  for (const [tool, args, want] of CASES) {
    const line = `${tool} ${args.map(quote).join(' ')}`;
    assert.equal(await run(line), want, line);
    if (tool === 'echo') {
      assert.equal(await run(`printf '%s\\0' ${args.map(quote).join(' ')} | xargs -0 echo`), want, `xargs ${line}`);
    }
  }
} finally {
  await ws.close();
}
console.log(`echo-printf-escapes: ${CASES.length} cases match`);
