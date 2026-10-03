/**
 * css-syntax.ts — the CSS syntax Nimbus reads and writes, on css-tree 3
 * (its parser, generator, walker and tokenizer; never its lexer, so its MDN
 * grammar data stays out of every bundle).
 *
 * A stylesheet is parsed once into css-tree's AST. On top of it this module
 * answers what bundling needs and css-tree does not model, by esbuild
 * 0.24's rules (internal/css_parser): which `@import` rules are in effect
 * (only those before any rule but `@charset` and `@layer` statements, no
 * `@layer` statement once an `@import` has been seen), each one's URL and
 * conditions (`layer`, `layer(...)`, `supports(...)`, then a media query
 * list) as component values from css-tree's tokens, and the cascade layers
 * the sheet names before and after its first `@import`. A malformed `@import`
 * (no URL, a url() of anything but one string, a block) is never followed:
 * it is kept as written, with esbuild's warning, and ends the imports after
 * it. Rules print through css-tree's generator, which
 * keeps what whitespace and comments meant (`.x/**\/.y` stays one compound
 * selector, a no-break space stays a name character); conditions print as
 * esbuild 0.24 prints them, since a bundle writes them back.
 *
 * Used by css-bundle.ts (the built-in `vite build`'s stylesheets) and by the
 * Vite dev server's stylesheet serving.
 */
import type { CssNode } from 'css-tree/types';
/**
 * One component value of a prelude: a token, or a function or block with
 * the components inside it. `at` is its offset in the sheet's source.
 */
export interface Component {
    type: number;
    text: string;
    at: number;
    /** Where it ends in the sheet's source: a function's or block's closing bracket included. */
    end: number;
    /** A function's (`name(`) or a block's (`(`, `[`, `{`) contents. */
    children?: Component[];
}
/** An `@import`'s conditions, as esbuild splits them: at most one of each of the first two. */
export interface ImportConditions {
    layers: Component[];
    supports: Component[];
    media: Component[];
}
/** An `@import` in effect: its URL as written, where that URL is, and its conditions. */
export interface ImportRule {
    path: string;
    /** Offset and length of the URL's token in the source (a string's quotes, a url()'s `url(`, included). */
    at: number;
    length: number;
    conditions: ImportConditions | null;
}
/** What a top-level node is to the bundle: a rule it prints, or what it takes over. */
type Role = 'charset' | 'import' | 'pre-import-layer' | 'rule';
/** A warning about a sheet, as esbuild words and places it. */
export interface CssWarning {
    text: string;
    at: number;
    length: number;
}
export interface ParsedSheet {
    source: string;
    ast: CssNode;
    imports: ImportRule[];
    /** Each top-level node but comments, in order, with what it is to the bundle. */
    nodes: {
        node: CssNode;
        role: Role;
    }[];
    warnings: CssWarning[];
    /** Layer names the sheet orders before its first `@import`, and from there on. */
    layersPreImport: string[][];
    layersPostImport: string[][];
    /** Legal comments (`/*!`, or naming `@license` or `@preserve`), as written. */
    legal: string[];
    hasCharset: boolean;
}
/** `source`'s component values, offsets counted from `base`. */
export declare function componentsOf(source: string, base?: number): Component[];
/** esbuild's TokensEqualIgnoringWhitespace: equal kinds and values, whitespace and comments aside. */
export declare function componentsEqual(a: readonly Component[], b: readonly Component[]): boolean;
/** A string as esbuild prints one. */
export declare const quoteString: (text: string) => string;
/**
 * A url() as esbuild prints one: unquoted where that is shortest, quoted
 * always for a path the bundle wrote (an emitted file's), as esbuild does.
 */
export declare const printUrl: (url: string, alwaysQuoted: boolean) => string;
/**
 * Components as esbuild prints them: comments dropped, a run of whitespace
 * one space, none just inside a function or block, before a comma, or (when
 * minifying) after one; strings and URLs quoted esbuild's way.
 */
export declare function printComponents(components: readonly Component[], minify: boolean): string;
/** The decoded, lower-cased name of an at-rule node. */
export declare const atRuleName: (node: CssNode) => string;
/** Parses a stylesheet. Throws on nothing: what css-tree cannot parse it keeps as written. */
export declare function parseSheet(source: string): ParsedSheet;
/**
 * The rules a sheet contributes where it is bundled, each printed: all but
 * its `@charset`, the `@import`s in effect, and (when it has any) the
 * `@layer` statements before them. Comments are dropped. `rewriteUrl` gives
 * each url() its URL first; it changes the sheet's nodes, so a sheet is
 * printed once.
 */
export declare function sheetRules(sheet: ParsedSheet, rewriteUrl?: (url: string) => {
    url: string;
    written: boolean;
}): string[];
/** A url() in a sheet's rules: its URL, where its token is, and where the URL is inside it (for diagnostics). */
export interface SheetUrl {
    url: string;
    at: number;
    length: number;
    innerAt: number;
    innerLength: number;
}
/** Every url() a sheet's rules print, in order: what sheetRules rewrites. */
export declare function sheetUrls(sheet: ParsedSheet): SheetUrl[];
export {};
//# sourceMappingURL=css-syntax.d.ts.map