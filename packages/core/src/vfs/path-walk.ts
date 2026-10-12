import { andThen, type Awaitable } from './vfs.js';

type Link = () => Awaitable<string>;
type Lookup = (path: string, final: boolean, components: readonly string[], index: number) => Awaitable<Link | null>;
type SyncLookup = (path: string, final: boolean, components: readonly string[], index: number) => (() => string) | null;

export interface VfsWalkOptions {
  readonly start?: { readonly path: string; readonly hops: number };
  /** Interpret every link target in the caller's view before expanding it. */
  readonly target?: (target: string) => string;
}

/** Physical component order: a link expands before a following `..`; the root cannot be left. */
export function walkVfsPath(input: string, lookup: SyncLookup, loop: () => never, options?: VfsWalkOptions): string;
export function walkVfsPath(input: string, lookup: Lookup, loop: () => never, options?: VfsWalkOptions): Awaitable<string>;
export function walkVfsPath(input: string, lookup: Lookup, loop: () => never, options?: VfsWalkOptions): Awaitable<string> {
  const walk = (components: readonly string[], hops: number, resolved: string[] = []): Awaitable<string> => {
    const step = (index: number): Awaitable<string> => {
      for (; index < components.length; index++) {
        const component = components[index];
        if (component === '' || component === '.') continue;
        if (component === '..') { resolved.pop(); continue; }
        resolved.push(component);
        const at = index;
        const link = lookup(`/${resolved.join('/')}`, at === components.length - 1, components, at);
        if (link !== null) {
          const expand = (read: Link): Awaitable<string> => {
            if (hops >= 40) return loop();
            return andThen(read(), (text) => {
              const target = options?.target?.(text) ?? text;
              return walk([
                ...(target.startsWith('/') ? [] : resolved.slice(0, -1)),
                ...target.split('/'),
                ...components.slice(at + 1),
              ], hops + 1);
            });
          };
          return typeof link === 'function' ? expand(link)
            : link.then((follow) => follow === null ? step(at + 1) : expand(follow));
        }
      }
      return `/${resolved.join('/')}`;
    };
    return step(0);
  };
  return walk(String(input).split('/'), options?.start?.hops ?? 0, options?.start?.path.split('/').filter(Boolean));
}
