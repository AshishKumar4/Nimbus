#!/usr/bin/env bun
// An octal or hex escape names one byte, as bash and GNU printf have it:
// printf's format and %b argument and echo -e each write the bytes their
// escapes name (`\303\251` is the two bytes of "é", `\377` the byte 0xff),
// while \u and \U name a character, written as its UTF-8 bytes (a surrogate
// as its own three, never paired); printf's %c writes its argument's first
// byte, and its width and precision count bytes. Checked against the host's bash over the
// same lines, byte for byte (od).
//
// Red before: the escapes became the characters U+00C3 U+00A9, written as
// UTF-8 (c3 83 c2 a9).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const HEX = ' | od -An -tx1';
const CASES = [
  `printf '\\303\\251'${HEX}`,
  `printf '\\357\\273\\277t'${HEX}`,
  `printf '\\xc3\\xa9\\n'${HEX}`,
  `printf '\\377\\376a'${HEX}`,
  `printf 'a\\0b'${HEX}`,
  `printf '\\u00e9\\U0001F600'${HEX}`,
  `printf '%b' '\\0303\\0251'${HEX}`,
  `printf '%b|%s' '\\303\\251' '\\303'${HEX}`,
  `printf '%c' $(printf '\\303\\251')${HEX}`,
  `echo -e '\\0303\\0251'${HEX}`,
  `echo -e '\\xc3\\xa9 \\0377'${HEX}`,
  `x=$(printf '\\357\\273\\277t'); printf %s "$x"${HEX}`,
  `ln -s "$(printf '\\357\\273\\277t')" bom && readlink bom${HEX}`,
  `x=$(printf '\\377a'); { printf '[%s]' "$x"; echo "$x"; }${HEX}`,
  `printf '\\303\\251' > f && od -An -tx1 f && wc -c < f`,
  // A \u escape of a surrogate is its own three bytes, never paired with what follows.
  `printf '\\uD800\\377'${HEX}`,
  `printf '\\uD800%c' é${HEX}`,
  `printf '\\uDC80'${HEX}`,
  `printf '%b' '\\uDBFF\\uDFFF'${HEX}`,
  `echo -e '\\uD800\\0377'${HEX}`,
  // printf's width and precision count bytes, so a cut never leaves half a character to pair with a byte.
  `printf '%.1s\\377' '😀'${HEX}`,
  `printf '%.1s\\uDC80' '😀'${HEX}`,
  `printf '%.1s|%.2s|%5s|%-4s|%.3s|' é é é é aé${HEX}`,
  `printf '%.1b|%4b|' é '\\303\\251'${HEX}`,
];

const run = (line) => `${line}; echo "status=$?"`;
const dir = mkdtempSync(join(tmpdir(), 'printf-bytes-gnu-'));
const gnu = {};
try {
  for (const line of CASES) {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    gnu[line] = { stdout: r.stdout, stderr: r.stderr };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const line of CASES) {
    const r = await ws.exec(run(line), { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr };
    try {
      assert.deepEqual(ours, gnu[line]);
      console.log(`  ✓ ${line.slice(0, 80)}`);
    } catch {
      failed.push(`${line}\n  gnu:  ${JSON.stringify(gnu[line])}\n  ours: ${JSON.stringify(ours)}`);
      console.log(`  ✗ ${line.slice(0, 80)}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);

// An escaped byte is written even after half a character. The shell's
// ${x%?} still cuts a UTF-16 unit, not bash's whole character
// (verify/handoffs/ticket-lifo-utf16-pattern-units.md), and leaves a lone
// high surrogate. That half goes as what it encodes to alone; it does not
// pair with the byte to make another character.
{
  const { sql: hs, transactions: ht } = await hostSqlite();
  const half = await NimbusWorkspace.create({ sql: hs, transactions: ht, generation: 1 });
  try {
    const bytesOf = async (line) => (await half.exec(`${line} | od -An -tx1`, { cwd: '/home/user' })).stdout.trim().split(/\s+/);
    for (const [line, byte] of [['x=😀; echo -ne "${x%?}\\0377"', 'ff'], ['x=😀; printf "%s\\377" "${x%?}"', 'ff'], ['x=😀; printf "%s%c" "${x%?}" é', 'c3'], ['x=😀; printf "%s%b" "${x%?}" "\\303"', 'c3']]) {
      const got = await bytesOf(line);
      // The byte last and its own; no four-byte character (f0 ..) made of it and the half before it.
      assert.ok(got.at(-1) === byte && !got.includes('f0'), `${line}: ${got.join(' ')}`);
    }
  } finally {
    await half.close();
  }
}
console.log('printf-bytes-gnu: ok');
