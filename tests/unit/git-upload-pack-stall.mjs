#!/usr/bin/env bun
// The smart-HTTP client gives up on a response that stops sending, and names
// a response cut off mid-stream, both as transport failures
// (UploadPackError), which a clone retries. Red before: the read awaited
// forever, and a cut-off body surfaced as a bare stream error.

import assert from 'node:assert/strict';

import { UploadPackError, requestPack } from '../../packages/worker/src/git/pack/upload-pack.ts';
import { RETRY_ATTEMPTS, RETRY_BACKOFF_MS, STALL_MS } from '../../packages/worker/src/git/pack/transport.ts';

const encoder = new TextEncoder();
const pkt = (text) => encoder.encode((text.length + 4).toString(16).padStart(4, '0') + text);
const advertised = new Set(['side-band-64k', 'ofs-delta']);
const wants = ['1'.repeat(40)];

function respondWith(start) {
  return async () => new Response(new ReadableStream({ start }), { status: 200 });
}

{
  // NAK, the start of a pack, then silence.
  const fetch = respondWith((controller) => {
    controller.enqueue(pkt('NAK\n'));
    controller.enqueue(new Uint8Array([...encoder.encode('0009'), 1, 0x50, 0x41, 0x43, 0x4b]));
  });
  const response = await requestPack({ url: 'https://example.invalid/r.git', fetch, stallMs: 200 }, advertised, { wants });
  const started = Date.now();
  await assert.rejects(async () => { for await (const _ of response.pack) { /* drain */ } },
    (error) => error instanceof UploadPackError && /sent nothing for 0 s|sent nothing for/.test(error.message));
  assert.ok(Date.now() - started < 2000, 'gave up after the stall time');
}

{
  // A body that breaks off.
  const fetch = respondWith((controller) => {
    controller.enqueue(pkt('NAK\n'));
    queueMicrotask(() => controller.error(new Error('connection reset')));
  });
  await assert.rejects(async () => {
    const response = await requestPack({ url: 'https://example.invalid/r.git', fetch }, advertised, { wants });
    for await (const _ of response.pack) { /* drain */ }
  }, (error) => error instanceof UploadPackError && /broke off: connection reset/.test(error.message));
}

{
  // No response at all: the request gives up after the stall time, each of
  // its attempts. It waits the retry schedule between them, each wait
  // jittered by up to a quarter: 3.3 s to 5.3 s in all with a 100 ms stall,
  // so a fixed 5 s bound failed one run in sixteen on jitter alone. The
  // bound is the schedule's longest, plus scheduling slack; an attempt that
  // ignored stallMs would wait STALL_MS.
  let attempts = 0;
  const fetch = () => { attempts++; return new Promise(() => {}); };
  const started = Date.now();
  await assert.rejects(requestPack({ url: 'https://example.invalid/r.git', fetch, stallMs: 100 }, advertised, { wants }),
    (error) => error instanceof UploadPackError && /no response for/.test(error.message));
  const elapsed = Date.now() - started;
  assert.equal(attempts, RETRY_ATTEMPTS, 'each attempt is made, and each gives up');
  const longest = RETRY_ATTEMPTS * 100 + RETRY_BACKOFF_MS.slice(0, RETRY_ATTEMPTS - 1).reduce((sum, ms) => sum + ms * 1.25, 0);
  assert.ok(elapsed < longest + 2000 && elapsed < STALL_MS, `gave up after the stall time, each attempt (${elapsed} ms; the schedule's longest is ${longest} ms)`);
}

console.log('git-upload-pack-stall: ok');
