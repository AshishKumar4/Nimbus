#!/usr/bin/env bun
// python/vfs-import-and-file-io — Pyodide runs against Nimbus's persistent
// VFS: local imports, relative reads, and file writes round-trip through the
// browser-visible /home/user tree.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/vfs-import-and-file-io';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);
await t.run('mkdir -p /home/user/py-vfs && cd /home/user/py-vfs', 10_000);
await t.run(heredocCommand('helper.py', 'VALUE = "nimbus-python-vfs"'), 10_000);
await t.run(heredocCommand('app.py', [
  'import helper',
  'print("IMPORT=" + helper.VALUE)',
  'print("READ=" + open("helper.py").read().split("=")[0].strip())',
  'open("created.txt", "w").write(helper.VALUE + "\\n")',
].join('\n')), 10_000);

{
  const { output } = await t.run('python app.py', 120_000);
  const stripped = stripAnsi(output);
  a.check('python imports a sibling VFS module',
    /IMPORT=nimbus-python-vfs/.test(stripped),
    JSON.stringify(stripped.slice(-600)));
  a.check('python reads relative VFS files',
    /READ=VALUE/.test(stripped),
    JSON.stringify(stripped.slice(-600)));
}

{
  const { output } = await t.run('cat created.txt', 10_000);
  const stripped = stripAnsi(output);
  a.check('python writes are flushed back to Nimbus VFS',
    /nimbus-python-vfs/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
