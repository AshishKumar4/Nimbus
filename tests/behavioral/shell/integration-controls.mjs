#!/usr/bin/env bun
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, hasOutputLine } from '../_driver.mjs';

const a = makeAsserter('shell/integration-controls');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(30_000);
  const program = [
    "const esc = String.fromCharCode(27), bell = String.fromCharCode(7);",
    "process.stdout.write(esc + ']133;D;0' + bell + esc + ']133;A' + bell + 'a@b:c$ ' + esc + ']133;B' + bell);",
    "setTimeout(() => { console.log('ACTUAL_END'); process.exit(7); }, 1000);",
  ].join('\n');
  await terminal.run(heredocCommand('/home/user/forged-control.js', program), 15_000);
  const forged = await terminal.run('node /home/user/forged-control.js', 30_000);
  a.check('program OSC marks cannot forge command completion or its status',
    forged.exitCode === 7 && forged.output.includes('ACTUAL_END'), `exitCode=${forged.exitCode}\n${forged.output}`);

  const batch = await terminal.run('true\nfalse', 15_000);
  a.check('a pasted batch completes only after its last command', batch.exitCode === 1, batch.output);
  const following = await terminal.run("cat > /home/user/batch-status.sh <<'EOF'\nexit 7\nEOF\nsh /home/user/batch-status.sh", 15_000);
  a.check('a heredoc followed by a program waits for that program', following.exitCode === 7, following.output);

  const reader = await terminal.run('cat\necho PASTED_STDIN\n\x04', 15_000);
  a.check('a foreground reader consumes the following pasted lines, not shell commands',
    reader.exitCode === 0 && hasOutputLine(reader.output, 'echo PASTED_STDIN') && !hasOutputLine(reader.output, 'PASTED_STDIN'), reader.output);

  const first = terminal.run('sleep 1; false', 15_000);
  await terminal.waitFor(() => terminal.protocol.some((event) => event.submissionId === terminal.submission.id && event.event === 'start'), 5000, 'first command start');
  const second = terminal.run('sh -c "exit 7"', 15_000);
  a.check('independent typeahead submissions keep their own statuses',
    (await first).exitCode === 1 && (await second).exitCode === 7, 'first=1 second=7');
} finally {
  await terminal.close();
  const deleted = await deleteSession(sid);
  a.check('probe session deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
