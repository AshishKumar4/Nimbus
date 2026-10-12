import { andThen } from './vfs.js';
export function walkVfsPath(input, lookup, loop) {
    const walk = (components, hops) => {
        const resolved = [];
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
                        return andThen(read(), (target) => walk([
                            ...(target.startsWith('/') ? [] : resolved.slice(0, -1)),
                            ...target.split('/'),
                            ...components.slice(at + 1),
                        ], hops + 1));
                    };
                    return typeof link === 'function' ? expand(link)
                        : link.then((follow) => follow === null ? step(at + 1) : expand(follow));
                }
            }
            return `/${resolved.join('/')}`;
        };
        return step(0);
    };
    return walk(String(input).split('/'), 0);
}
