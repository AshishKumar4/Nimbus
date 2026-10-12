import { type Awaitable } from './vfs.js';
type Link = () => Awaitable<string>;
type Lookup = (path: string, final: boolean, components: readonly string[], index: number) => Awaitable<Link | null>;
type SyncLookup = (path: string, final: boolean, components: readonly string[], index: number) => (() => string) | null;
/** Physical component order: a link expands before a following `..`; the root cannot be left. */
export declare function walkVfsPath(input: string, lookup: SyncLookup, loop: () => never): string;
export declare function walkVfsPath(input: string, lookup: Lookup, loop: () => never): Awaitable<string>;
export {};
//# sourceMappingURL=path-walk.d.ts.map