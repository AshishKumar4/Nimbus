#!/usr/bin/env bun
// agentic-cli/new/node-sync-cwd-project-snapshot — a fresh Node process
// can synchronously read ordinary project files from the current working
// tree, not only files statically reachable through require().

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'agentic-cli/new/node-sync-cwd-project-snapshot';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sync-snapshot/project/src && cd /home/user/sync-snapshot', 10_000);
await t.run(heredocCommand('project/package.json', '{"name":"sync-snapshot","devDependencies":{"vite":"latest"}}'), 10_000);
await t.run(heredocCommand('project/src/message.txt', 'hello from cwd snapshot'), 10_000);
await t.run(heredocCommand('check.js', `
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('project/package.json', 'utf8'));
const msg = fs.readFileSync('project/src/message.txt', 'utf8').trim();
console.log('PKG=' + pkg.name);
console.log('MSG=' + msg);
`), 10_000);

{
  const { output } = await t.run('node check.js', 30_000);
  const out = stripAnsi(output);
  a.check('sync fs.readFileSync sees project/package.json from cwd snapshot',
    /PKG=sync-snapshot/.test(out),
    JSON.stringify(out.slice(-500)));
  a.check('sync fs.readFileSync sees nested project data file from cwd snapshot',
    /MSG=hello from cwd snapshot/.test(out),
    JSON.stringify(out.slice(-500)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
