#!/usr/bin/env bun
// A resident node process answers every synchronous metadata question —
// statSync, lstatSync, existsSync, readdirSync, realpathSync — exactly as the
// session filesystem stands at its last barrier, whoever changed it.
//
// The resident store holds the namespace (every name and its stat, no
// content) and each ACQUIRE moves it forward with the stats the delta
// carries. So a file a peer creates after launch exists for the process at
// its next resumption, a tree a peer removes is gone, a stat reports the
// authority's mtime and mode rather than a local guess, and a symlink is a
// symlink. The process's own structural changes read back at once and stay
// visible until the authority reports them.

import assert from 'node:assert/strict';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
} from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
const t = (f) => { try { return f(); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = {
  fs,
  t,
  // One resumption, then the synchronous calls, inside the callback.
  resume: (f) => new Promise((resolve) => setTimeout(() => resolve(t(f)), 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot(setup) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  authority.kfs.mkdir('opt/data/deep', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('opt/data/deep/x.json', '{"x":1}');
  if (setup) setup(authority);
  const { supervisor } = facetSupervisor(authority);
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: supervisor }, cursor: authority.cursor() });
  return { authority, probe: globalThis.__probe };
}

await runScenarios(import.meta.path, {
  async 'a file a peer creates after launch exists at the next resumption'() {
    const { authority, probe } = await boot();
    const { fs } = probe;
    authority.kfs.writeFile('home/user/app/new.txt', 'hello');
    const seen = await probe.resume(() => [
      fs.existsSync('/home/user/app/new.txt'),
      fs.statSync('/home/user/app/new.txt').size,
      fs.readdirSync('/home/user/app').join(','),
    ].join('|'));
    assert.equal(seen, 'true|5|f.txt,new.txt');
  },

  async 'a tree a peer removes is gone at the next resumption'() {
    const { authority, probe } = await boot();
    const { fs } = probe;
    assert.equal(fs.existsSync('/opt/data/deep/x.json'), true);
    authority.kfs.removeRecursive('opt/data');
    const seen = await probe.resume(() => [
      fs.existsSync('/opt/data/deep/x.json'),
      fs.existsSync('/opt/data'),
      fs.readdirSync('/opt').length,
      probe.t(() => fs.statSync('/opt/data/deep')),
    ].join('|'));
    assert.equal(seen, 'false|false|0|ERR:ENOENT');
  },

  async 'a stat reports the authority stat, not a local guess'() {
    const { authority, probe } = await boot((a) => {
      a.kfs.writeFile('opt/data/mode.sh', '#!/bin/sh\n', { mode: 0o750 });
      a.kfs.utimes('opt/data/mode.sh', 1_000_000, 2_000_000);
    });
    const st = probe.fs.statSync('/opt/data/mode.sh');
    assert.equal(st.mtimeMs ?? st.mtime.getTime(), 2_000_000);
    assert.equal(st.mode & 0o777, 0o750);
    authority.kfs.chmod('opt/data/mode.sh', 0o700);
    authority.kfs.utimes('opt/data/mode.sh', 3_000_000, 4_000_000);
    const after = await probe.resume(() => {
      const s = probe.fs.statSync('/opt/data/mode.sh');
      return (s.mode & 0o777).toString(8) + '|' + s.mtime.getTime();
    });
    assert.equal(after, '700|4000000');
  },

  async 'a symlink is a symlink, and resolves through the namespace'() {
    const { probe } = await boot((a) => {
      a.kfs.symlink('deep', 'opt/data/link');
    });
    const { fs } = probe;
    assert.equal(fs.lstatSync('/opt/data/link').isSymbolicLink(), true);
    assert.equal(fs.statSync('/opt/data/link').isDirectory(), true);
    assert.equal(fs.existsSync('/opt/data/link/x.json'), true);
    assert.equal(fs.realpathSync('/opt/data/link/x.json'), '/opt/data/deep/x.json');
    const kinds = fs.readdirSync('/opt/data', { withFileTypes: true })
      .map((d) => d.name + ':' + (d.isSymbolicLink() ? 'l' : d.isDirectory() ? 'd' : 'f')).join(',');
    assert.equal(kinds, 'deep:d,link:l');
  },

  async 'a directory a peer makes searchable shows its children'() {
    const { authority, probe } = await boot((a) => {
      a.kfs.mkdir('opt/locked', { mode: 0o755 });
      a.kfs.writeFile('opt/locked/inside.txt', 'in');
      a.kfs.chmod('opt/locked', 0o700);
      a.rawVfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).chown('opt/locked', 0, 0);
    });
    const { fs } = probe;
    assert.equal(fs.existsSync('/opt/locked'), true);
    assert.equal(fs.existsSync('/opt/locked/inside.txt'), false, 'hidden under a directory the process cannot search');
    authority.rawVfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).chmod('opt/locked', 0o755);
    const seen = await probe.resume(() => fs.existsSync('/opt/locked/inside.txt') + '|' + fs.readdirSync('/opt/locked').join(','));
    assert.equal(seen, 'true|inside.txt');
  },

  async "the process's own structural changes read back at once and survive the barrier"() {
    const { authority, probe } = await boot();
    const { fs } = probe;
    fs.mkdirSync('/home/user/app/made/sub', { recursive: true });
    fs.unlinkSync('/home/user/app/f.txt');
    fs.renameSync('/opt/data/deep', '/opt/data/moved');
    const now = [
      fs.statSync('/home/user/app/made/sub').isDirectory(),
      fs.existsSync('/home/user/app/f.txt'),
      fs.readdirSync('/home/user/app').join(','),
      fs.existsSync('/opt/data/deep'),
      fs.readdirSync('/opt/data/moved').join(','),
    ].join('|');
    assert.equal(now, 'true|false|made|false|x.json');
    // Barriers now run while those mutations are in flight and after they
    // land; every one must keep the process's own view.
    for (let i = 0; i < 5; i++) {
      assert.equal(await probe.resume(() => [
        fs.existsSync('/home/user/app/made/sub'),
        fs.existsSync('/home/user/app/f.txt'),
        fs.existsSync('/opt/data/moved/x.json'),
        fs.existsSync('/opt/data/deep'),
      ].join('|')), 'true|false|true|false');
    }
    // Landed at the authority, and a peer's later change is seen through.
    assert.equal(authority.kfs.exists('opt/data/moved/x.json'), true);
    authority.kfs.writeFile('home/user/app/f.txt', 'again');
    assert.equal(await probe.resume(() => fs.existsSync('/home/user/app/f.txt')), true);
  },
});
