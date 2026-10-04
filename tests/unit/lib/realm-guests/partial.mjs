// Sends two events: the first split into pieces of 1 to 7 bytes, the second whole; then ends.
import { writeSync } from 'node:fs';
import { serialize } from 'node:v8';

const frame = (message) => {
  const body = serialize(message);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
};
const first = frame({ kind: 'event', event: 'x'.repeat(100_000) });
let at = 0;
let size = 1;
while (at < first.byteLength) {
  writeSync(5, first.subarray(at, at + size));
  at += size;
  size = size % 7 + 1;
  if (at % 4096 < 7) await new Promise((resolve) => setImmediate(resolve));
}
writeSync(5, frame({ kind: 'event', event: 'second' }));
