// @serial
// @tier slow — actual JSPI guest, SQLite actor and supervisor RPC boundary in workerd.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: ['git'] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const made = await terminal.run('mkdir -p tree && git -C tree init -q && for i in $(seq 0 39); do mkdir -p tree/d$i && echo content > tree/d$i/file.txt; done && git -C tree add . && git -C tree -c user.name=Reader -c user.email=reader@example.com commit -qm seed', 120000);
    assert.equal(made.status, 0, made.stdout);
    assert.equal((await terminal.run('nimbus install git', 120000)).status, 0);
    const status = await terminal.run('NIMBUS_WASI_FS_STATS=1 git -C tree status --porcelain', 120000);
    assert.equal(status.status, 0, status.stdout);
    const line = status.stdout.split('\n').find((value) => value.includes('[wasi-fs] git '));
    assert.ok(line, status.stdout);
    const stats = JSON.parse(line.slice(line.indexOf('[wasi-fs] git ') + '[wasi-fs] git '.length));
    console.log(JSON.stringify({ stats }));
    assert.ok(stats.delegated.readDirectories > 0, 'directory opens use the generic bounded operation');
    assert.ok(stats.client.readLeases > 0, 'the guest holds actual authority read delegations');
    assert.ok((stats.delegated.open ?? 0) < 20, 'walking forty directories does not open each one through RPC');
    assert.ok((stats.delegated.fstat ?? 0) < 20, 'directory fstat is answered from the admitted namespace');
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
console.log('wasi-directory-locality-workerd: real directory descriptions under read delegations');
