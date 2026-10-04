import type { CommandInputStream } from '../substrate/lifo/commands/types.js';

/**
 * One consuming source behind the full reader contract, byte-accurate:
 * the text is encoded once and every offset is a byte offset, so
 * readBytes(1) over `é` yields exactly one UTF-8 byte per call and mixed
 * text/byte consumption never diverges. Worker pure-builtin adapters hold
 * stdin as a plain string; without this they can only offer readAll, and
 * streaming commands see an empty pipe.
 */
export function staticStdinReader(text: string): CommandInputStream {
  let bytes: Uint8Array | null = new TextEncoder().encode(text);
  return pulledStdinReader(async () => {
    const all = bytes;
    bytes = null;
    return all;
  });
}

/**
 * A live source behind the full reader contract: `pull` hands the next
 * bytes its producer delivered, waiting for them, and null at the end. The
 * reader asks for more only when a consumer reads, so a producer's queue
 * holds what is not read yet; what a read does not take (past a readBytes
 * bound, after a readLine's newline) stays here, in order, for the next.
 * Text is decoded progressively, so a multi-byte sequence split across two
 * deliveries survives, and an empty delivery is not the end.
 */
export function pulledStdinReader(pull: () => Promise<Uint8Array | null>): CommandInputStream {
  const pushedBack: Uint8Array[] = [];
  const decoder = new TextDecoder('utf-8');
  let ended = false;

  const next = async (): Promise<Uint8Array | null> => {
    const held = pushedBack.shift();
    if (held) return held;
    while (!ended) {
      const bytes = await pull();
      if (bytes === null) ended = true;
      else if (bytes.length > 0) return bytes;
    }
    return null;
  };

  const read = async (): Promise<string | null> => {
    for (;;) {
      const bytes = await next();
      if (bytes === null) {
        const tail = decoder.decode();
        return tail.length > 0 ? tail : null;
      }
      const text = decoder.decode(bytes, { stream: true });
      if (text.length > 0) return text;
    }
  };

  return {
    read,
    readAll: async () => {
      const parts: string[] = [];
      for (let chunk = await read(); chunk !== null; chunk = await read()) parts.push(chunk);
      return parts.join('');
    },
    readLine: async () => {
      let line = '';
      let sawAny = false;
      for (;;) {
        const bytes = await next();
        if (bytes === null) break;
        sawAny = true;
        // Split on the raw 0x0A byte so what follows is held back as its
        // original bytes, a sequence straddling the newline intact.
        const newline = bytes.indexOf(0x0a);
        if (newline >= 0) {
          const rest = bytes.subarray(newline + 1);
          if (rest.length > 0) pushedBack.unshift(rest);
          line += decoder.decode(bytes.subarray(0, newline), { stream: true });
          return line + decoder.decode();
        }
        line += decoder.decode(bytes, { stream: true });
      }
      // A trailing incomplete sequence still surfaces as U+FFFD at the end.
      const tail = decoder.decode();
      line += tail;
      return sawAny || tail.length > 0 ? line : null;
    },
    // Whatever has been delivered, capped at maxLength: a bound, never a fill target.
    readBytes: async (maxLength: number) => {
      if (maxLength <= 0) return new Uint8Array(0);
      const bytes = await next();
      if (bytes === null || bytes.length <= maxLength) return bytes;
      pushedBack.unshift(bytes.subarray(maxLength));
      return bytes.subarray(0, maxLength);
    },
  };
}
