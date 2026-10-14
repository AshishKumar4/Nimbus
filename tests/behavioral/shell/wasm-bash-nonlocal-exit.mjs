#!/usr/bin/env bun
// shell/wasm-bash-nonlocal-exit — exit statuses survive the installed GNU
// bash runtime's Asyncify setjmp/longjmp path, not merely the JS shell.
import { deleteSession, hasOutputLine, makeAsserter, mintSession, Terminal, termBody } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'shell/wasm-bash-nonlocal-exit';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const cases = [
  ['direct exit', 'exit 7', 7],
  ['exit inside eval', "eval 'exit 7'", 7],
  ['exit inside a function', 'f(){ exit 5; }; f', 5],
  ['exit inside a subshell', '(exit 6)', 6],
  ['exit inside the EXIT trap', 'trap "exit 4" EXIT; true', 4],
  ['exit inside source with process substitution', 'source <(echo "exit 3")', 3],
  ['exit inside a sourced file', 'printf "exit 3\\n" > /home/user/nonlocal-exit.sh; source /home/user/nonlocal-exit.sh', 3],
  ['exit inside nested eval', 'eval "eval \\"exit 9\\""', 9],
  ['exit inside eval inside a function', "f(){ eval 'exit 8'; }; f", 8],
  ['errexit inside eval', "set -e; eval 'false'; printf 'UNREACHABLE\\n'", 1],
  ['return inside eval', "f(){ eval 'return 12'; printf 'UNREACHABLE\\n'; }; f", 12],
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const installed = await t.run('nimbus install bash', 240_000);
  console.log(`INSTALL_RECEIPT ${JSON.stringify({ exitCode: installed.exitCode, output: termBody(installed.output) })}`);
  a.check('bash runtime installed', installed.exitCode === 0, termBody(installed.output));
  const version = await t.run('bash --version', 60_000);
  const body = termBody(version.output);
  a.check('installed runtime is GNU bash wasm32 WASI',
    /GNU bash, version 5\.2\.37/.test(body) && /wasm32-unknown-wasi/.test(body), body);
  if (!/GNU bash, version 5\.2\.37/.test(body) || !/wasm32-unknown-wasi/.test(body)) {
    throw new Error('installed GNU WASI bash did not take over; the class map would test the wrong shell');
  }

  for (const [name, script, expected] of cases) {
    const command = `bash -c ${quote(script)}; printf 'NONLOCAL_STATUS=%s\\n' "$?"`;
    const result = await t.run(command, 90_000);
    const output = termBody(result.output);
    console.log(`CLASS_RECEIPT ${JSON.stringify({ name, script, expected, output, elapsed: result.elapsed })}`);
    a.check(`${name}: status ${expected}`, hasOutputLine(output, `NONLOCAL_STATUS=${expected}`), output);
    a.check(`${name}: no execution after the non-local transfer`, !hasOutputLine(output, 'UNREACHABLE'), output);
  }

  // How deep a bash function recursion goes, each level returning through the
  // return_catch its caller saved: a receipt of where this host's limit is
  // (its native stack, or the runner's capture cap), and that every depth up
  // to it lands right.
  const recurse = 'f(){ if [ "$1" -gt 0 ]; then f $(( $1 - 1 )); return $?; fi; return 0; }';
  for (const depth of [8, 12, 16, 24, 32, 48, 64]) {
    const result = await t.run(`bash -c ${quote(`${recurse}; f ${depth}; echo "depth ${depth} ok"`)}; printf 'DEPTH_STATUS=%s\\n' "$?"`, 120_000);
    const output = termBody(result.output);
    console.log(`DEPTH_RECEIPT ${JSON.stringify({ depth, output: output.slice(-400) })}`);
    if (depth <= 12) a.check(`recursion ${depth} deep returns through every level`, hasOutputLine(output, `depth ${depth} ok`), output);
    if (!hasOutputLine(output, `depth ${depth} ok`)) break;
  }

  const quoted = await t.run(
    `bash -c ${quote("for x in $'\\u0378' $'\\uFDD0' $'\\uFFFF' $'\\U0001FFFF'; do declare -p x; printf '%q\\n' \"$x\"; done")}`,
    60_000,
  );
  console.log(`PRINTABILITY_RECEIPT ${JSON.stringify({ output: termBody(quoted.output), exitCode: quoted.exitCode })}`);
  a.check('Unicode printability probe completed', quoted.exitCode === 0, termBody(quoted.output));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  console.log(`CLEANUP_RECEIPT ${JSON.stringify(cleanup)}`);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body)}`);
}

const summary = a.summary();
process.exit(summary.fail ? 1 : 0);
