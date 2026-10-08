import assert from 'node:assert/strict';
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const gone = Object.assign(new Error('process pid 41 does not exist'), { code: 'ESRCH' });
const client = processFsClient({ session: {
  openWriter: async () => { throw gone; },
  writeBatchStream: async () => { throw gone; },
} });
client.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/a', data: new Uint8Array([1]), mode: 0o644 } }, { acknowledged: true });
await assert.rejects(client.flush(), (error) => error === gone);

class ProcessExit extends Error {
  constructor(code) { super('process exit'); this.code = code; }
}
const scope = Object.create(globalThis);
scope.__nimbusProcessFs = client;
const factory = new Function(
  'globalThis', '__ProcessExit', '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  'let stdout = "", stderr = "", exitCode = 0; const __pendingIO = [];\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\nreturn { console: __consoleMod, process: __processMod, gate: __nimbusOutputGate, output: () => stdout };',
);
const runtime = factory(scope, ProcessExit, {}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');
assert.equal(runtime.gate(), null, 'the output gate synchronously threw the dead process filesystem failure');
assert.doesNotThrow(() => runtime.console.log('after refusal'));
assert.match(runtime.output(), /after refusal/);
assert.throws(() => runtime.process.exit(0), (error) => error instanceof ProcessExit && error.code === 0, 'process.exit surfaced the filesystem refusal instead of its exit');
console.log('process-fs-output-gone: a terminal filesystem refusal does not turn console output or exit into a synchronous exception');
