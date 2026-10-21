/**
 * A feed position as a process supplies it (FeedPosition): untrusted input,
 * checked where the session takes it (fsAcquire, a delivery's arguments, a
 * directory batch). Its table is the session's own mount-table signature,
 * which it only compares; its feeds are looked up by the namespace's own
 * mount points (CompositeFeed.since), the root's among them.
 */
import { z } from 'zod';
export declare const FeedPositionSchema: z.ZodPipe<z.ZodObject<{
    table: z.ZodString;
    feeds: z.ZodRecord<z.ZodString, z.ZodObject<{
        epoch: z.ZodString;
        cursor: z.ZodNumber;
        fixed: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodTransform<import("./feed-position.js").FeedPosition, {
    table: string;
    feeds: Record<string, {
        epoch: string;
        cursor: number;
        fixed?: true | undefined;
    }>;
}>>;
//# sourceMappingURL=feed-position-schema.d.ts.map