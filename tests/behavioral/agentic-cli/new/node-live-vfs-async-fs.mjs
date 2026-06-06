#!/usr/bin/env bun
// agentic-cli/new/node-live-vfs-async-fs — JS CLIs need async fs calls to see
// files that were created outside the current dynamic-worker prefetch bundle.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-live-vfs-async-fs');
console.log(`agentic-cli/new/node-live-vfs-async-fs — ${process.env.BASE}`);

const source = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';

const dir = '/home/user/' + ['live', 'node', 'fs'].join('-');
const input = dir + '/' + ['late', 'created'].join('-') + '.txt';
const output = dir + '/' + ['async', 'out'].join('-') + '.txt';
const renamed = dir + '/' + ['renamed', 'out'].join('-') + '.txt';
const nested = dir + '/made-by-node';
const nestedFile = nested + '/nested.txt';
const childOutput = dir + '/' + ['child', 'created'].join('-') + '.txt';

const text = await fsp.readFile(input, 'utf8');
console.log('READ=' + text.trim());

const st = await fsp.stat(input);
console.log('STAT=' + st.isFile() + ':' + st.size);

const names = await fsp.readdir(dir);
console.log('READDIR=' + names.sort().join(','));

await new Promise((resolve, reject) => {
  fs.access(input, (err) => err ? reject(err) : resolve());
});
console.log('ACCESS=ok');

const fh = await fsp.open(input, 'r');
const viaHandle = await fh.readFile('utf8');
await fh.close();
console.log('HANDLE=' + viaHandle.trim());

await fsp.writeFile(output, 'live-write-ok\\n');
await fsp.appendFile(output, 'append-ok\\n');
console.log('WRITE=ok');

await fsp.rename(output, renamed);
console.log('RENAME=ok');

await new Promise((resolve, reject) => {
  fs.rename(renamed, output, (err) => err ? reject(err) : resolve());
});
console.log('CALLBACK_RENAME=ok');

await fsp.mkdir(nested, { recursive: true });
await fsp.writeFile(nestedFile, 'nested-ok\\n');
await fsp.unlink(nestedFile);
await fsp.rmdir(nested);
console.log('MUTATIONS=ok');

await new Promise((resolve, reject) => {
  execFile('sh', ['-c', 'printf child-live-ok > ' + childOutput], (err) => err ? reject(err) : resolve());
});
const afterChild = await fsp.readdir(dir);
console.log('READDIR_AFTER_CHILD=' + afterChild.sort().join(','));
console.log('CHILD_READ=' + (await fsp.readFile(childOutput, 'utf8')));
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/live-node-fs', 10_000);
await t.run('printf "live-read-ok\\\\n" > /home/user/live-node-fs/late-created.txt', 10_000);
await t.run(heredocCommand('live-node-fs.mjs', source), 10_000);

const run = await t.run('node live-node-fs.mjs', 60_000);
const out = stripAnsi(run.output);

a.check('fs.promises.readFile sees a file outside the prefetch bundle',
  /READ=live-read-ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('fs.promises.stat uses live VFS fallback',
  /STAT=true:\d+/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('fs.promises.readdir uses live VFS fallback',
  /READDIR=.*late-created\.txt/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('callback fs.access uses live VFS fallback',
  /ACCESS=ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('FileHandle.readFile uses live VFS fallback',
  /HANDLE=live-read-ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('fs.promises.writeFile still flushes to persistent VFS',
  /WRITE=ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('fs.promises.rename uses the live VFS bridge',
  /RENAME=ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('callback fs.rename uses the live VFS bridge',
  /CALLBACK_RENAME=ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('async mkdir/write/unlink/rmdir complete through the live VFS bridge',
  /MUTATIONS=ok/.test(out),
  JSON.stringify(out.slice(-900)));
a.check('fs.promises.readdir sees files created by child processes after startup',
  /READDIR_AFTER_CHILD=.*child-created\.txt/.test(out),
  JSON.stringify(out.slice(-1200)));
a.check('fs.promises.readFile sees child-created files after startup',
  /CHILD_READ=child-live-ok/.test(out),
  JSON.stringify(out.slice(-1200)));

{
  const { output } = await t.run('cat /home/user/live-node-fs/async-out.txt', 10_000);
  const stripped = stripAnsi(output);
  a.check('async-written file is visible to the shell',
    /live-write-ok/.test(stripped) && /append-ok/.test(stripped),
    JSON.stringify(stripped.slice(-400)));
}

{
  const { output } = await t.run('test ! -e /home/user/live-node-fs/made-by-node && echo removed-ok', 10_000);
  const stripped = stripAnsi(output);
  a.check('async-created directory is removed from persistent VFS',
    /removed-ok/.test(stripped),
    JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
