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
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder('utf-8');
  let offset = 0;

  const pull = (max: number): Uint8Array | null => {
    if (offset >= bytes.length) return null;
    const end = Math.min(offset + max, bytes.length);
    const chunk = bytes.subarray(offset, end);
    offset = end;
    return chunk;
  };

  return {
    readBytes: async (maxLength: number) => {
      if (maxLength <= 0) return new Uint8Array(0);
      return pull(maxLength);
    },
    read: async () => {
      while (offset < bytes.length) {
        const end = Math.min(offset + 65536, bytes.length);
        const text2 = decoder.decode(bytes.subarray(offset, end), { stream: true });
        offset = end;
        if (text2.length > 0) return text2;
      }
      const tail = decoder.decode();
      return tail.length > 0 ? tail : null;
    },
    readAll: async () => {
      if (offset >= bytes.length) return '';
      const out = decoder.decode(bytes.subarray(offset));
      offset = bytes.length;
      return out;
    },
    readLine: async () => {
      if (offset >= bytes.length) return null;
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        const line = decoder.decode(bytes.subarray(offset));
        offset = bytes.length;
        return line;
      }
      const line = decoder.decode(bytes.subarray(offset, newline));
      offset = newline + 1;
      return line;
    },
  };
}
