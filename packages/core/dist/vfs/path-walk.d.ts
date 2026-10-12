import { type Awaitable } from './vfs.js';
type Link = () => Awaitable<string>;
type Lookup = (path: string, final: boolean, components: readonly string[], index: number) => Awaitable<Link | null>;
type SyncLookup = (path: string, final: boolean, components: readonly string[], index: number) => (() => string) | null;
export interface VfsWalkOptions {
    readonly start?: {
        readonly path: string;
        readonly hops: number;
    };
    /** Interpret every link target in the caller's view before expanding it. */
    readonly target?: (target: string) => string;
}
/** Physical component order: a link expands before a following `..`; the root cannot be left. */
export declare function walkVfsPath(input: string, lookup: SyncLookup, loop: () => never, options?: VfsWalkOptions): string;
export declare function walkVfsPath(input: string, lookup: Lookup, loop: () => never, options?: VfsWalkOptions): Awaitable<string>;
export {};
//# sourceMappingURL=path-walk.d.ts.map