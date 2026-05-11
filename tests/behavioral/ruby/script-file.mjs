#!/usr/bin/env bun
// ruby/script-file — `ruby script.rb` runs a file from the VFS,
// $PROGRAM_NAME (aka $0) should be the script path.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/script-file');
console.log(`ruby/script-file — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 180_000);

// Write a tiny ruby script.
await t.run(`cat > t.rb <<'EOF'
puts "from-script"
puts "argv0=#{$PROGRAM_NAME}"
EOF`, 30_000);

{
  const { output, elapsed } = await t.run(`ruby t.rb`, 60_000);
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const hasFromScript = lines.some((l) => l === 'from-script');
  a.check('ruby t.rb prints "from-script"', hasFromScript,
    hasFromScript ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-300)));
  const argv0Line = lines.find((l) => l.startsWith('argv0='));
  const argv0 = argv0Line ? argv0Line.slice('argv0='.length) : '';
  a.check('ruby t.rb: $PROGRAM_NAME === "t.rb"', argv0 === 't.rb',
    `argv0=${JSON.stringify(argv0)}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
