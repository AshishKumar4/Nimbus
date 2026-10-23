#!/usr/bin/env bun
// A rename whose source the view knows is not there: a sync call answers it
// from the view (ENOENT, nothing logged); an async one in a subtree the
// process does not hold asks the session, which may know the source (a peer
// made it after the view's snapshot) or refuse it with its own ENOENT, which
// create-next-app catches for the `pages` and `styles` it moves only where
// they exist. Red before (recheck): an unheld async rename trusted the view
// and threw ENOENT for a source a peer had made.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { observeWaves, shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
authority.kfs.mkdir('/home/user/app', { recursive: true });

// The renames the session is sent, in program order.
const asked = [];
const { fs } = shimsOnSession({
  authority,
  overrides: (forward) => ({
    writeBatchStream: observeWaves(forward, (record) => {
      if (record.type === 'rename') asked.push(`/${record.from}`);
    }),
  }),
});
// A name the view's snapshot does not have: a peer made it after the snapshot.
await authority.peer.writeFile('/home/user/peer', 'made by a peer');

assert.throws(() => fs.renameSync('/home/user/pages', '/home/user/src-pages'), (error) => error.code === 'ENOENT' && error.syscall === 'rename', 'renameSync of a missing source returned');
await assert.rejects(fs.promises.rename('/home/user/styles', '/home/user/src-styles'), (error) => error.code === 'ENOENT', 'an async rename of a missing source resolved');
await fs.promises.rename('/home/user/peer', '/home/user/src-peer');
await fs.promises.rename('/home/user/app', '/home/user/src-app');
await globalThis.__nimbusProcessFs.flush();
assert.deepEqual(asked, ['/home/user/styles', '/home/user/peer', '/home/user/app'], 'the session was not asked for each async rename, or was asked for the sync one');
assert.equal(authority.kfs.exists('/home/user/src-peer'), true, 'a source a peer made was not renamed');
assert.equal(authority.kfs.exists('/home/user/peer'), false);
assert.equal(fs.existsSync('/home/user/src-app'), true);

console.log('node-rename-missing-source: ok');
