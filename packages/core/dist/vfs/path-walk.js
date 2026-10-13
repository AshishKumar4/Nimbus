import { andThen } from './vfs.js';
/** Mutations name an entry first; a final slash constrains its type without following it. */
export function entryVfsPath(input) {
    let end = input.length;
    while (end > 0 && input.charCodeAt(end - 1) === 47)
        end--;
    return { path: end === 0 ? '/' : input.slice(0, end), directory: end < input.length };
}
export function walkVfsPath(input, lookup, loop, options) {
    const walk = (components, hops, resolved = []) => {
        const step = (index) => {
            for (; index < components.length; index++) {
                const component = components[index];
                if (component === '' || component === '.')
                    continue;
                if (component === '..') {
                    resolved.pop();
                    continue;
                }
                resolved.push(component);
                const at = index;
                const link = lookup(`/${resolved.join('/')}`, at === components.length - 1, components, at);
                if (link !== null) {
                    const expand = (read) => {
                        if (hops >= 40)
                            return loop();
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
