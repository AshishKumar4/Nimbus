#!/usr/bin/env bun
// agentic-cli/new/node-live-vfs-symlink — Node async fs symlink calls route
// through the shared live VFS bridge instead of placeholder shims.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'agentic-cli/new/node-live-vfs-symlink';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/live-symlink && cd /home/user/live-symlink', 10_000);
await t.run('printf "target-ok\\n" > target.txt', 10_000);
await t.run(heredocCommand('symlink.mjs', `
import { promises as fs } from 'node:fs';

await fs.symlink('target.txt', 'link.txt');
console.log('READLINK=' + await fs.readlink('link.txt'));
console.log('READ=' + (await fs.readFile('link.txt', 'utf8')).trim());
const dirent = (await fs.readdir('.', { withFileTypes: true })).find((entry) => entry.name === 'link.txt');
console.log('DIRENT_SYMLINK=' + Boolean(dirent && dirent.isSymbolicLink()));
`), 10_000);

{
  const { output } = await t.run('node symlink.mjs', 60_000);
  const stripped = stripAnsi(output);
  a.check('fs.promises.readlink returns the stored symlink target',
    /READLINK=target\.txt/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
  a.check('fs.promises.readFile follows live VFS symlinks',
    /READ=target-ok/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
  a.check('fs.promises.readdir withFileTypes preserves symlink metadata',
    /DIRENT_SYMLINK=true/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('readlink link.txt && cat link.txt', 10_000);
  const stripped = stripAnsi(output);
  a.check('Node-created symlink is visible to shell readlink and cat',
    /target\.txt/.test(stripped) && /target-ok/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
