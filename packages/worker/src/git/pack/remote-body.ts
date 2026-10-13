/** Bounded options followed by a streamed receive-pack body; one codec on both ends. */
const MAX_OPTIONS_BYTES = 1 << 20;
export const GIT_FRAMED_HEADER = 'x-nimbus-git-framed';

export function framedGitBody(options: unknown, pack: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(options));
  if (json.byteLength > MAX_OPTIONS_BYTES) throw new Error('Git request options exceed their frame limit');
  const head = new Uint8Array(4 + json.byteLength);
  new DataView(head.buffer).setUint32(0, json.byteLength);
  head.set(json, 4);
  const reader = pack.getReader();
  let started = false;
  return new ReadableStream({
    async pull(controller) {
      if (!started) { started = true; controller.enqueue(head); return; }
      const chunk = await reader.read();
      if (chunk.done) { reader.releaseLock(); controller.close(); }
      else controller.enqueue(chunk.value);
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
}

export async function readFramedGitBody(request: Request): Promise<{ options: unknown; pack?: ReadableStream<Uint8Array> }> {
  if (request.headers.get(GIT_FRAMED_HEADER) !== '1') return { options: await request.json() };
  if (!request.body) throw new Error('Git framed request has no body');
  const reader = request.body.getReader();
  let remainder: Uint8Array = new Uint8Array(0);
  const read = async (length: number): Promise<Uint8Array> => {
    const result = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      if (remainder.byteLength === 0) {
        const next = await reader.read();
        if (next.done) throw new Error('Git framed request ended in its options');
        remainder = next.value;
      }
      const take = Math.min(length - copied, remainder.byteLength);
      result.set(remainder.subarray(0, take), copied);
      remainder = remainder.subarray(take);
      copied += take;
    }
    return result;
  };
  try {
    const head = await read(4);
    const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
    if (length > MAX_OPTIONS_BYTES) throw new Error('Git request options exceed their frame limit');
    const options: unknown = JSON.parse(new TextDecoder().decode(await read(length)));
    const pack = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remainder.byteLength) { const chunk = remainder; remainder = new Uint8Array(0); controller.enqueue(chunk); return; }
        const chunk = await reader.read();
        if (chunk.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(chunk.value);
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    });
    return { options, pack };
  } catch (error) {
    try { await reader.cancel(error); } finally { reader.releaseLock(); }
    throw error;
  }
}
