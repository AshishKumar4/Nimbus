#!/usr/bin/env bun
// The remote helper's engine (git/engine.ts), run through the real git
// network facet against git http-backend, host git the oracle on the same
// server:
//   - listRefs: `git ls-remote --symref`'s refs, peeled tags and HEAD, and
//     receive-pack's refs for a push;
//   - fetchPack: --depth 1 into an empty repository: host git's objects
//     and .git/shallow (its pack with .idx and .rev); then, the ref git
//     would write in place, an incremental fetch that sends only what is
//     new (haves); --filter=blob:none: a promisor pack, host git's
//     objects; include-tag on and off;
//   - pushPack: a new commit's pack streamed through (receive-pack applies
//     it: the served ref moves); a stale old value refused (ng); a
//     deletion with no pack; an atomic push with one bad command: neither
//     applied; push options where the server takes them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { createRemoteEngine } from '../../packages/worker/src/git/engine.ts';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-remote-engine-'));
const hostGit = (cwd, args, input) => input === undefined ? hostGitIn(work, cwd, args) : execFileSync('git', args, { cwd, input, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const hostObjects = (dir) => hostObjectsIn(work, dir);
const ZERO = '0'.repeat(40);
const session = await createFacetSession(work);
const engine = createRemoteEngine({ ctx: session.doCtx, env: session.doEnv, pid: 7, network: ISOLATE_NETWORK });
/** A pack of what `include` reaches and `exclude` does not, as git's helper makes it (pack-objects --revs --stdout). */
const packOf = (repo, include, exclude = []) => new Blob([hostGit(repo, ['pack-objects', '--revs', '--stdout', '-q'], [...include, ...exclude.map((oid) => '^' + oid)].join('\n') + '\n')]).stream();

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  const commit = (name) => {
    mkdirSync(join(source, 'dir'), { recursive: true });
    writeFileSync(join(source, 'dir', name + '.txt'), name + '\n'.repeat(3));
    writeFileSync(join(source, 'top.txt'), 'at ' + name + '\n');
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', name]);
    return hostGit(source, ['rev-parse', 'HEAD']).trim();
  };
  const c1 = commit('c1');
  const c2 = commit('c2');
  hostGit(source, ['tag', '-a', '-m', 'v1', 'v1', c2]);
  const c3 = commit('c3');
  hostGit(source, ['branch', 'side', c2]);
  const served = join(work, 'served');
  mkdirSync(served);
  const bare = join(served, 'repo.git');
  hostGit(work, ['clone', '-q', '--bare', source, bare]);
  hostGit(bare, ['config', 'http.receivepack', 'true']);
  // As the http server serves it, for host git's file:// fetches too.
  hostGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  hostGit(bare, ['config', 'receive.advertisePushOptions', 'true']);
  hostGit(bare, ['config', 'receive.advertiseAtomic', 'true']);
  const server = startGitHttpServer(served);
  const url = server.url + '/repo.git';
  try {
    // ── listRefs ──
    const listed = await engine.listRefs({ url, forPush: false });
    const lines = (refs) => refs.filter((ref) => ref.oid !== null).map((ref) => ref.oid + '\t' + ref.name).sort();
    const remote = hostGit(work, ['ls-remote', 'file://' + bare]).trim().split('\n').sort();
    assert.deepEqual(lines(listed.refs), remote, 'listRefs: host git\'s ls-remote');
    assert.equal(listed.refs.find((ref) => ref.name === 'HEAD')?.symref, 'refs/heads/main', 'HEAD names main');
    assert.equal(listed.objectFormat, 'sha1');
    const forPush = await engine.listRefs({ url, forPush: true });
    assert.deepEqual(lines(forPush.refs), remote.filter((line) => !line.endsWith('\tHEAD') && !line.endsWith('^{}')), 'listRefs for a push: receive-pack\'s refs');
    console.log(`  ok  listRefs: ${listed.refs.length} refs as ls-remote lists them; receive-pack's for a push`);

    // ── fetchPack: depth 1, then incremental ──
    assert.equal((await session.git('/home/user', ['init', '-q', 'r'])).code, 0);
    const host = join(work, 'host');
    hostGit(work, ['init', '-q', '-b', 'main', host]);
    hostGit(host, ['fetch', '-q', '--depth', '1', 'file://' + bare, 'main']);
    const first = await engine.fetchPack({ url, gitDir: '/home/user/r/.git', wants: [c3], depth: 1, includeTag: true, updateShallow: false });
    assert.ok(first.packName?.startsWith('pack-') && first.objects > 0 && first.shallow && !first.promisor && !first.selfContained, JSON.stringify(first));
    const packs = session.kernel.readdir('home/user/r/.git/objects/pack').map(({ name }) => name).sort();
    assert.deepEqual(packs, [first.packName + '.idx', first.packName + '.pack', first.packName + '.rev'], 'the pack with its .idx and .rev');
    assert.deepEqual(session.sessionObjects('home/user/r').objects, hostObjects(host), 'depth 1: host git\'s objects');
    assert.equal(session.kernel.readFileString('home/user/r/.git/shallow'), readFileSync(join(host, '.git/shallow'), 'utf8'), 'depth 1: host git\'s .git/shallow');
    // git writes the ref after a fetch: it is the next fetch's have.
    session.kernel.mkdir('home/user/r/.git/refs/remotes/origin', { recursive: true });
    session.kernel.writeFile('home/user/r/.git/refs/remotes/origin/main', c3 + '\n');
    hostGit(host, ['update-ref', 'refs/remotes/origin/main', c3]);
    const c4 = commit('c4');
    hostGit(source, ['push', '-q', bare, 'main']);
    hostGit(host, ['fetch', '-q', 'file://' + bare, 'main']);
    const next = await engine.fetchPack({ url, gitDir: '/home/user/r/.git', wants: [c4], includeTag: true, updateShallow: false });
    // c4, its two trees and its two changed blobs (dir/c4.txt, top.txt): nothing of c3's.
    assert.equal(next.objects, 5, 'only what is new: ' + JSON.stringify(next));
    assert.deepEqual(session.sessionObjects('home/user/r').objects, hostObjects(host), 'incremental: host git\'s objects');
    console.log(`  ok  fetchPack: depth 1 (${first.objects} objects) and incremental (${next.objects}): host git's objects and shallow file`);

    // A pack past one invocation's decoding budget goes on in the same facet until it is whole.
    assert.equal((await session.git('/home/user', ['init', '-q', 'slow'])).code, 0);
    const budgeted = createRemoteEngine({ ctx: session.doCtx, env: session.doEnv, pid: 7, network: ISOLATE_NETWORK, budgetUnits: 1 });
    const loadsBefore = session.requests.loads;
    const callsBefore = session.requests.calls.length;
    const slow = await budgeted.fetchPack({ url, gitDir: '/home/user/slow/.git', wants: [c4], includeTag: false, updateShallow: false });
    const steps = session.requests.calls.slice(callsBefore).filter((call) => call.phase === 'remote-fetch').length;
    assert.ok(steps > 2, 'the fetch ran in steps: ' + steps);
    assert.equal(session.requests.loads - loadsBefore, 1, 'in one facet');
    const hostFull = join(work, 'host-full');
    hostGit(work, ['init', '-q', '-b', 'main', hostFull]);
    hostGit(hostFull, ['fetch', '-q', 'file://' + bare, 'main']);
    assert.deepEqual(session.sessionObjects('home/user/slow').objects, hostObjects(hostFull), 'resumed: host git\'s objects');
    assert.ok(slow.selfContained, 'a complete repository\'s full fetch is self-contained: ' + JSON.stringify(slow));
    console.log(`  ok  fetchPack past its decoding budget: ${steps} steps in one facet; host git's objects`);

    // ── fetchPack: filtered, and include-tag ──
    assert.equal((await session.git('/home/user', ['init', '-q', 'p'])).code, 0);
    const hostPartial = join(work, 'host-partial');
    hostGit(work, ['init', '-q', '-b', 'main', hostPartial]);
    hostGit(hostPartial, ['-c', 'remote.origin.url=file://' + bare, 'fetch', '-q', '--filter=blob:none', '--depth', '1', 'file://' + bare, 'main']);
    const partial = await engine.fetchPack({ url, gitDir: '/home/user/p/.git', wants: [c4], depth: 1, filter: 'blob:none', includeTag: true, updateShallow: false });
    assert.ok(partial.promisor, JSON.stringify(partial));
    assert.ok(session.kernel.exists(`home/user/p/.git/objects/pack/${partial.packName}.promisor`), 'a .promisor beside the pack');
    assert.deepEqual(session.sessionObjects('home/user/p').objects, hostObjects(hostPartial), 'filtered: host git\'s objects');
    for (const [name, includeTag] of [['t-on', true], ['t-off', false]]) {
      assert.equal((await session.git('/home/user', ['init', '-q', name])).code, 0);
      await engine.fetchPack({ url, gitDir: `/home/user/${name}/.git`, wants: [c2], depth: 1, includeTag, updateShallow: false });
      const tag = hostGit(bare, ['rev-parse', 'v1']).trim();
      assert.equal(session.sessionObjects('home/user/' + name).objects.some((line) => line.startsWith(tag)), includeTag, `include-tag ${includeTag}: the tag object`);
    }
    console.log('  ok  fetchPack: a filtered fetch is a promisor pack with host git\'s objects; include-tag on and off');

    // ── pushPack ──
    const pusher = join(work, 'pusher');
    hostGit(work, ['clone', '-q', 'file://' + bare, pusher]);
    writeFileSync(join(pusher, 'pushed.txt'), 'pushed\n');
    hostGit(pusher, ['add', '-A']);
    hostGit(pusher, ['commit', '-q', '-m', 'c5']);
    const c5 = hostGit(pusher, ['rev-parse', 'HEAD']).trim();
    const pushed = await engine.pushPack({ url, commands: [{ ref: 'refs/heads/main', old: c4, new: c5 }], pack: packOf(pusher, [c5], [c4]), atomic: false, pushOptions: [] });
    assert.deepEqual(pushed.refs, [{ ref: 'refs/heads/main', ok: true }]);
    assert.equal(hostGit(bare, ['rev-parse', 'main']).trim(), c5, 'the served main moved');
    hostGit(bare, ['fsck', '--full', '--no-dangling']);
    const stale = await engine.pushPack({ url, commands: [{ ref: 'refs/heads/main', old: c4, new: c1 }], pack: packOf(pusher, [c1], [c5]), atomic: false, pushOptions: [] });
    assert.equal(stale.refs[0].ok, false, 'a stale old value is refused');
    assert.equal(hostGit(bare, ['rev-parse', 'main']).trim(), c5);
    const deleted = await engine.pushPack({ url, commands: [{ ref: 'refs/heads/side', old: c2, new: ZERO }], pack: null, atomic: false, pushOptions: [] });
    assert.deepEqual(deleted.refs, [{ ref: 'refs/heads/side', ok: true }]);
    assert.equal(hostGit(bare, ['branch', '--list', 'side']).trim(), '', 'side was deleted');
    const atomic = await engine.pushPack({
      url,
      commands: [{ ref: 'refs/heads/a', old: ZERO, new: c3 }, { ref: 'refs/heads/main', old: c4, new: c3 }],
      pack: packOf(pusher, [c3], [c5]), atomic: true, pushOptions: [],
    });
    assert.deepEqual(atomic.refs.map((ref) => ref.ok), [false, false], 'atomic: one bad command fails both: ' + JSON.stringify(atomic));
    assert.equal(hostGit(bare, ['branch', '--list', 'a']).trim(), '', 'atomic: a was not created');
    const optioned = await engine.pushPack({ url, commands: [{ ref: 'refs/heads/b', old: ZERO, new: c3 }], pack: packOf(pusher, [c3], [c5]), atomic: false, pushOptions: ['ci.skip'] });
    assert.deepEqual(optioned.refs, [{ ref: 'refs/heads/b', ok: true }], 'push options where the server takes them');
    console.log('  ok  pushPack: a pack streamed through, a stale old value refused, a deletion, atomic, push options');
  } finally {
    server.stop();
  }
  console.log('git-remote-engine: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
