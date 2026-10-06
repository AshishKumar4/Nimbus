import { z } from 'zod/v4';
import { base64, base64Decode } from './crypto.js';
const scalar = z.union([z.string(), z.custom((value) => typeof value === 'number'), z.boolean(), z.null(), z.undefined()]);
const record = z.custom((value) => typeof value === 'object' && value !== null
    && !Array.isArray(value) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value));
const bytes = z.custom((value) => typeof value === 'object' && value !== null
    && Object.hasOwn(value, '__nimbusWireType') && Object.hasOwn(value, 'base64')
    && '__nimbusWireType' in value && value.__nimbusWireType === 'bytes'
    && 'base64' in value && typeof value.base64 === 'string');
// Validation and conversion share a traversal; binary views are encoded without a validation copy.
export const WireEncoder = z.lazy(() => z.union([
    scalar,
    z.instanceof(ArrayBuffer).transform((value) => ({
        __nimbusWireType: 'bytes', base64: base64(new Uint8Array(value)),
    })),
    z.custom(ArrayBuffer.isView).transform((value) => ({
        __nimbusWireType: 'bytes', base64: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    })),
    z.array(WireEncoder),
    record.transform((value) => {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined)
                Object.defineProperty(out, key, {
                    value: WireEncoder.parse(item), enumerable: true, writable: true, configurable: true,
                });
        }
        return out;
    }),
]));
export const WireDecoder = z.lazy(() => z.union([
    bytes.transform((value) => base64Decode(value.base64)),
    scalar,
    z.array(WireDecoder),
    record.transform((value) => {
        const out = {};
        for (const [key, item] of Object.entries(value))
            Object.defineProperty(out, key, {
                value: WireDecoder.parse(item), enumerable: true, writable: true, configurable: true,
            });
        return out;
    }),
]));
