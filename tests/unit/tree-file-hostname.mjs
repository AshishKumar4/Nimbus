#!/usr/bin/env bun
// tree, file and hostname as the workspace shell runs them. Each had two
// implementations, the shell's and the lifo substrate's, which disagreed;
// one is left for each, with what the other did right: tree walks every
// level unless -L bounds it and lists directories alone under -d, file
// calls an empty file `empty` and a text file `ASCII text` (no line
// count, which no file(1) prints), and hostname is the host's name, not
// whatever $HOSTNAME holds.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const run = async (command) => {
    const r = await ws.exec(`cd /home/user && ${command}`);
    return { ...r, out: r.stdout };
  };
  assert.equal((await run('mkdir -p t/a/b/c/d && touch t/a/b/c/d/leaf t/top && : > empty && printf "x\\ny\\n" > two')).exitCode, 0);

  const deep = await run('tree t');
  assert.equal(deep.out, 't\n├── a\n│   └── b\n│       └── c\n│           └── d\n│               └── leaf\n└── top\n\n4 directories, 2 files\n', 'tree walks past the third level');
  assert.equal((await run('tree -L 2 t')).out, 't\n├── a\n│   └── b\n└── top\n\n2 directories, 1 files\n');
  assert.equal((await run('tree -d t')).out, 't\n└── a\n    └── b\n        └── c\n            └── d\n\n4 directories\n', 'tree -d lists directories alone');

  assert.equal((await run('file empty two')).out, 'empty: empty\ntwo: ASCII text\n');

  assert.equal((await run('HOSTNAME=elsewhere hostname')).out, 'nimbus\n');
  assert.equal((await run('hostname')).out, `${(await run('uname -n')).out}`);
} finally {
  await ws.close();
}
console.log('tree-file-hostname: ok');
