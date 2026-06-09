export declare function findHtmlScriptEntrypoint(html: string): Promise<string | undefined>;
export declare function rewriteViteBuildHtml(html: string, options: {
    jsFilename: string;
    cssFilename?: string;
    removeImportMap?: boolean;
}): Promise<string>;
//# sourceMappingURL=html-entrypoint.d.ts.map