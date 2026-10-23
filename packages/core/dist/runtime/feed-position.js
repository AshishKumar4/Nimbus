/**
 * Where a reader of a namespace's change feeds stands (CompositeFeed): the
 * mount table as its principal saw it, and each fed mount's epoch and
 * cursor by its mount point, the root's at '/'. One position for every
 * reader and every answer: the session's list pages and acquire answers, a
 * process's store, the asks it makes and the deliveries that answer for it.
 *
 * Its feeds are opaque: the root's is read through rootOf (what a SQLite
 * revision, a lease or a certificate is compared with), a mount's through
 * feedOf, and only the composite reads them whole (feedsOf). So nothing that
 * compares the root reads anything but the root's feed.
 */
import { objectHasOwn, objectKeys, SafeWeakMap, stringCharCodeAt, stringSlice, stringStartsWith, TypeError } from '../_shared/primordials.js';
/** The root's mount point: its feed is the SQLite namespace's. */
export const ROOT_FEED = '/';
export function positionOf(table, feeds) {
    return { table, feeds: feeds };
}
/** Every feed of `position`, by mount point: the composite's, which reads them all. */
export function feedsOf(position) {
    return position.feeds;
}
/** The feed of the mount at `point`, or undefined where `position` holds none. */
export function feedOf(position, point) {
    const feeds = feedsOf(position);
    return objectHasOwn(feeds, point) ? feeds[point] : undefined;
}
/** The root's feed: every position has one. */
export function rootOf(position) {
    const root = feedOf(position, ROOT_FEED);
    if (root === undefined)
        throw new TypeError('a feed position holds no root');
    return root;
}
/** Whether `value` is a position as it crosses an RPC (a table, and a root feed among its feeds). */
export function isFeedPosition(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const { table, feeds } = value;
    if (typeof table !== 'string' || feeds === null || typeof feeds !== 'object')
        return false;
    const points = objectKeys(feeds);
    for (let i = 0; i < points.length; i++) {
        const feed = feeds[points[i]];
        if (feed === null || typeof feed !== 'object' || typeof feed.epoch !== 'string' || typeof feed.cursor !== 'number')
            return false;
    }
    return objectHasOwn(feeds, ROOT_FEED);
}
/** Whether two positions are the same place: the same table, and every feed at the same epoch and cursor. */
export function samePosition(a, b) {
    if (a.table !== b.table)
        return false;
    const x = feedsOf(a);
    const y = feedsOf(b);
    const points = objectKeys(x);
    if (points.length !== objectKeys(y).length)
        return false;
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (!objectHasOwn(y, point) || x[point].epoch !== y[point].epoch || x[point].cursor !== y[point].cursor)
            return false;
    }
    return true;
}
/** The mounts of `position`'s feeds but the root's, read once a position (a store asks at every call that finds a path's feed). */
const mountPoints = new SafeWeakMap();
function mountPointsOf(position) {
    let points = mountPoints.get(position.feeds);
    if (points === undefined) {
        const all = objectKeys(feedsOf(position));
        const found = [];
        for (let i = 0; i < all.length; i++) {
            if (all[i] !== ROOT_FEED)
                found[found.length] = { point: all[i], name: stringSlice(all[i], 1), first: stringCharCodeAt(all[i], 1) };
        }
        points = found;
        mountPoints.set(position.feeds, points);
    }
    return points;
}
/** The point of the feed `key` (a path, with or without its leading slash) is under in `position`: its deepest fed mount at or above it. */
export function feedPointOf(position, key) {
    const points = mountPointsOf(position);
    if (points.length === 0)
        return ROOT_FEED;
    // Compared from where the key's first name starts: no path is made for it.
    const at = key.length > 0 && stringCharCodeAt(key, 0) === 0x2f ? 1 : 0;
    const first = stringCharCodeAt(key, at);
    const rest = key.length - at;
    let found = null;
    for (let i = 0; i < points.length; i++) {
        const mount = points[i];
        const length = mount.name.length;
        if (mount.first !== first || rest < length || (found !== null && length <= found.name.length))
            continue;
        if ((rest === length || stringCharCodeAt(key, at + length) === 0x2f) && stringStartsWith(key, mount.name, at))
            found = mount;
    }
    return found === null ? ROOT_FEED : found.point;
}
/**
 * Whether `position` is at or before `held`: the same table, and each of
 * its feeds held at the same epoch and a cursor no later. Answers of one
 * table move every feed forward together, so one that is not at or before
 * the store's cursor is after it.
 */
export function notAfter(position, held) {
    if (position.table !== held.table)
        return false;
    const feeds = feedsOf(position);
    const points = objectKeys(feeds);
    for (let i = 0; i < points.length; i++) {
        const had = feedOf(held, points[i]);
        if (had === undefined || had.epoch !== feeds[points[i]].epoch || had.cursor < feeds[points[i]].cursor)
            return false;
    }
    return true;
}
/**
 * The revision an entry at `key` of an answer at `position` is news above,
 * against the store's `held` cursor: its feed's cursor in `held`, where
 * `held` has that feed at the answer's epoch (the same table); else -1,
 * every revision news.
 */
export function floorFor(position, held, key) {
    if (position.table !== held.table)
        return -1;
    const point = feedPointOf(position, key);
    const mine = feedOf(position, point);
    const had = feedOf(held, point);
    return mine !== undefined && had !== undefined && had.epoch === mine.epoch ? had.cursor : -1;
}
/** Whether `a` and `b` are of one incarnation: the same table, and every feed of each at the same epoch in the other. */
export function sameEpochs(a, b) {
    if (a.table !== b.table)
        return false;
    const x = feedsOf(a);
    const y = feedsOf(b);
    const points = objectKeys(x);
    if (points.length !== objectKeys(y).length)
        return false;
    for (let i = 0; i < points.length; i++) {
        if (!objectHasOwn(y, points[i]) || x[points[i]].epoch !== y[points[i]].epoch)
            return false;
    }
    return true;
}
/** The feed `key` is under in `position` (feedPointOf): the clock its revisions are of. */
export function feedFor(position, key) {
    return feedOf(position, feedPointOf(position, key)) ?? rootOf(position);
}
/** Whether a revision of `key` read at `a` and one read at `b` are of one clock: the same feed for it in both, at the same epoch. */
export function sameClock(a, b, key) {
    // Both route it to one feed: a mount made over it since (or gone) is another clock, whatever the root's says.
    const point = feedPointOf(a, key);
    if (feedPointOf(b, key) !== point)
        return false;
    const x = feedOf(a, point);
    const y = feedOf(b, point);
    return x !== undefined && y !== undefined && x.epoch === y.epoch;
}
/** Whether a fed mount's point lies strictly beneath `key` (a path, with or without its leading slash) in `position`: a directory the namespace makes above it. */
export function abovePoint(position, key) {
    const path = key.length > 0 && stringCharCodeAt(key, 0) === 0x2f ? key : '/' + key;
    const under = path === '/' ? '/' : path + '/';
    const points = mountPointsOf(position);
    for (let i = 0; i < points.length; i++) {
        if (points[i].point.length > under.length && stringStartsWith(points[i].point, under))
            return true;
    }
    return false;
}
/** The root's epoch where `key` is the root feed's (a file there is dated by its revision on it), else null (a mount's: by its version). */
export function rootEpochFor(position, key) {
    return feedPointOf(position, key) === ROOT_FEED ? rootOf(position).epoch : null;
}
