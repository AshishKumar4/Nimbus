declare const OPAQUE: unique symbol;
/** One feed's place: its epoch, and its cursor in that epoch; `fixed` where its tree never changes in that epoch (VfsChanges.fixed). */
export interface FeedCursor {
    readonly epoch: string;
    readonly cursor: number;
    readonly fixed?: true;
}
/** Each fed mount's FeedCursor by its point, read only through rootOf, feedOf and feedsOf. */
export interface FeedCursors {
    readonly [OPAQUE]: true;
}
export interface FeedPosition {
    readonly table: string;
    readonly feeds: FeedCursors;
}
/** The root's mount point: its feed is the SQLite namespace's. */
export declare const ROOT_FEED = "/";
export declare function positionOf(table: string, feeds: Readonly<Record<string, FeedCursor>>): FeedPosition;
/** Every feed of `position`, by mount point: the composite's, which reads them all. */
export declare function feedsOf(position: FeedPosition): Readonly<Record<string, FeedCursor>>;
/** The feed of the mount at `point`, or undefined where `position` holds none. */
export declare function feedOf(position: FeedPosition, point: string): FeedCursor | undefined;
/** The root's feed: every position has one. */
export declare function rootOf(position: FeedPosition): FeedCursor;
/** Whether `value` is a position as it crosses an RPC (a table, and a root feed among its feeds). */
export declare function isFeedPosition(value: unknown): value is FeedPosition;
/** Whether two positions are the same place: the same table, and every feed at the same epoch and cursor. */
export declare function samePosition(a: FeedPosition, b: FeedPosition): boolean;
/** The point of the feed `key` (a path, with or without its leading slash) is under in `position`: its deepest fed mount at or above it. */
export declare function feedPointOf(position: FeedPosition, key: string): string;
/**
 * Whether `position` is at or before `held`: the same table, and each of
 * its feeds held at the same epoch and a cursor no later. Answers of one
 * table move every feed forward together, so one that is not at or before
 * the store's cursor is after it.
 */
export declare function notAfter(position: FeedPosition, held: FeedPosition): boolean;
/**
 * The revision an entry at `key` of an answer at `position` is news above,
 * against the store's `held` cursor: its feed's cursor in `held`, where
 * `held` has that feed at the answer's epoch (the same table); else -1,
 * every revision news.
 */
export declare function floorFor(position: FeedPosition, held: FeedPosition, key: string): number;
/** Whether `a` and `b` are of one incarnation: the same table, and every feed of each at the same epoch in the other. */
export declare function sameEpochs(a: FeedPosition, b: FeedPosition): boolean;
/** The feed `key` is under in `position` (feedPointOf): the clock its revisions are of. */
export declare function feedFor(position: FeedPosition, key: string): FeedCursor;
/** Whether a revision of `key` read at `a` and one read at `b` are of one clock: the same feed for it in both, at the same epoch. */
export declare function sameClock(a: FeedPosition, b: FeedPosition, key: string): boolean;
/** Whether a fed mount's point lies strictly beneath `key` (a path, with or without its leading slash) in `position`: a directory the namespace makes above it. */
export declare function abovePoint(position: FeedPosition, key: string): boolean;
export {};
//# sourceMappingURL=feed-position.d.ts.map