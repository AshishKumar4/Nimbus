#!/usr/bin/env bun
// shell/installer-primitives — primitives used by curl-to-sh installers.

import { deleteSession, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'shell/installer-primitives';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await writeScript('/tmp/set-e.sh', [
    'set -e',
    'false',
    'echo SET_E_SHOULD_NOT_PRINT',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/set-e.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('set -e stops script after a failing command',
      !hasLine(body, 'SET_E_SHOULD_NOT_PRINT') && hasLine(body, 'STATUS=1'),
      JSON.stringify(tail(body)));
  }

  {
    const { output } = await t.run("sh -e -c 'false; echo SH_E_SHOULD_NOT_PRINT'; echo STATUS=$?", 20_000);
    const body = normalized(output);
    a.check('sh -e invocation option enables errexit',
      !hasLine(body, 'SH_E_SHOULD_NOT_PRINT') && hasLine(body, 'STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/set-u.sh', [
    'set -u',
    'echo "$NIMBUS_MISSING_VAR"',
    'echo SET_U_SHOULD_NOT_PRINT',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/set-u.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('set -u fails on unbound variables',
      /NIMBUS_MISSING_VAR: unbound variable/.test(body)
        && !hasLine(body, 'SET_U_SHOULD_NOT_PRINT')
        && /(^|\n)STATUS=[1-9]\d*(\n|$)/.test(body),
      JSON.stringify(tail(body)));
  }

  {
    const { output } = await t.run("sh -u -c 'echo \"$NIMBUS_MISSING_INVOCATION_VAR\"; echo SH_U_SHOULD_NOT_PRINT'; echo STATUS=$?", 20_000);
    const body = normalized(output);
    a.check('sh -u invocation option enables nounset',
      /NIMBUS_MISSING_INVOCATION_VAR: unbound variable/.test(body)
        && !hasLine(body, 'SH_U_SHOULD_NOT_PRINT')
        && /(^|\n)STATUS=[1-9]\d*(\n|$)/.test(body),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/set-positionals.sh', [
    'set -- alpha beta',
    'echo "$1|$2|$#|$@"',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/set-positionals.sh', 20_000);
    const body = normalized(output);
    a.check('set -- resets positional parameters',
      hasLine(body, 'alpha|beta|2|alpha beta'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/shift-positionals.sh', [
    'set -- alpha beta gamma',
    'shift',
    'echo "S1=$1|$#|$@"',
    'shift 2',
    'echo "S2=$#"',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/shift-positionals.sh', 20_000);
    const body = normalized(output);
    a.check('shift updates positional parameters',
      hasLine(body, 'S1=beta|2|beta gamma')
        && hasLine(body, 'S2=0'),
      JSON.stringify(tail(body)));
  }
  {
    const { output } = await t.run("sh -c 'set --; shift 1'; echo SHIFT_STATUS=$?", 20_000);
    const body = normalized(output);
    a.check('shift rejects out-of-range counts',
      hasLine(body, 'SHIFT_STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/function-positionals-frame.sh', [
    'with_arg() {',
    '  sleep 0.05',
    '  echo "ARG=$1"',
    '}',
    'without_arg() {',
    '  sleep 0.1',
    '}',
    'with_arg expected &',
    'arg_pid=$!',
    'without_arg &',
    'wait "$arg_pid"',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/function-positionals-frame.sh', 20_000);
    const body = normalized(output);
    a.check('background function positionals are isolated per invocation',
      hasLine(body, 'ARG=expected'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/positional-frame-forks.sh', [
    'background_case() {',
    '  set -- parent',
    '  { set -- background; } &',
    '  wait',
    '  echo "BG_PARENT=$1"',
    '}',
    'pipeline_case() {',
    '  set -- parent',
    '  echo item | { read value; set -- pipeline; }',
    '  echo "PIPE_PARENT=$1"',
    '}',
    'capture_case() {',
    '  set -- parent',
    '  output=$(set -- capture; echo captured)',
    '  echo "CAPTURE_PARENT=$1|$output"',
    '}',
    'subshell_case() {',
    '  set -- parent',
    '  (set -- subshell)',
    '  echo "SUBSHELL_PARENT=$1"',
    '}',
    'background_case',
    'pipeline_case',
    'capture_case',
    'subshell_case',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/positional-frame-forks.sh', 20_000);
    const body = normalized(output);
    a.check('fork-like execution boundaries do not mutate caller positionals',
      hasLine(body, 'BG_PARENT=parent')
        && hasLine(body, 'PIPE_PARENT=parent')
        && hasLine(body, 'CAPTURE_PARENT=parent|captured')
        && hasLine(body, 'SUBSHELL_PARENT=parent'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/source-positionals-noargs.sh', 'set -- sourced');
  await writeScript('/tmp/source-positionals-args.sh', [
    'echo "SOURCE_ARGS=$1|$2"',
    'set -- changed',
  ].join('\n'));
  await writeScript('/tmp/source-positionals.sh', [
    'source_noargs_case() {',
    '  set -- parent',
    '  . /tmp/source-positionals-noargs.sh',
    '  echo "SOURCE_NOARGS_AFTER=$1"',
    '}',
    'source_args_case() {',
    '  set -- parent',
    '  . /tmp/source-positionals-args.sh alpha beta',
    '  echo "SOURCE_ARGS_AFTER=$1"',
    '}',
    'source_noargs_case',
    'source_args_case',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/source-positionals.sh', 20_000);
    const body = normalized(output);
    a.check('source preserves caller positionals and supports temporary source arguments',
      hasLine(body, 'SOURCE_NOARGS_AFTER=sourced')
        && hasLine(body, 'SOURCE_ARGS=alpha|beta')
        && hasLine(body, 'SOURCE_ARGS_AFTER=parent'),
      JSON.stringify(tail(body)));
  }

  {
    const { output } = await t.run("sh -o pipefail -c 'false | true; echo PIPE_INVOCATION_STATUS=$?'", 20_000);
    const body = normalized(output);
    a.check('sh -o pipefail invocation option reports the failing pipeline command',
      hasLine(body, 'PIPE_INVOCATION_STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/pipefail.sh', [
    'set -o pipefail',
    'false | true',
    'echo "PIPE_STATUS=$?"',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/pipefail.sh', 20_000);
    const body = normalized(output);
    a.check('set -o pipefail reports the failing pipeline command',
      hasLine(body, 'PIPE_STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/set-euo-pipefail.sh', [
    'set -euo pipefail',
    'false | true',
    'echo SET_EUO_PIPEFAIL_SHOULD_NOT_PRINT',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/set-euo-pipefail.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('set -euo pipefail enables errexit, nounset, and pipefail together',
      !hasLine(body, 'SET_EUO_PIPEFAIL_SHOULD_NOT_PRINT') && hasLine(body, 'STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/set-invalid.sh', [
    'set -z',
    'echo SET_INVALID_SHOULD_NOT_PRINT',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/set-invalid.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('set rejects unsupported option flags',
      /set: -z: invalid option/.test(body)
        && !hasLine(body, 'SET_INVALID_SHOULD_NOT_PRINT')
        && hasLine(body, 'STATUS=2'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/readonly.sh', [
    'readonly NIMBUS_RO=alpha',
    'NIMBUS_RO=beta',
    'echo READONLY_SHOULD_NOT_PRINT',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/readonly.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('readonly variables cannot be reassigned',
      /NIMBUS_RO: readonly variable/.test(body)
        && !hasLine(body, 'READONLY_SHOULD_NOT_PRINT')
        && hasLine(body, 'STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/trap-exit.sh', [
    'trap \'echo "TRAP_STATUS=$?"\' EXIT',
    'false',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/trap-exit.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('trap EXIT runs at shell script exit with the script status',
      hasLine(body, 'TRAP_STATUS=1') && hasLine(body, 'STATUS=1'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/background-pid.sh', [
    'sleep 30 &',
    'pid=$!',
    'kill "$pid"',
    'wait "$pid" 2>/dev/null || echo WAIT_KILLED=$?',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/background-pid.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('$! is a waitable and killable process id',
      /(^|\n)WAIT_KILLED=[1-9]\d*(\n|$)/.test(body) && hasLine(body, 'STATUS=0'),
      JSON.stringify(tail(body)));
  }

  {
    const { output } = await t.run('[ -t 1 ] && echo INTERACTIVE_STDOUT_TTY || echo INTERACTIVE_STDOUT_NOT_TTY', 20_000);
    const body = normalized(output);
    a.check('interactive shell reports stdout as a terminal',
      hasLine(body, 'INTERACTIVE_STDOUT_TTY'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/nested-arithmetic.sh', [
    'step=7',
    'width=28',
    'trail=8',
    'head=$((step % (width + trail)))',
    'echo "HEAD=$head"',
  ].join('\n'));
  {
    const { output } = await t.run('sh /tmp/nested-arithmetic.sh; echo STATUS=$?', 20_000);
    const body = normalized(output);
    a.check('nested arithmetic expansion parses in installer-style scripts',
      hasLine(body, 'HEAD=7') && hasLine(body, 'STATUS=0'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/tty-probe.sh', [
    '[ -t 0 ] && echo STDIN_TTY || echo STDIN_NOT_TTY',
    '[ -t 1 ] && echo STDOUT_TTY || echo STDOUT_NOT_TTY',
    'if (: <>/dev/tty) 2>/dev/null; then echo HAS_DEV_TTY; else echo NO_DEV_TTY; fi',
  ].join('\n'));
  {
    const { output } = await t.run('cat /tmp/tty-probe.sh | sh', 20_000);
    const body = normalized(output);
    a.check('piped sh stdin is not a terminal',
      hasLine(body, 'STDIN_NOT_TTY') && !hasLine(body, 'STDIN_TTY'),
      JSON.stringify(tail(body)));
    a.check('piped sh keeps stdout terminal metadata',
      hasLine(body, 'STDOUT_TTY') && !hasLine(body, 'STDOUT_NOT_TTY'),
      JSON.stringify(tail(body)));
    a.check('piped sh keeps a controlling /dev/tty separate from fd 0',
      hasLine(body, 'HAS_DEV_TTY') && !hasLine(body, 'NO_DEV_TTY'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/history-heredoc.txt', 'literal=!!key.ctrl');
  {
    const { output } = await t.run('cat /tmp/history-heredoc.txt', 20_000);
    const body = normalized(output);
    a.check('history expansion does not rewrite heredoc bodies',
      hasLine(body, 'literal=!!key.ctrl'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/tty-read.sh', [
    'old_tty_state=$(stty -g < /dev/tty)',
    'stty -icanon -echo min 1 time 0 < /dev/tty',
    'printf "ASK>" > /dev/tty',
    'key=$(dd bs=1 count=1 status=none < /dev/tty)',
    'stty "$old_tty_state" < /dev/tty',
    'printf "\\nKEY=%s\\n" "$key"',
  ].join('\n'));
  {
    t.reset();
    t.cmd('cat /tmp/tty-read.sh | sh; echo STATUS=$?');
    await t.waitFor((body) => body.includes('ASK>'), 20_000, 'interactive /dev/tty prompt');
    t.send('y');
    await t.waitForNewPrompt(20_000);
    const body = normalized(t.buf);
    a.check('piped sh can read one key from /dev/tty through stty and dd',
      hasLine(body, 'KEY=y') && hasLine(body, 'STATUS=0'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/tty-read-line.sh', [
    'read -r -p "LINE?>" answer < /dev/tty',
    'printf "ANSWER=%s\\n" "$answer"',
  ].join('\n'));
  {
    t.reset();
    t.cmd('cat /tmp/tty-read-line.sh | sh; echo STATUS=$?');
    await t.waitFor((body) => body.includes('LINE?>'), 20_000, 'read prompt from /dev/tty');
    t.send('nimbus\r');
    await t.waitForNewPrompt(20_000);
    const body = normalized(t.buf);
    a.check('piped sh read -p consumes one line from /dev/tty',
      hasLine(body, 'ANSWER=nimbus') && hasLine(body, 'STATUS=0'),
      JSON.stringify(tail(body)));
  }

  await writeScript('/tmp/source-tty-helper.sh', [
    'read -r -p "SRC?>" key < /dev/tty',
    'printf "SOURCE_KEY=%s\\n" "$key"',
  ].join('\n'));
  await writeScript('/tmp/source-tty-main.sh', '. /tmp/source-tty-helper.sh');
  {
    t.reset();
    t.cmd('cat /tmp/source-tty-main.sh | sh; echo STATUS=$?');
    await t.waitFor((body) => body.includes('SRC?>'), 20_000, 'source /dev/tty prompt');
    t.send('sourced\r');
    await t.waitForNewPrompt(20_000);
    const body = normalized(t.buf);
    a.check('source inherits the caller controlling terminal',
      hasLine(body, 'SOURCE_KEY=sourced') && hasLine(body, 'STATUS=0'),
      JSON.stringify(tail(body)));
  }

  {
    await t.run('exec </dev/tty', 20_000);
    t.reset();
    t.cmd('old_tty_state=$(stty -g < /dev/tty); stty -icanon -echo min 1 time 0 < /dev/tty; printf "EXEC?>" > /dev/tty; key=$(dd bs=1 count=1 status=none); stty "$old_tty_state" < /dev/tty; printf "\\nEXEC_KEY=%s\\n" "$key"');
    await t.waitFor((body) => body.includes('EXEC?>'), 20_000, 'persistent exec /dev/tty prompt');
    t.send('e');
    await t.waitForNewPrompt(20_000);
    const body = normalized(t.buf);
    a.check('persistent exec </dev/tty binds to the current terminal stream',
      hasLine(body, 'EXEC_KEY=e'),
      JSON.stringify(tail(body)));
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

async function writeScript(path, content) {
  await t.run(heredocCommand(path, content), 20_000);
}

function normalized(output) {
  return stripAnsi(output).replace(/\r/g, '\n');
}

function hasLine(output, expected) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .includes(expected);
}

function tail(output) {
  return output.split('\n').slice(-30).join('\n');
}
