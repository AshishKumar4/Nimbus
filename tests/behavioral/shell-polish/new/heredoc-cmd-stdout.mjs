#!/usr/bin/env bun
// shell-polish/new/heredoc-cmd-stdout — `cmd << DELIM` content as
// stdin MUST emit the command's stdout to the terminal. Pre-fix:
//
//   $ cat << 'EOF'
//   > hi
//   > 2
//   > EOF
//   user@nimbus:~$     <-- expected "hi\n2" before this prompt
//
// The HeredocHandler called shell.execute(cmd, { stdin: content })
// WITHOUT an onStdout callback, so cat's output was buffered to
// nowhere. The redirect path (cat > file << EOF) worked because it
// wrote directly to VFS, bypassing shell.execute() entirely.
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-polish/heredoc-cmd-stdout');
console.log(`shell-polish/heredoc-cmd-stdout — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Use EXACT-line matching — the WS terminal echoes the command line +
// the `> ` continuation prompts; only the cat-stdout lines come out
// as their own lines.
function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. cat << 'EOF' with quoted delimiter (no expansion).
{
  const r = await t.run(`cat << 'POLISH_EOF'\nhi-stdout-A\n2nd-line-B\nPOLISH_EOF`, 15_000);
  const out = stripAnsi(r.output);
  const hasA = hasOutputLine(out, 'hi-stdout-A');
  const hasB = hasOutputLine(out, '2nd-line-B');
  a.check('cat << \'EOF\' prints "hi-stdout-A" line', hasA,
    hasA ? '' : JSON.stringify(out.slice(-400)));
  a.check('cat << \'EOF\' prints "2nd-line-B" line', hasB,
    hasB ? '' : JSON.stringify(out.slice(-400)));
}

// 2. cat << EOF (unquoted) with $VAR expansion. heredoc content
//    is expanded BEFORE feeding to stdin, so $USER becomes the value.
{
  const r = await t.run(`cat << POLISH_EOF\nuser=$USER\nPOLISH_EOF`, 15_000);
  const out = stripAnsi(r.output);
  // Expect "user=user" (USER=user in our env). The exact value isn't
  // important; what matters is that the LINE "user=<something>"
  // appears as cat's stdout.
  const lines = out.split(/\r?\n/).map((l) => l.trim());
  const userLine = lines.find((l) => /^user=\S/.test(l));
  a.check('cat << EOF (unquoted) expands $USER and emits the line', userLine !== undefined,
    userLine !== undefined ? `line="${userLine}"` : JSON.stringify(out.slice(-400)));
}

// 3. heredoc + redirect to file MUST keep working (regression for the
//    direct-VFS-write path).
{
  await t.run('rm -f /tmp/hd-out.txt', 5_000);
  await t.run(`cat > /tmp/hd-out.txt << 'POLISH_EOF'\nline-X\nline-Y\nPOLISH_EOF`, 15_000);
  const r = await t.run('cat /tmp/hd-out.txt', 10_000);
  const out = stripAnsi(r.output);
  const okX = hasOutputLine(out, 'line-X');
  const okY = hasOutputLine(out, 'line-Y');
  a.check('cat > file << EOF still writes the file (regression)', okX && okY,
    okX && okY ? '' : JSON.stringify(out.slice(-400)));
}

// 4. Pipe a non-cat command (grep) through heredoc.
{
  const r = await t.run(`grep needle << 'POLISH_EOF'\nfoo bar\nhello needle world\nbaz quux\nPOLISH_EOF`, 15_000);
  const out = stripAnsi(r.output);
  const has = hasOutputLine(out, 'hello needle world');
  a.check('grep needle << EOF picks the matching line', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
