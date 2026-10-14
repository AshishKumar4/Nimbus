#!/usr/bin/env bun
// `nimbus wrangler dev`'s assets binding reads a project's assets as the
// process that started the server, as its config, its bundle and its stores
// are read. The host mints the binding with that process's credential in its
// props, which the guest cannot set. Red before: the binding carried none,
// and NimbusAssetsRPC read every asset as the session's user.
import assert from 'node:assert/strict';
import { NimbusWrangler } from '../../packages/worker/dist/wrangler/nimbus-wrangler.js';

const RUN_AS = Object.freeze({ uid: 1001, gid: 1001, groups: Object.freeze([1001]), umask: 0o022 });
const minted = [];
const wrangler = new NimbusWrangler({
  vfs: {}, namespace: { watchChanges: () => () => {} }, esbuild: {},
  bundleFs: {},
  cred: RUN_AS,
  env: {},
  ctx: {
    id: { toString: () => 'session-id' },
    exports: { NimbusAssetsRPC: ({ props }) => { minted.push(props); return { assets: props }; } },
  },
  root: '/home/user/site',
  onLog: () => {},
});
wrangler.config = { assets: { directory: './public', binding: 'ASSETS' } };
const env = wrangler.buildInnerEnv();
assert.equal(minted.length, 1, 'the assets binding is minted');
assert.deepEqual(minted[0].cred, RUN_AS, "its props carry the server's process's credential");
assert.equal(env.ASSETS.assets, minted[0]);

console.log('wrangler-assets-credential: ok');
