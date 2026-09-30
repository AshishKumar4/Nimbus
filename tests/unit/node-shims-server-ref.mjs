#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { generateShimsCode } from './lib/node-http-platform.mjs';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
const runtime = new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname',
  generateShimsCode() + ENTRYPOINT_EVENT_LOOP + '\nreturn { http: builtins.http, count: __nimbusLiveHandles };')(
  {}, {}, {}, {registerPort(){},unregisterPort(){}}, {uid:1000,gid:1000,groups:[1000],umask:0o022}, '/home/user', [], {}, '/home/user/main.js', '/home/user');
globalThis.__nimbusPendingOps=0;globalThis.__nimbusPendingTimers=0;
const server=runtime.http.createServer();
assert.equal(server.unref(),server,'unref works before listen (get-port-please)');
await new Promise((resolve) => server.listen(7073, resolve));
assert.equal(runtime.count(),0,'an unrefed listener does not keep the entry event loop alive');
assert.equal(globalThis.__portRegistry.get(7073),server,'unref does not unregister the listening port');
assert.equal(server.ref(),server);
assert.equal(runtime.count(),1,'ref restores listener liveness');
server.unref();server.unref();
assert.equal(runtime.count(),0,'unref is idempotent');
await new Promise((resolve) => server.close(resolve));
assert.equal(globalThis.__portRegistry.has(7073),false,'close removes the listener');
console.log('node-shims-server-ref: ok');
