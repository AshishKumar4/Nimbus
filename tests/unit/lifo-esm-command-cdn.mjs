#!/usr/bin/env bun
// A lifo ES module command's bare imports go to the CDN, and nothing else
// does: a string or a comment that reads like an import is the program's
// text, and a builtin (`node:`) or a URL is imported as it is. The CDN is
// LIFO_CDN; here a data: URL, so that what a rewritten import loads is a
// module this test wrote (`${cdn}/${specifier}` is a comment after it).
//
// Red before: the imports were rewritten by a regular expression over the
// whole text, so a string "from 'foo'" printed as "from 'https://esm.sh/foo'",
// and 'node:path' became a CDN URL.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CDN = 'data:text/javascript,export default "from the cdn";//';
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const view = ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const command = async (name, source) => {
  await ws.fs.writeFile(`/home/user/pkg/${name}.mjs`, source);
  ws.registry.register(name, createLifoCommand(`/home/user/pkg/${name}.mjs`, view));
  const r = await ws.exec(name, { cwd: '/home/user', env: { LIFO_CDN: CDN } });
  return [r.exitCode, r.stdout, r.stderr];
};
try {
  await ws.fs.mkdir('/home/user/pkg', { recursive: true });

  assert.deepEqual(await command('text', `export default (ctx) => {
  // import x from 'nope'
  ctx.stdout.write("from 'foo' and import('bar')\\n");
  return 0;
};
`), [0, "from 'foo' and import('bar')\n", ''], 'text that reads like an import is the program\'s text');
  console.log('  ✓ a string and a comment that read like imports are left as they are');

  assert.deepEqual(await command('bare', `import fromCdn from 'foo';
import { basename } from 'node:path';
export default async (ctx) => {
  const later = await import('bar');
  ctx.stdout.write(fromCdn + ' | ' + later.default + ' | ' + basename('/a/b.txt') + '\\n');
  return 0;
};
`), [0, 'from the cdn | from the cdn | b.txt\n', ''], 'bare imports, static and dynamic, go to the CDN; a builtin does not');
  console.log('  ✓ a bare import, static or dynamic, loads from the CDN; node:path is the builtin');
} finally {
  await ws.close();
}
console.log('lifo-esm-command-cdn: ok');
