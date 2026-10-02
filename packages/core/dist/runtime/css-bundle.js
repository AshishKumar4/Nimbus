/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet.
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands the chunk's CSS modules here,
 * in the chunk's module order (the order its imports run), to be joined as
 * esbuild joined them into the chunk's `.css` sidecar.
 *
 * A stylesheet that needs more than joining (`@import`, `url()`, minifying)
 * is refused by name until those are implemented to esbuild's rules: a
 * stylesheet that differs silently from the one esbuild produced is worse
 * than a loud error.
 */
export async function bundleCss(modules, _plugin, { minify }) {
    if (minify)
        throw new Error('minified CSS is not supported by Nimbus\'s bundler yet');
    const parts = [];
    for (const module of modules) {
        const body = stripComments(module.source);
        if (/@import\b/i.test(body))
            throw new Error(`${module.path}: CSS @import is not supported by Nimbus's bundler yet`);
        if (/\burl\(/i.test(body))
            throw new Error(`${module.path}: CSS url() is not supported by Nimbus's bundler yet`);
        parts.push(`/* ${module.path} */\n${module.source.trim()}\n`);
    }
    return parts.join('\n');
}
/** CSS without its comments; strings are kept whole. */
function stripComments(css) {
    let out = '';
    for (let i = 0; i < css.length;) {
        const c = css[i];
        if (c === '"' || c === "'") {
            const end = endOfString(css, i);
            out += css.slice(i, end);
            i = end;
        }
        else if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end < 0 ? css.length : end + 2;
        }
        else {
            out += c;
            i++;
        }
    }
    return out;
}
function endOfString(css, start) {
    const quote = css[start];
    let i = start + 1;
    while (i < css.length && css[i] !== quote && css[i] !== '\n')
        i += css[i] === '\\' ? 2 : 1;
    return Math.min(i + 1, css.length);
}
