import assert from 'node:assert/strict';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { generateEntrypointCode, generateLongRunningNodeCode } from '../../packages/worker/src/facets/manager.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const sources = nodeFacetSources('const __nimbusTestShimMarker = true;');
const source = generateOpencodeRunnerCode({
  argv: ['--version'], env: {}, cred, cwd: '/home/user', stdin: '', sources,
  vfsBundle: '{}', mode: 'oneshot',
});
const captureStart = source.indexOf('const __ocTailCap =');
const captureEnd = source.indexOf('const __ocFmt =', captureStart);
assert.ok(captureStart >= 0 && captureEnd > captureStart, 'the generated runner contains its bounded result capture');
const createCapture = new Function(`
  let stdout = '', stderr = '', exitCode = 0;
  const process = { stdout: {}, stderr: {}, env: {}, chdir() {} };
  const argv = [], env = {}, cwd = '/home/user', __ocMode = 'oneshot', __ocResident = false;
  let __ocExited = false;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const __nimbusOutText = (which, bytes) => decoders[which].decode(bytes, { stream: true });
  const __nimbusOutBytes = value => value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  ${source.slice(captureStart, captureEnd)}
  return { write: (which, bytes) => process[which].write(bytes),
    diagnostic: text => __ocAppendDiagnostic(text),
    result: () => ({ stdout, stderr, exitCode, error: typeof __ocCaptureError === 'undefined' ? null : __ocCaptureError }), cap: 1024 * 1024 };
`);
const split = createCapture();
split.write('stdout', new Uint8Array([0xc3]));
split.write('stderr', new Uint8Array([0xe2, 0x82]));
split.write('stdout', new Uint8Array([0xa9]));
split.write('stderr', new Uint8Array([0xac]));
assert.deepEqual(split.result(), { stdout: 'é', stderr: '€', exitCode: 0, error: null }, 'capture has one streaming decoder per result stream');
for (const which of ['stdout', 'stderr']) {
  const capture = createCapture();
  capture.write(which, new Uint8Array(capture.cap).fill(65));
  assert.equal(capture.result()[which].length, capture.cap, 'the exact declared allowance fits');
  assert.throws(() => capture.write(which, new Uint8Array([66])), { code: 'EFBIG' }, 'the next byte is refused, not retained or silently truncated');
  assert.equal(capture.result()[which].length, capture.cap);
  assert.equal(capture.result().exitCode, 1, 'catching the write error cannot turn an oversized result into success');
  capture.diagnostic('D'.repeat(128 * 1024) + '\nEFBIG\n');
  assert.equal(capture.result().stderr.length, 64 * 1024, 'error reporting remains bounded independently of the requested result');
  assert.match(capture.result().stderr, /EFBIG\n$/);
}
assert.ok(source.includes('if (__ocCaptureError && !__ocLoadError) __ocLoadError = __ocCaptureError.message;'), 'the final result surfaces an overflow even if guest code caught it');

// Execute each generated live-console override with an accounted byte sink.
// An arbitrarily large live write must not also append to the return capture.
const state = { bundle: {}, manifest: {}, metadata: {}, cursor: 0, serializedManifest: '{}', serializedMetadata: '{}' };
for (const code of [
  (await generateEntrypointCode('', state, false, sources)).code,
  (await generateLongRunningNodeCode('', state, { cred }, false, sources)).code,
]) {
  const start = code.indexOf('if (__supervisor && !captureOutput) {');
  const end = code.indexOf('try { globalThis.console =', start);
  assert.ok(start >= 0 && end > start);
  const writes = [];
  const run = new Function('__nimbusWriteLiveOutput', '__queueRpcWrite', `
    let stdout = '', stderr = '';
    const __supervisor = {}, captureOutput = false, __nimbusProgramStopped = false;
    const __nimbusOutEnc = new TextEncoder();
    const __consoleMod = {}, __processMod = { stdout: {}, stderr: {} };
    const __utilMod = { format: (...a) => a.join(' ') };
    ${code.slice(start, end)}
    __consoleMod.log('L'.repeat(256 * 1024));
    __consoleMod.error('error');
    return { stdout, stderr };
  `);
  const result = run((which, value, _enc, _cb, sink) => sink(which, new TextEncoder().encode(value)), (which, bytes) => writes.push([which, bytes]));
  assert.deepEqual(result, { stdout: '', stderr: '' }, 'live console retains no parallel whole-output capture');
  assert.deepEqual(writes.map(([which, bytes]) => [which, bytes.byteLength]), [['stdout', 256 * 1024 + 1], ['stderr', 6]]);
}
console.log('opencode-output-capture: bounded explicit results and no duplicate live console capture');
