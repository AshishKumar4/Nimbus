import assert from 'node:assert/strict';
import { createHttpPlatform } from './lib/node-http-platform.mjs';

const host = { setTimeout, setInterval };
const scheduled = [];
const fired = [];
let server;
try {
  globalThis.setTimeout = (fn, delay, ...args) => { scheduled.push(['timeout', delay]); return host.setTimeout(fn, delay, ...args); };
  globalThis.setInterval = (fn, delay, ...args) => { scheduled.push(['interval', delay]); return host.setInterval(fn, delay, ...args); };
  const { http } = createHttpPlatform();
  server = http.createServer({
    get keepAliveTimeout() { setTimeout(() => fired.push('keep-alive'), 10); return 5000; },
    get connectionsCheckingInterval() { setTimeout(() => fired.push('checking'), 10); return 30000; },
  });
  assert.deepEqual(scheduled, [['timeout', 10], ['timeout', 10]], 'application option getters retain guest timer accounting');
  scheduled.length = 0;
  server.on('listening', () => setTimeout(() => fired.push('listening'), 10));
  server.listen(51001);
  await server.ready.promise;
  await new Promise(resolve => host.setTimeout(resolve, 30));
  assert.equal(scheduled.some(([kind, delay]) => kind === 'interval' && delay === 30000), false, 'only the native connection sweep bypasses guest accounting');
  assert.ok(scheduled.some(([kind, delay]) => kind === 'timeout' && delay === 10), 'application listening handlers retain guest timers');
  assert.deepEqual(fired, ['keep-alive', 'checking', 'listening']);
} finally {
  Object.assign(globalThis, host);
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}
console.log('node-http-platform-timers: application getters/listeners remain tracked; host connection sweep does not');
