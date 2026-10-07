#!/usr/bin/env bun
// printf %q and the names in the checksum tools' messages quote a word as
// gnulib's quotearg shell-escape style does, with one implementation
// (_shared/shell-quote.ts). They were two: printf %q left `=` and `^` bare,
// single-quoted a lone `'`, and wrote control characters raw; the checksum
// tools left `=`, `^` and a lone `{` bare. The answers are GNU coreutils
// 9.7's printf %q, recorded 2026-10-05 (and checked against `gnuprintf`
// where it is installed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { singleQuote } from '../../packages/core/src/_shared/shell-quote.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const CASES = [["plain", "plain"], ["a b", "'a b'"], ["a=b", "'a=b'"], ["a^b", "'a^b'"], ["a{b", "a{b"], ["{", "'{'"], ["}", "'}'"], ["a}", "a}"], ["it's", "\"it's\""], ["\u00e9", "\u00e9"], ["a!b", "'a!b'"], ["a,b", "a,b"], ["]", "]"], ["?", "'?'"], ["a\\b", "'a\\b'"], ["#a", "'#a'"], ["a#", "a#"], ["~a", "'~a'"], ["a~", "a~"], ["it's $x", "'it'\\''s $x'"], ["a\"b", "'a\"b'"], ["\n", "''$'\\n'"], ["a\nb", "'a'$'\\n''b'"], ["\na", "''$'\\n''a'"], ["\t\t", "''$'\\t\\t'"], ["\u0001", "''$'\\001'"], ["it's\n", "'it'\\''s'$'\\n'"], ["\u007f", "''$'\\177'"], ["@%+:-./_", "@%+:-./_"], ["", "''"]];

if (spawnSync('gnuprintf', ['--version']).status === 0) {
  for (const [value, want] of CASES) assert.equal(spawnSync('gnuprintf', ['%q', value], { encoding: 'utf8' }).stdout, want, `GNU: ${JSON.stringify(value)}`);
}

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [value, want] of CASES) {
    const r = await ws.exec(`printf %q ${singleQuote(value)}`);
    assert.equal(r.stdout, want, `printf %q ${JSON.stringify(value)}`);
    if (value === '' || value.includes('/')) continue;
    const missing = await ws.exec(`cd /tmp && md5sum ${singleQuote(value)}`);
    assert.equal(missing.stderr, `md5sum: ${want}: No such file or directory\n`, `md5sum ${JSON.stringify(value)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-quote-gnu: ${CASES.length} words quoted as GNU quotes them`);
