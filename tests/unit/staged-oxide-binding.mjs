#!/usr/bin/env bun
// The exact staged oxide build scans content and watches new files without threads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, stagedBinding } from '../../packages/worker/src/runtime/staged-bindings.ts';

const assetUrl = (asset) => new URL(`../../packages/worker/public${asset.path}`, import.meta.url);
const staged = (asset) => {
  const bytes = fs.readFileSync(assetUrl(asset));
  assert.equal(bytes.byteLength, asset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  return bytes;
};
const oxide = stagedBinding('oxide@4.3.3');
assert.equal(oxide.owner, '@tailwindcss/oxide');
assert.deepEqual(oxide.requiredAs, ['@tailwindcss/oxide-wasm32-wasi']);
staged(NAPI_WASM_LOADER);
const { createNapiWasmBinding } = await import(assetUrl(NAPI_WASM_LOADER).href);
const [binding, trampoline] = await Promise.all([
  WebAssembly.compile(staged(oxide.wasm)), WebAssembly.compile(staged(NAPI_WASM_TRAMPOLINE)),
]);
const { Scanner } = createNapiWasmBinding({
  fs, env: {}, binding, trampoline, memoryPages: oxide.memoryPages, name: oxide.name,
  writeStdout: (bytes) => process.stdout.write(bytes), writeStderr: (bytes) => process.stderr.write(bytes),
});
const dir = fs.mkdtempSync(join(tmpdir(), 'nimbus-oxide-'));
try {
  const scanner = new Scanner({ sources: [{ base: dir, pattern: '**/*.html', negated: false }] });
  const scanned = scanner.scanFiles([{ content: '<div class="p-7 hover:bg-blue-600"></div>', extension: 'html' }]);
  for (const candidate of ['p-7', 'hover:bg-blue-600']) assert.ok(scanned.includes(candidate));
  const text = '🙂 <div class="text-red-500"></div>';
  const located = scanner.getCandidatesWithPositions({ content: text, extension: 'html' });
  assert.equal(located.find((entry) => entry.candidate === 'text-red-500')?.position, text.indexOf('text-red-500'));

  const first = join(dir, 'first.html');
  fs.writeFileSync(first, '<div class="bg-red-500"></div>');
  assert.ok(scanner.scan().includes('bg-red-500'));
  fs.mkdirSync(join(dir, 'nested'));
  const second = join(dir, 'nested/second.html');
  fs.writeFileSync(second, '<div class="grid-cols-7"></div>');
  const next = scanner.scan();
  assert.ok(next.includes('grid-cols-7'), 'a subsequent scan walks newly created directories inline');
  assert.ok(scanner.files.includes(first));
  assert.ok(scanner.files.includes(second));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('staged-oxide-binding: ok');
