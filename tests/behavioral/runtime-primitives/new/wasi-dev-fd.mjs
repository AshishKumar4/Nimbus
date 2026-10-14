// A WASI program opens /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/N and
// /proc/self/fd/N as its own descriptors, as on Linux: installed CPython on the
// shared WASI layer, and installed bash with its commands (process substitution).
import { mintSession, deleteSession, Terminal, makeAsserter } from '../../_driver.mjs';
import { terminalCommandRunner } from '../../../unit/lib/workerd-probe.mjs';
if (!process.env.BASE) throw new Error('BASE is required');
const a = makeAsserter('wasi-dev-fd');
const sid = await mintSession(), terminal = new Terminal(sid);
try {
  await terminal.connect(); await terminal.waitForPrompt(60_000);
  const run = terminalCommandRunner(terminal);
  const python = await run('nimbus install python', 900_000);
  a.check('Python runtime installed', python.status === 0, python.stdout.slice(-300));
  const bash = await run('nimbus install bash', 240_000);
  a.check('bash runtime installed', bash.status === 0, bash.stdout.slice(-300));
  const cases = [
    // Controls: the same stdin, read as the program's own fd 0.
    ["printf 'control\\n' | python3 -c \"import sys; print(sys.stdin.read().strip())\"", /^control$/m],
    ["printf 'control\\n' | bash -c 'read -r x; echo \"got $x\"'", /^got control$/m],
    ["printf 'piped\\n' | python3 -c \"print(open('/dev/stdin').read().strip())\"", /^piped$/m],
    ["printf 'numbered\\n' | python3 -c \"print(open('/dev/fd/0').read().strip())\"", /^numbered$/m],
    ["python3 -c \"open('/dev/stderr', 'w').write('to-stderr\\\\n')\" 2>&1", /^to-stderr$/m],
    ["bash -c 'source <(echo \"echo sourced\")'", /^sourced$/m],
    ["bash -c 'while read -r l; do echo \"[$l]\"; done < <(printf \"a\\nb\\n\")'", /^\[a\]\r?\n\[b\]$/m],
    ["printf 'into-bash\\n' | bash -c 'read -r x < /dev/stdin; echo \"got $x\"'", /^got into-bash$/m],
    ["bash -c 'diff <(echo same) <(echo same) && echo identical'", /^identical$/m],
  ];
  for (const [command, expected] of cases) {
    const result = await run(command, 120_000);
    a.check(command, result.status === 0 && expected.test(result.stdout), JSON.stringify(result).slice(-600));
  }
} finally {
  await terminal.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, cleanup.body.slice(-300));
}
const { fail } = a.summary(); process.exit(fail ? 1 : 0);
