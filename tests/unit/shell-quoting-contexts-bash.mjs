#!/usr/bin/env bun
// A word's quotedness is the lexer's, carried in its parts to every consumer:
// reserved words, assignments, for variables, function names, aliases, case
// and [[ ]] patterns, parameter patterns and default words, pathname, tilde
// and brace expansion, and here-document delimiters. A quoted character is
// never syntax or pattern, however it is quoted.
//
// Generated: each quoting form (bare, '...', "...", backslashes, $'...', a
// quoted first or last character) of each payload, in each context, run by
// the host's bash and by the session, each in a fresh directory holding
// a.txt and b.txt; stdout, exit status and stderr (bash's line prefix
// stripped) must agree. A line bash cannot parse must fail to parse in the
// session too: same stdout, status 2, a message.
//
// Red before: the parser read reserved words, assignments, for variables and
// function names from a word's text; aliases rebuilt the command line from
// its expanded arguments; case, [[ ]], parameter patterns and pathname
// expansion took a word's quoted characters as pattern; and a default word's
// quoted characters were split.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

/** The quoting forms of a payload. */
const FORMS = {
  bare: (s) => s,
  single: (s) => `'${s}'`,
  double: (s) => `"${s}"`,
  backslash: (s) => [...s].map((c) => `\\${c}`).join(''),
  ansiC: (s) => `$'${s}'`,
  headQuoted: (s) => (s.length > 1 ? `'${s[0]}'${s.slice(1)}` : null),
  tailQuoted: (s) => (s.length > 1 ? `${s.slice(0, -1)}"${s.at(-1)}"` : null),
};
const WHOLE = ['bare', 'single', 'double', 'backslash', 'ansiC'];

/** Contexts: a line with a hole `@` for the formed payload, the payloads, and the forms that fit. */
const CONTEXTS = [
  // Reserved words, as the command word and as terminators.
  ...['then', 'fi', 'do', 'done', 'esac', 'in', 'elif', 'else', '}', '!', ']]'].map((word) => ({ line: `@ true; echo "st=$?"`, payloads: [word] })),
  { line: `@ true; then echo T; fi; echo "st=$?"`, payloads: ['if'] },
  { line: `@ false; do :; done; echo "st=$?"`, payloads: ['while', 'until'] },
  { line: `@ x in a; do echo "[$x]"; done; echo "st=$?"`, payloads: ['for'] },
  { line: `@ a in a) echo A;; esac; echo "st=$?"`, payloads: ['case'] },
  { line: `@ echo G; }; echo "st=$?"`, payloads: ['{'] },
  { line: `@ -n x ]] && echo B; echo "st=$?"`, payloads: ['[['] },
  { line: `for x in a; do echo "$x"; @; done; echo "st=$?"`, payloads: ['done'] },
  { line: `if true; then echo a; @ 2>/dev/null; fi; echo "st=$?"`, payloads: ['fi', 'then'] },
  // Assignments: the name and the = unquoted; the value as quoted as it likes.
  { line: `@; printf '<%s>' "\${x-unset}"`, payloads: ['x=set'] },
  { line: `x@y; printf '<%s>' "\${x-unset}"`, payloads: ['='] },
  { line: `a[@]=v; printf '<%s>' "\${a[@]}" "\${!a[@]}"`, payloads: ['1'] },
  { line: `x=@; printf '<%s>' "\${x[@]}" "\${#x[@]}"`, payloads: ['(a b)'], forms: WHOLE },
  // A for variable and a function name are identifiers, not quoted words.
  { line: `for @ in one; do echo "[$v]"; done; echo "st=$?"`, payloads: ['v'] },
  { line: `@() { echo F; }; f; echo "st=$?"`, payloads: ['f'] },
  // Aliases: the command word, unquoted, as written; its arguments stay its words.
  { line: `alias p='printf <%s>'\n@ x; echo`, payloads: ['p'] },
  { line: `alias p='printf <%s>'\np @; echo`, payloads: ['a;echo injected', 'a b'], forms: ['single', 'double', 'backslash', 'ansiC'] },
  { line: `alias p='printf <%s>'\nc=p; $c x; echo "st=$?"`, payloads: [''], forms: ['bare'] },
  { line: `alias echo='echo X'\necho hi`, payloads: [''], forms: ['bare'] },
  { line: `alias p='printf <%s>'\np @ > out; cat out; echo`, payloads: ['x'] },
  // Patterns: a quoted character is itself.
  ...[['abc', '*'], ['abc', 'a*'], ['abc', 'a?c'], ['abc', '[ab]bc'], ['abc', 'abc'], ['*', '*'], ['a*', 'a*']].flatMap(([subject, pattern]) => [
    { line: `case '${subject}' in @) echo m;; *) echo n;; esac`, payloads: [pattern] },
    { line: `[[ '${subject}' == @ ]] && echo m || echo n; [[ '${subject}' != @ ]] && echo d || echo s`, payloads: [pattern] },
    { line: `v='${subject}'; printf '<%s>' "\${v#@}" "\${v##@}" "\${v%@}" "\${v/@/X}" "\${v//@/X}" "\${v^^@}" \${v#@}`, payloads: [pattern] },
  ]),
  { line: `[[ a.c =~ @ ]] && echo m || echo n; [[ abc =~ @ ]] && echo m || echo n`, payloads: ['a.c', '^a.'] },
  { line: `p='a*'; case abc in $p) echo m;; *) echo n;; esac; case abc in "$p") echo m;; *) echo n;; esac; [[ abc == $p ]] && echo m; [[ abc == "$p" ]] || echo n`, payloads: [''], forms: ['bare'] },
  // Default words: their quoted characters are neither split nor globbed.
  { line: `unset x; printf '<%s>' \${x:-@} "\${x:-@}" \${x-@}; echo`, payloads: ['a b', '*.txt', 'a'] },
  { line: `x=1; printf '<%s>' \${x:+@} "\${x:+@}"; echo`, payloads: ['a b', '*.txt'] },
  { line: `unset x; : \${x:=@}; printf '<%s>' "$x"; echo`, payloads: ['a b', '*'] },
  // Pathname expansion: quoted characters match themselves; an unquoted expansion's are pattern.
  { line: `printf '<%s>' @; echo`, payloads: ['*.txt', '?.txt', '[ab].txt', 'a.t*'] },
  ...['*.txt', 'a.*', '[ab]*', 'a\\*', 'x*'].map((value) => ({ line: `v='${value}'; printf '<%s>' $v "$v"; echo`, payloads: [''], forms: ['bare'] })),
  // Tilde and brace expansion: quoted, they are text.
  { line: `HOME=/h; printf '<%s>' @; x=@; printf '[%s]' "$x"; echo`, payloads: ['~', '~/x'] },
  { line: `printf '<%s>' @; echo`, payloads: ['{a,b}', 'x{a,b}y'] },
  // A here-document's delimiter, quoted anyhow, keeps its body literal.
  { line: `v=1; cat <<@\n$v\nEOF\necho end`, payloads: ['EOF'] },
];

/** Every case: its line, once per distinct text. */
const CASES = [...new Set(CONTEXTS.flatMap(({ line, payloads, forms = Object.keys(FORMS) }) => payloads.flatMap((payload) => forms.flatMap((form) => {
  const word = FORMS[form](payload);
  return word === null ? [] : [line.split('@').join(word)];
}))))];

const FILES = ['a.txt', 'b.txt'];
/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `. */
const plainStderr = (text) => text.replace(/^bash: (?:-c: )?(?:line \d+: )?/gm, '');

const bash = new Map();
for (const line of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-quoting-contexts-'));
  try {
    for (const file of FILES) writeFileSync(join(dir, file), '');
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    bash.set(line, { stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  let n = 0;
  for (const line of CASES) {
    const dir = `/home/user/q${n++}`;
    await ws.exec(`mkdir -p ${dir} && cd ${dir} && touch ${FILES.join(' ')}`, { cwd: '/home/user' });
    // A line the session does not finish in 10 s is a failure of its own (an alias expanding itself, say).
    process.stderr.write(`case ${n}: ${JSON.stringify(line)}\n`);
    let r;
    try {
      r = await ws.exec(line, { cwd: dir, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      failed.push(`${JSON.stringify(line)}\n  ours: did not finish (${error?.message})`);
      continue;
    }
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    const theirs = bash.get(line);
    const agrees = /syntax error/.test(theirs.stderr)
      ? ours.stdout === theirs.stdout && ours.status === theirs.status && ours.stderr !== ''
      : ours.stdout === theirs.stdout && ours.status === theirs.status && ours.stderr === theirs.stderr;
    if (!agrees) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(theirs)}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-quoting-contexts-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
