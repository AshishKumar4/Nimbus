/**
 * A feed position as a process supplies it (FeedPosition): untrusted input,
 * checked where the session takes it (fsAcquire, a delivery's arguments, a
 * directory batch). Its table is the session's own mount-table signature,
 * which it only compares; its feeds are looked up by the namespace's own
 * mount points (CompositeFeed.since), the root's among them.
 */
import { z } from 'zod';
import { positionOf, ROOT_FEED } from './feed-position.js';

export const FeedPositionSchema = z.object({
  table: z.string(),
  feeds: z.record(z.string(), z.object({ epoch: z.string().max(64), cursor: z.number().int().min(0), fixed: z.literal(true).optional() }).strict())
    .refine((feeds) => Object.hasOwn(feeds, ROOT_FEED), 'a position holds the root\'s feed'),
}).strict().transform(({ table, feeds }) => positionOf(table, feeds));
