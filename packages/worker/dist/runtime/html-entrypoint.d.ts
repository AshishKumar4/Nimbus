export declare function findHtmlScriptEntrypoint(html: string): Promise<string | undefined>;
export declare function rewriteViteBuildHtml(html: string, options: {
    jsFilename: string;
    cssFilename?: string;
    removeImportMap?: boolean;
    /**
     * Vite injects `<link rel="stylesheet">` for CSS bundled through the
     * entry when index.html declares none (the create-vite template puts
     * all CSS behind `import './index.css'`). Set true to get that
     * behavior; when false, only an existing stylesheet link is rewritten.
     */
    injectCss?: boolean;
}): Promise<string>;
//# sourceMappingURL=html-entrypoint.d.ts.map