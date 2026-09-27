import { z } from 'zod/v4';
type WireScalar = string | number | boolean | null | undefined;
export type WireEncoded = WireScalar | WireEncoded[] | {
    [key: string]: WireEncoded;
};
export type WireDecoded = WireScalar | Uint8Array | WireDecoded[] | {
    [key: string]: WireDecoded;
};
export declare const WireEncoder: z.ZodType<WireEncoded>;
export declare const WireDecoder: z.ZodType<WireDecoded>;
export {};
//# sourceMappingURL=wire-codec.d.ts.map