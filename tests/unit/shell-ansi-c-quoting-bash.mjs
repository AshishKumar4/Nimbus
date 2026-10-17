#!/usr/bin/env bun
// $'...' is ANSI-C quoting, as bash reads it: one quoted part of a word,
// whose escapes are decoded and nothing else is expanded. Checked against the
// host's bash over the same lines, byte for byte (od):
//
//   - \a \b \e \E \f \n \r \t \v \\ \' \" \? are their characters; \nnn (one
//     to three octal digits) and \xHH (one or two hex digits) are one byte
//     each, so $'\303\251' is "é"; \uHHHH and \UHHHHHHHH are characters;
//     \cX is the control character of X (\c? is DEL); any other backslash
//     stays; a NUL ends the quoted part;
//   - it joins the word around it (a$'\t'b, $'' an empty word), expands no
//     parameter, substitution, glob or brace inside, and keeps a
//     backslash-newline;
//   - inside double quotes, and in a here-document's body, it is literal
//     text; inside $(...) it is skipped whole, so a ) or " inside it does not
//     end the substitution; a parameter's default word reads it.
//
// Red before: the lexer had no $'...': `$` stayed, and the single-quoted body
// was taken literally, so `\'` ended the quote and misread the line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuationState } from '../../packages/core/src/substrate/lifo/shell/lexer.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const HEX = ' | od -An -tx1';
const show = (words) => `printf '<%s>' ${words}${HEX}`;
const CASES = [
  show(String.raw`$'\303\251' $'\xC3\xA9' $'\357\273\277t'`),
  show(String.raw`$'\u00e9' $'\U0001F600' $'\uFEFF' $'\u0041' $'\u00414' $'\u'`),
  show(String.raw`$'\cA' $'\ca' $'\c?' $'\c[' $'\c1' $'\c\\q' $'\cAx'`),
  show(String.raw`$'\a\b\e\E\f\n\r\t\v\\\'\"\?'`),
  show(String.raw`$'\1' $'\12' $'\101' $'\1014' $'\777' $'\x' $'\x4' $'\x41' $'\x414' $'\377'`),
  show(String.raw`$'\q' $'\c' $'a\%b' $'\8'`),
  show(String.raw`a$'\0tail'b $'a\x00tail'z $'a\u0000tail'z $'a\c@tail'z $'a\400tail'z`),
  show(String.raw`a$'\t'b $'' x$'\n'y $'a'"b"'c'$'d'`),
  show("$'$HOME ${x} $(echo bad) `bad` * [x] {a,b} ~'"),
  show(String.raw`"$'\t'" "a$'\303\251'b" "$'"`),
  `printf '<%s>' $'a\\\nb'${HEX}`,
  show(String.raw`"$(printf '%s' $'\') }\n')"`),
  show(String.raw`"$(printf "%s" "$(printf '%s' $'") }\n')")"`),
  show(String.raw`$(echo $'x\'y')`),
  String.raw`unset x; printf '<%s>' $` + String.raw`{x:-a$'\t'b} "$` + String.raw`{x:-$'\nZ'}" $` + String.raw`{x:-$'\'}'}` + HEX,
  String.raw`x=$'a\tb'; [[ $x == a$'\t'b ]] && echo tab; [[ '*' == $'\052' ]] && echo literal; case abc in $'*') echo wrong;; *) echo nonglob;; esac`,
  `cat <<EOF${HEX}\n$'\\t' "$'x'"\nEOF`,
  String.raw`f() { printf '<%s>' "$@"; }; f $'one two' $'three'; echo` + HEX,
];

// A line of its own for the status, so a here-document's delimiter ends its line.
const run = (line) => `${line}\necho "status=$?"`;
const dir = mkdtempSync(join(tmpdir(), 'shell-ansi-c-quoting-bash-'));
const bash = {};
try {
  for (const line of CASES) {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    bash[line] = { stdout: r.stdout, stderr: r.stderr };
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
      assert.deepEqual(ours, bash[line]);
      console.log(`  ✓ ${line.slice(0, 80)}`);
    } catch {
      failed.push(`${line}\n  bash: ${JSON.stringify(bash[line])}\n  ours: ${JSON.stringify(ours)}`);
      console.log(`  ✗ ${line.slice(0, 80)}`);
    }
  }
} finally {
  await ws.close();
}

// The interactive shell keeps reading (PS2) inside an unclosed $'...', as bash does.
const continued = {
  unclosed: continuationState(String.raw`echo $'a\'`),
  closed: continuationState(String.raw`echo $'a\''`),
  backslashAtEnd: continuationState("echo $'a\\"),
  closedThenOpen: continuationState(String.raw`echo $'a' 'b`),
};
assert.deepEqual(continued, { unclosed: 'single', closed: null, backslashAtEnd: 'single', closedThenOpen: 'single' });
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
console.log(`shell-ansi-c-quoting-bash: ${CASES.length} lines as bash's`);
