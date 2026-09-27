import { z } from 'zod/v4';

type WireScalar = string | number | boolean | null | undefined;
export type WireEncoded = WireScalar | WireEncoded[] | { [key: string]: WireEncoded };
export type WireDecoded = WireScalar | Uint8Array | WireDecoded[] | { [key: string]: WireDecoded };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]);
const bytes = z.object({ __nimbusWireType: z.literal('bytes'), base64: z.string() });

// Validation and conversion share a traversal; binary views are encoded without a validation copy.
export const WireEncoder: z.ZodType<WireEncoded> = z.lazy(() => z.union([
  scalar,
  z.instanceof(ArrayBuffer).transform((value) => ({
    __nimbusWireType: 'bytes', base64: bytesToBase64(new Uint8Array(value)),
  })),
  z.custom<ArrayBufferView>(ArrayBuffer.isView).transform((value) => ({
    __nimbusWireType: 'bytes', base64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
  })),
  z.array(WireEncoder),
  z.record(z.string(), WireEncoder).transform((record) => {
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    return record;
  }),
]));

export const WireDecoder: z.ZodType<WireDecoded> = z.lazy(() => z.union([
  bytes.transform((value) => base64ToBytes(value.base64)),
  scalar,
  z.array(WireDecoder),
  z.record(z.string(), WireDecoder),
]));
