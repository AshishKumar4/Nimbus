const SCRIPT_ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
export async function findHtmlScriptEntrypoint(html) {
    if (typeof HTMLRewriter !== 'function')
        return undefined;
    let entrypoint;
    const rewriter = new HTMLRewriter().on('script[src]', {
        element(element) {
            if (entrypoint)
                return;
            const src = element.getAttribute('src');
            if (src && isScriptEntrypoint(src))
                entrypoint = src;
        },
    });
    await rewriter.transform(new Response(html)).text();
    return entrypoint;
}
export async function rewriteViteBuildHtml(html, options) {
    if (typeof HTMLRewriter !== 'function')
        return html;
    const rewriter = new HTMLRewriter()
        .on('script', {
        element(element) {
            const type = element.getAttribute('type') || '';
            if (options.removeImportMap && type.toLowerCase() === 'importmap') {
                element.remove();
                return;
            }
            const src = element.getAttribute('src');
            if (src && isScriptEntrypoint(src)) {
                element.setAttribute('src', `/assets/${options.jsFilename}`);
            }
        },
    })
        .on('link[href]', {
        element(element) {
            if (!options.cssFilename)
                return;
            const href = element.getAttribute('href');
            if (!href || !isCssAsset(href))
                return;
            element.setAttribute('rel', 'stylesheet');
            element.setAttribute('crossorigin', '');
            element.setAttribute('href', `/assets/${options.cssFilename}`);
        },
    });
    return await rewriter.transform(new Response(html)).text();
}
function isScriptEntrypoint(src) {
    const path = src.split('?', 1)[0].split('#', 1)[0];
    return SCRIPT_ENTRY_EXTENSIONS.some((ext) => path.endsWith(ext));
}
function isCssAsset(href) {
    return href.split('?', 1)[0].split('#', 1)[0].endsWith('.css');
}
