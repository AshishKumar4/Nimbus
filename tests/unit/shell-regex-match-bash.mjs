#!/usr/bin/env bun
// `[[ word =~ regex ]]`, as bash 5.2 reads and runs it: the regex is one
// word whose parentheses nest and whose `|` and blanks inside parentheses are
// its own; its quoted characters match only themselves and an unquoted
// expansion's are regex characters; it is a POSIX extended regular expression
// as glibc compiles it (one glibc refuses is status 2, of which bash 5.2 says
// nothing); and a match is leftmost, then longest, with BASH_REMATCH its text
// and each group's ("" for one that took no part; empty on no match). Before,
// lifo had no `=~` ("test: too many arguments"). Each line runs as a session's
// line and as host bash's `bash -c` under C.UTF-8. Host bash is the oracle
// (stdout, status, stderr without bash's line prefix; a syntax error's
// stdout and status alone).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  "[[ a.c =~ a.c ]] && echo m || echo n; [[ abc =~ 'a.c' ]] && echo m || echo n; [[ abc =~ a.c ]] && echo m || echo n",
  "x='a.c'; [[ abc =~ $x ]] && echo m; [[ abc =~ \"$x\" ]] || echo n",
  "[[ abc =~ b(c) ]] && echo \"${BASH_REMATCH[@]}\" ${#BASH_REMATCH[@]}",
  "[[ AbC =~ ^[[:upper:]][[:lower:]] ]] && echo cls; [[ abc =~ [[:alpha:]]+ ]] && echo \"${BASH_REMATCH[0]}\"",
  "[[ ab =~ ^(a)(x)?b$ ]]; printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo",
  "[[ ab =~ (a|ab)(c|bcd)? ]]; printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo; [[ ab =~ (a?)(ab)? ]]; printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo",
  "[[ \"a b\" =~ (a b) ]] && echo \"${BASH_REMATCH[0]}\"; [[ ab =~ a|x ]] && echo alt; [[ x =~ (a|x) ]] && echo \"${BASH_REMATCH[1]}\"",
  "[[ abc =~ ^a.c$ && 1 == 1 ]] && echo and; [[ ! abc =~ x ]] && echo not",
  "for r in '[' '[abc' 'a{' '*' '(b' 'a{x}' '[z-a]' '[[:foo:]]' 'a\\' '(*a)' '{1}' '[[:alpha:]-z]' 'a{3,1}' 'x{1' '^*'; do [[ x =~ $r ]]; echo \"$r $?\"; done",
  "for r in 'a)' '()' 'a**' 'a+?' 'a{,2}' '[]a]' '[^]a]' '[a-]' '[\\.]' 'a{2}{3}' '\\w+' '\\<a' 'a\\>' '(a)\\1' '\\{' 'a|' '|a' 'a$b' 'a^b' '\\`a' \"a\\\\'\"; do [[ 'aa]a.\\{' =~ $r ]]; echo \"$r $? ${BASH_REMATCH[0]-unset}\"; done",
  "[[ a =~ b ]]; printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo; [[ ab =~ (a) ]]; [[ ab =~ x ]]; printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo",
  "[[ é =~ ^.$ ]] && echo one; [[ 😀x =~ ^(.)x$ ]] && echo \"${BASH_REMATCH[1]}\"",
  "[[ $'a\\nb' =~ a.b ]] && echo dotnl; [[ $'a\\nb' =~ ^b ]] || echo noml",
  "[[ a+ =~ a\\+ ]] && echo m6; [[ \"a b\" =~ a\\ b ]] && echo m7; [[ foo.bar =~ \\. ]] && echo esc; [[ ab =~ \\w+ ]] || echo nw; [[ aa =~ (a)\\1 ]] || echo nbr",
  "[[ abc =~ \"a\"b ]] && echo m8; x=b; [[ abc =~ a${x}c ]] && echo m9; [[ ab =~ a{1}b ]] && echo m10",
  "[[ abc =~ ( b ) ]]; echo st=$?; [[ 'a b c' =~ ( b ) ]] && echo \"[${BASH_REMATCH[0]}]\"",
  "[[ xyz =~ y|yz ]] && echo \"${BASH_REMATCH[0]}\"; [[ aabb =~ (a*)(ab)?b ]] && printf \"<%s>\" \"${#BASH_REMATCH[@]}\" \"${BASH_REMATCH[@]}\"; echo",
  "[[ a-b =~ [a-]+ ]] && echo \"${BASH_REMATCH[0]}\"; [[ 'x]y' =~ []x]+ ]] && echo \"${BASH_REMATCH[0]}\"; [[ 'a\\b' =~ [\\]b ]] && echo \"${BASH_REMATCH[0]}\"",
  "r='([0-9]+)\\.([0-9]+)'; [[ v12.34 =~ $r ]] && echo \"${BASH_REMATCH[1]} ${BASH_REMATCH[2]}\"; [[ ab =~ \"(\" ]] || echo q",
  "[[ AB =~ [[:lower:]] ]] || echo nolower; [[ ' ' =~ [[:space:]] ]] && echo sp; [[ 9 =~ ^[[:digit:][:alpha:]]$ ]] && echo dg; [[ - =~ [[:punct:]] ]] && echo pu",
  "[[ =~ ]]; echo $?; [[ -n =~ ]]; echo $?; [[ a == =~ ]]; echo $?; [[ =~ == =~ ]]; echo $?",
  "[[ (a =~ a) ]]; echo $?; [[ (a =~ b) ]]; echo $?; [[ ! (a =~ b) && (b =~ ^b$) ]]; echo $?",
  "[[ '#a' =~ (#a) ]]; echo $?; [[ 'a\tb' =~ (a\tb) ]]; echo $?; [[ 'a b' =~ (a\tb) ]]; echo $?",
  "r='(a)\\10'; [[ aa0 =~ $r ]]; echo $?; r='[a-b-c]'; [[ a =~ $r ]]; echo $?; r='(a\\1)'; [[ a =~ $r ]]; echo $?",
  "b=$'\\xff'; [[ $b =~ . ]]; echo $?; [[ $b =~ [^a] ]]; echo $?; [[ $b =~ $b ]]; echo $?",
  "BASH_REMATCH=(old); readonly BASH_REMATCH; [[ ab =~ (a) && b =~ x ]]; printf '%s <%s>\\n' \"$?\" \"${BASH_REMATCH[0]}\"",
  "[[ ab =~ (\\\na)b ]]; echo $?; [[ xyz =~ (y|yz)z? ]] && echo \"${BASH_REMATCH[0]}\"; [[ aa =~ a+? ]] && echo \"${BASH_REMATCH[0]}\"",
  "for r in '((a)\\2)' '((a)\\1)' '(a)(b\\2)' '(a(b)\\2)' '(a)|\\1' '(a)(b|\\1)' '(a|b)\\1' '((a)|b)\\2' '\\b*' '$*' '\\<*' '\\`*' '(^)*' 'a|*'; do [[ aab =~ $r ]]; echo \"$r $? ${BASH_REMATCH[0]-unset}\"; done",
  "for r in '[A-[.Z.]]' '[[.A.]-Z]' '[[.ab.]]' '[[=a=]-z]' '[a-[=c=]]' '[[.é.]]' '[[=é=]]' '[é-ë]' '[a-é]' '[é-]' '[[.-.]-z]' '[a-[.-.]]' '[[.].]]' '[[=a=]]' '[a-c-e]' '[%--]' '[a-b--c]' '[a-b[.-.]c]' '[a-b[.-.]-c]' '[--a-b]' '[a-b-]'; do [[ 'B-é]a' =~ $r ]]; echo \"$r $? ${BASH_REMATCH[0]-unset}\"; done",
  "[[ \"]]a\" =~ ]]a ]]; echo $?; [[ \"]]\" =~ \"]]\" ]]; echo $?",
  // A syntax error ends bash's -c text: its stdout and status alone, bash's message quoting the line.
  { line: "[[ \"]]\" =~ ]] ]]; echo $?", compare: "out" },
  { line: "[[ x =~ ]]", compare: "out" },
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `. */
const plainStderr = (text) => text.replace(/^bash: (?:-c: )?(?:line \d+: )?/gm, '');

const LINES = CASES.map((c) => (typeof c === 'string' ? { line: c, compare: 'all' } : c));
const compared = (result, compare) => (compare === 'out' ? { stdout: result.stdout, status: result.status } : result);

const want = [];
for (const { line, compare } of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-regex-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push(compared({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status }, compare));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [i, { line, compare }] of LINES.entries()) {
    const r = await ws.exec(line, { cwd: '/home/user' });
    const ours = compared({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode }, compare);
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-regex-match-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
