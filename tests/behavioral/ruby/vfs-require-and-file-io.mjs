#!/usr/bin/env bun
// ruby/vfs-require-and-file-io — ruby.wasm runs against Nimbus's persistent
// VFS: require_relative, relative reads, and file writes round-trip through
// the browser-visible /home/user tree.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/vfs-require-and-file-io';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);
await t.run('mkdir -p /home/user/ruby-vfs && cd /home/user/ruby-vfs', 10_000);
await t.run(heredocCommand('helper.rb', 'VALUE = "nimbus-ruby-vfs"'), 10_000);
await t.run(heredocCommand('app.rb', [
  'require_relative "./helper"',
  'puts "IMPORT=#{VALUE}"',
  'puts "READ=#{File.read(\'helper.rb\').split(\'=\')[0].strip}"',
  'File.write("created.txt", VALUE + "\\n")',
].join('\n')), 10_000);

{
  const { output } = await t.run('ruby app.rb', 120_000);
  const stripped = stripAnsi(output);
  a.check('ruby requires a sibling VFS file',
    /IMPORT=nimbus-ruby-vfs/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
  a.check('ruby reads relative VFS files',
    /READ=VALUE/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('cat created.txt', 10_000);
  const stripped = stripAnsi(output);
  a.check('ruby writes are flushed back to Nimbus VFS',
    /nimbus-ruby-vfs/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
