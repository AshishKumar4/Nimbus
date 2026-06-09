#!/usr/bin/env bun
// shell/sh-bash-entrypoints — sh/bash are real user-facing shell commands.
//
// Public contract:
//   - sh -c and bash -lc execute through the Nimbus shell engine.
//   - Absolute virtual shell paths work for child_process and scripts.
//   - Piped installer-style scripts execute through stdin.
//   - Script files run with VFS-backed path resolution.

import { deleteSession, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'shell/sh-bash-entrypoints';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

{
  const { output } = await t.run('sh -c "echo SH_OK && pwd"', 20_000);
  const stripped = stripAnsi(output);
  a.check('sh -c executes commands',
    hasOutputLine(stripped, 'SH_OK') && hasOutputLine(stripped, '/home/user'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('sh -c \'echo "$0|$1|$2|$#|$@"\' runner alpha beta', 20_000);
  const stripped = stripAnsi(output);
  a.check('sh -c sets POSIX positional parameters',
    hasOutputLine(stripped, 'runner|alpha|beta|2|alpha beta'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('/bin/sh -lc "echo ABS_SH_OK"', 20_000);
  const stripped = stripAnsi(output);
  a.check('/bin/sh -lc executes commands',
    hasOutputLine(stripped, 'ABS_SH_OK'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('sh -o pipefail -c "echo OPTION_SH_OK"', 20_000);
  const stripped = stripAnsi(output);
  a.check('sh accepts standard mode options before -c',
    hasOutputLine(stripped, 'OPTION_SH_OK'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('bash -lc "echo BASH_OK"', 20_000);
  const stripped = stripAnsi(output);
  a.check('bash -lc executes commands',
    hasOutputLine(stripped, 'BASH_OK'),
    JSON.stringify(stripped.slice(-500)));
}

await t.run(heredocCommand('/home/user/install.sh', [
  'echo SCRIPT_FILE_OK',
  'echo "$0|$1|$#|$@"',
  'mkdir -p /home/user/sh-probe',
  'echo installed > /home/user/sh-probe/result.txt',
].join('\n')), 10_000);

{
  const { output } = await t.run('sh /home/user/install.sh --prefix /home/user/.local && cat /home/user/sh-probe/result.txt', 30_000);
  const stripped = stripAnsi(output);
  a.check('sh executes VFS script files',
    hasOutputLine(stripped, 'SCRIPT_FILE_OK') && hasOutputLine(stripped, 'installed'),
    JSON.stringify(stripped.slice(-800)));
  a.check('sh script files set POSIX positional parameters',
    hasOutputLine(stripped, '/home/user/install.sh|--prefix|2|--prefix /home/user/.local'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('printf "echo PIPE_SH_OK\\n" | sh', 20_000);
  const stripped = stripAnsi(output);
  a.check('piped script executes through sh stdin',
    hasOutputLine(stripped, 'PIPE_SH_OK'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const script = 'if [[ abc == a* && 2 -gt 1 ]]; then echo DOUBLE_BRACKET_OK; fi\\n';
  const { output } = await t.run(`printf ${JSON.stringify(script)} | bash`, 20_000);
  const stripped = stripAnsi(output);
  a.check('bash stdin scripts keep double-bracket operators inside the test expression',
    hasOutputLine(stripped, 'DOUBLE_BRACKET_OK') && !/Expected Word|command not found/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const script = 'if [[ "x" == "]]" ]]; then echo BAD; else echo QUOTED_DELIM_OK; fi\\n';
  const { output } = await t.run(`printf ${JSON.stringify(script)} | bash`, 20_000);
  const stripped = stripAnsi(output);
  a.check('quoted ]] is not a double-bracket delimiter',
    hasOutputLine(stripped, 'QUOTED_DELIM_OK') && !/too many arguments|command not found/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run(
    'cat <<\'NIMBUS_TEST\' | bash\npat="f*"; if [[ foo == "$pat" ]]; then echo BAD; else echo QUOTED_PATTERN_OK; fi\npat="f*"; if [[ foo == $pat ]]; then echo UNQUOTED_PATTERN_OK; fi\nNIMBUS_TEST',
    20_000,
  );
  const stripped = stripAnsi(output);
  a.check('double-bracket patterns preserve quotedness',
    hasOutputLine(stripped, 'QUOTED_PATTERN_OK') && hasOutputLine(stripped, 'UNQUOTED_PATTERN_OK') && !hasOutputLine(stripped, 'BAD'),
    JSON.stringify(stripped.slice(-1000)));
}

{
  const script = 'exit 7\\necho SHOULD_NOT_RUN\\n';
  const { output } = await t.run(`printf ${JSON.stringify(script)} | bash; echo STATUS=$?`, 20_000);
  const stripped = stripAnsi(output);
  a.check('exit terminates stdin scripts with the requested status',
    hasOutputLine(stripped, 'STATUS=7') && !hasOutputLine(stripped, 'SHOULD_NOT_RUN'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('exit 3 | cat; echo PIPELINE_AFTER=$?', 20_000);
  const stripped = stripAnsi(output);
  a.check('exit in a pipeline segment stays local to that segment',
    hasOutputLine(stripped, 'PIPELINE_AFTER=0'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('( exit 7 ); echo SUBSHELL_STATUS=$?', 20_000);
  const stripped = stripAnsi(output);
  a.check('exit inside a subshell does not terminate the parent shell',
    hasOutputLine(stripped, 'SUBSHELL_STATUS=7'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('cat <<\'NIMBUS_TEST\' | sed \'s/b/\\&/\'\nabc\nNIMBUS_TEST\ncat <<\'NIMBUS_TEST\' | sed \'s/a/$1/\'\nabc\nNIMBUS_TEST', 20_000);
  const stripped = stripAnsi(output);
  a.check('sed replacements preserve escaped ampersands and literal dollars',
    hasOutputLine(stripped, 'a&c') && hasOutputLine(stripped, '$1bc'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('printf "echo DASH_STDIN_OK\\n" | sh -', 20_000);
  const stripped = stripAnsi(output);
  a.check('sh - executes stdin scripts',
    hasOutputLine(stripped, 'DASH_STDIN_OK'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const script = 'echo "$0|$1|$2|$#|$@"\\n';
  const { output } = await t.run(`printf '${script}' | sh -s -- alpha beta`, 20_000);
  const stripped = stripAnsi(output);
  a.check('sh -s forwards stdin positional parameters',
    hasOutputLine(stripped, 'sh|alpha|beta|2|alpha beta'),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('printf \'echo "PID=$$"\\n\' | sh', 20_000);
  const stripped = stripAnsi(output).replace(/\r/g, '\n');
  a.check('stdin scripts expand $$ through the same shell feature path',
    /(^|\n)PID=\d+(\n|$)/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('printf "echo SHOULD_NOT_RUN\\n" | sh --unknown', 20_000);
  const stripped = stripAnsi(output);
  a.check('invalid sh options do not execute piped stdin',
    /unsupported option: --unknown/.test(stripped) && !hasOutputLine(stripped, 'SHOULD_NOT_RUN'),
    JSON.stringify(stripped.slice(-800)));
}

{
  const script = 'command -v node >/dev/null 2>&1 && echo FD_REDIRECT_OK\\n';
  const { output } = await t.run(`printf ${JSON.stringify(script)} | sh`, 20_000);
  const stripped = stripAnsi(output);
  a.check('sh stdin scripts accept fd-to-fd redirects',
    hasOutputLine(stripped, 'FD_REDIRECT_OK') && !/Expected Word/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const script = "# npm's comment\\nif command -v node >/dev/null 2>&1; then echo COMMENT_FD_REDIRECT_OK; fi\\n";
  const { output } = await t.run(`printf ${JSON.stringify(script)} | sh`, 20_000);
  const stripped = stripAnsi(output);
  a.check('sh stdin scripts accept fd redirects after apostrophe comments',
    hasOutputLine(stripped, 'COMMENT_FD_REDIRECT_OK') && !/Expected Word/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const script = 'echo WAIT_OK > /tmp/wait-ok.txt &\\nwait\\ncat /tmp/wait-ok.txt\\n';
  const { output } = await t.run(`printf ${JSON.stringify(script)} | sh`, 20_000);
  const stripped = stripAnsi(output);
  a.check('sh stdin scripts share the wait builtin',
    hasOutputLine(stripped, 'WAIT_OK') && !/wait: command not found/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);

function hasOutputLine(output, expected) {
  return output
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .includes(expected);
}
