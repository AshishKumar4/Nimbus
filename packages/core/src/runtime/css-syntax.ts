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

import parse from 'css-tree/parser';
import generate, { type GenerateHandlers } from 'css-tree/generator';
import walk from 'css-tree/walker';
import * as T from 'css-tree/tokenizer';
import { ident, string as cssString, url as cssUrl } from 'css-tree/utils';
import type { CssList, CssListItem, CssNode } from 'css-tree/types';

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
  nodes: { node: CssNode; role: Role }[];
  warnings: CssWarning[];
  /** Layer names the sheet orders before its first `@import`, and from there on. */
  layersPreImport: string[][];
  layersPostImport: string[][];
  /** Legal comments (`/*!`, or naming `@license` or `@preserve`), as written. */
  legal: string[];
  hasCharset: boolean;
}

const OPEN: Record<number, number> = {
  [T.Function]: T.RightParenthesis,
  [T.LeftParenthesis]: T.RightParenthesis,
  [T.LeftSquareBracket]: T.RightSquareBracket,
  [T.LeftCurlyBracket]: T.RightCurlyBracket,
};

/** `source`'s component values, offsets counted from `base`. */
export function componentsOf(source: string, base = 0): Component[] {
  const root: Component[] = [];
  const stack: { list: Component[]; close: number }[] = [{ list: root, close: -1 }];
  const open: Component[] = [];
  T.tokenize(source, (type, start, end) => {
    if (type === T.EOF) return;
    const top = stack[stack.length - 1];
    if (type === top.close && stack.length > 1) {
      stack.pop();
      open.pop()!.end = base + end;
      return;
    }
    const component: Component = { type, text: source.slice(start, end), at: base + start, end: base + end };
    top.list.push(component);
    const close = OPEN[type];
    if (close !== undefined) {
      component.children = [];
      stack.push({ list: component.children, close });
      open.push(component);
    }
  });
  // A bracket left open runs to the end, as the tokenizer reads it.
  for (const component of open) component.end = base + source.length;
  return root;
}

const insignificant = (c: Component) => c.type === T.WhiteSpace || c.type === T.Comment;

/** A component's value: decoded for names, strings and URLs, as written otherwise. */
function valueOf(c: Component): string {
  switch (c.type) {
    case T.Ident: return ident.decode(c.text);
    case T.Function: return ident.decode(c.text.slice(0, -1)).toLowerCase();
    case T.AtKeyword: return ident.decode(c.text.slice(1));
    case T.Hash: return ident.decode(c.text.slice(1));
    case T.String: return cssString.decode(c.text);
    case T.Url: return cssUrl.decode(c.text);
    default: return c.text;
  }
}

/** esbuild's TokensEqualIgnoringWhitespace: equal kinds and values, whitespace and comments aside. */
export function componentsEqual(a: readonly Component[], b: readonly Component[]): boolean {
  const x = a.filter((c) => !insignificant(c));
  const y = b.filter((c) => !insignificant(c));
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i].type !== y[i].type || valueOf(x[i]) !== valueOf(y[i])) return false;
    if (Boolean(x[i].children) !== Boolean(y[i].children)) return false;
    if (x[i].children && !componentsEqual(x[i].children!, y[i].children!)) return false;
  }
  return true;
}

/** esbuild's choice of quote for a string (bestQuoteCharForString): the one needing fewer escapes, `"` on a tie. */
function bestQuote(text: string, url: boolean): '"' | "'" | '' {
  let none = 0;
  let single = 2;
  let double = 2;
  for (const c of text) {
    if (c === "'") { none++; single++; }
    else if (c === '"') { none++; double++; }
    else if (c === '(' || c === ')' || c === ' ' || c === '\t') none++;
    else if (c === '\\' || c === '\n' || c === '\r' || c === '\f') { none++; single++; double++; }
  }
  if (url && none < single && none < double) return '';
  return single < double ? "'" : '"';
}

/** `text` quoted with `quote` (none: as a bare url()), escaped as esbuild escapes it. */
function quoted(text: string, quote: '"' | "'" | ''): string {
  let out = quote;
  const chars = [...text];
  chars.forEach((c, i) => {
    if (c === '\0' || c === '\r' || c === '\n' || c === '\f') {
      out += '\\' + c.codePointAt(0)!.toString(16) + (/^[0-9a-fA-F\s]/.test(chars[i + 1] ?? '') ? ' ' : '');
    } else if (c === '\\' || c === quote || (quote === '' && (c === '(' || c === ')' || c === ' ' || c === '\t' || c === '"' || c === "'"))) {
      out += '\\' + c;
    } else {
      out += c;
    }
  });
  return out + quote;
}

/** A string as esbuild prints one. */
export const quoteString = (text: string) => quoted(text, bestQuote(text, false));

/**
 * A url() as esbuild prints one: unquoted where that is shortest, quoted
 * always for a path the bundle wrote (an emitted file's), as esbuild does.
 */
export const printUrl = (url: string, alwaysQuoted: boolean) => `url(${quoted(url, bestQuote(url, !alwaysQuoted))})`;

/**
 * Components as esbuild prints them: comments dropped, a run of whitespace
 * one space, none just inside a function or block, before a comma, or (when
 * minifying) after one; strings and URLs quoted esbuild's way.
 */
export function printComponents(components: readonly Component[], minify: boolean): string {
  let out = '';
  let pendingSpace = false;
  let afterComma = false;
  for (const c of components) {
    if (insignificant(c)) {
      if (c.type === T.WhiteSpace) pendingSpace = true;
      continue;
    }
    if (out && pendingSpace && c.type !== T.Comma && !(afterComma && minify)) out += ' ';
    pendingSpace = false;
    afterComma = c.type === T.Comma;
    const urlArgument = c.type === T.Function && valueOf(c) === 'url' ? trim(c.children ?? []) : [];
    if (c.type === T.String) out += quoteString(valueOf(c));
    else if (c.type === T.Url) out += printUrl(valueOf(c), false);
    // `url("x")` is a url() like `url(x)`, and prints as one.
    else if (urlArgument.length === 1 && urlArgument[0].type === T.String) out += printUrl(valueOf(urlArgument[0]), false);
    else if (c.children) out += c.text + printComponents(trim(c.children), minify) + closing(c);
    else out += c.text;
  }
  return out;
}

function closing(c: Component): string {
  return c.type === T.LeftSquareBracket ? ']' : c.type === T.LeftCurlyBracket ? '}' : ')';
}

const trim = (components: readonly Component[]) => {
  let start = 0;
  let end = components.length;
  while (start < end && insignificant(components[start])) start++;
  while (end > start && insignificant(components[end - 1])) end--;
  return components.slice(start, end);
};

const isNamed = (c: Component | undefined, name: string, types: number[]) =>
  c !== undefined && types.includes(c.type) && (c.type === T.Function ? valueOf(c) : valueOf(c).toLowerCase()) === name;

/** An `@import`'s prelude: its URL and conditions, or null when it names no URL. */
function importOf(prelude: Component[]): ImportRule | null {
  const parts = trim(prelude);
  const first = parts[0];
  let path: string | null = null;
  let at = 0;
  let length = 0;
  if (first?.type === T.String) {
    path = valueOf(first);
    at = first.at;
    length = first.text.length;
  } else if (first?.type === T.Url) {
    path = valueOf(first);
    at = first.at;
    length = first.text.length;
  } else if (first && isNamed(first, 'url', [T.Function])) {
    // `url("...")`: exactly one string, as esbuild's parseURLOrString takes it.
    const args = trim(first.children ?? []);
    if (args.length === 1 && args[0].type === T.String) {
      path = valueOf(args[0]);
      at = args[0].at;
      length = args[0].text.length;
    }
  }
  if (path === null) return null;
  let rest = trim(parts.slice(1));
  const conditions: ImportConditions = { layers: [], supports: [], media: [] };
  if (isNamed(rest[0], 'layer', [T.Ident, T.Function])) {
    conditions.layers = [rest[0]];
    rest = trim(rest.slice(1));
  }
  if (isNamed(rest[0], 'supports', [T.Function])) {
    conditions.supports = [rest[0]];
    rest = trim(rest.slice(1));
  }
  conditions.media = rest;
  const any = conditions.layers.length || conditions.supports.length || conditions.media.length;
  return { path, at, length, conditions: any ? conditions : null };
}

/** The decoded, lower-cased name of an at-rule node. */
export const atRuleName = (node: CssNode) => ident.decode(node.name ?? '').toLowerCase();

/** A node's source text. */
const sourceOf = (source: string, node: CssNode) => source.slice(node.loc!.start.offset, node.loc!.end.offset);

const isLegalComment = (text: string) => text.startsWith('!') || /@(license|preserve)\b/.test(text);

/** Layer names an `@layer` prelude lists, each split at its dots. */
function layerNames(source: string, node: CssNode): string[][] {
  if (!node.prelude) return [];
  const names: string[][] = [];
  let current: string[] = [];
  for (const c of componentsOf(sourceOf(source, node.prelude))) {
    if (c.type === T.Ident) current.push(valueOf(c));
    else if (c.type === T.Comma) {
      if (current.length) names.push(current);
      current = [];
    }
  }
  if (current.length) names.push(current);
  return names;
}

/** Parses a stylesheet. Throws on nothing: what css-tree cannot parse it keeps as written. */
export function parseSheet(source: string): ParsedSheet {
  const legal: string[] = [];
  const ast = parse(source, {
    positions: true,
    onComment(value) {
      if (isLegalComment(value)) legal.push(`/*${value}*/`);
    },
  });
  const sheet: ParsedSheet = { source, ast, imports: [], nodes: [], warnings: [], layersPreImport: [], layersPostImport: [], legal, hasCharset: false };

  // The cascade layers named anywhere, in order, prefixed by the layers they
  // sit in; nothing inside an anonymous layer (esbuild's recordAtLayerRule).
  const record = (names: string[][], enclosing: string[]) => {
    for (const name of names) sheet.layersPostImport.push([...enclosing, ...name]);
  };
  const visitLayers = (nodes: readonly CssNode[], enclosing: string[], anonymous: number) => {
    for (const node of nodes) {
      if (node.type !== 'Atrule' && node.type !== 'Rule') continue;
      let inner = enclosing;
      let innerAnonymous = anonymous;
      if (node.type === 'Atrule' && atRuleName(node) === 'layer') {
        const names = layerNames(source, node);
        if (!anonymous && (node.block ? names.length <= 1 : names.length >= 1)) record(names, enclosing);
        if (node.block) {
          if (names.length === 1) inner = [...enclosing, ...names[0]];
          else innerAnonymous++;
        }
      }
      if (node.type === 'Atrule' && atRuleName(node) === 'import') continue;
      visitLayers(node.block?.children?.toArray() ?? [], inner, innerAnonymous);
    }
  };

  // esbuild's parseListOfRules: `@import` is in effect only before any rule
  // but `@charset` and `@layer` statements, and no `@layer` statement once an
  // `@import` has been seen.
  let importsValid = true;
  ast.children!.forEach((node) => {
    if (node.type === 'Comment') return;
    const name = node.type === 'Atrule' ? atRuleName(node) : '';
    if (name === 'charset') {
      sheet.hasCharset = true;
      sheet.nodes.push({ node, role: 'charset' });
      return;
    }
    if (name === 'import') {
      if (!importsValid) {
        sheet.warnings.push({ text: 'All "@import" rules must come first', at: node.loc!.start.offset, length: node.name!.length + 1 });
        sheet.nodes.push({ node, role: 'rule' });
        return;
      }
      const parts = componentsOf(sourceOf(source, node), node.loc!.start.offset).slice(1);
      const block = parts.find((c) => c.type === T.LeftCurlyBracket);
      const prelude = parts.filter((c) => c !== block && c.type !== T.Semicolon);
      const rule = block ? null : importOf(prelude);
      if (!rule) {
        // Malformed: kept as written, never followed; the imports after it are not in effect.
        const found = block ?? trim(prelude)[0];
        // esbuild places a missing `;` right after the token before it.
        const beforeBlock = trim(prelude).at(-1);
        sheet.warnings.push(block
          ? { text: 'Expected ";"', at: beforeBlock?.end ?? block.at, length: 0 }
          : found
            ? { text: `Expected URL token but found ${JSON.stringify(found.children ? found.text : source.slice(found.at, found.end))}`, at: found.at, length: found.text.length }
            : { text: 'Expected URL token but found end of file', at: node.loc!.end.offset, length: 0 });
        sheet.nodes.push({ node, role: 'rule' });
        importsValid = false;
        return;
      }
      if (sheet.imports.length === 0) {
        sheet.layersPreImport = sheet.layersPostImport;
        sheet.layersPostImport = [];
      }
      sheet.imports.push(rule);
      sheet.nodes.push({ node, role: 'import' });
      return;
    }
    visitLayers([node], [], 0);
    if (name === 'layer' && !node.block && sheet.imports.length === 0) {
      sheet.nodes.push({ node, role: 'pre-import-layer' });
      return;
    }
    importsValid = false;
    sheet.nodes.push({ node, role: 'rule' });
  });
  return sheet;
}

/** The top-level nodes a sheet prints where it is bundled. */
function printedNodes(sheet: ParsedSheet): CssNode[] {
  // The `@layer` statements before its first `@import` the bundle orders by itself.
  return sheet.nodes
    .filter(({ role }) => role === 'rule' || (role === 'pre-import-layer' && sheet.imports.length === 0))
    .map(({ node }) => node);
}

/**
 * The rules a sheet contributes where it is bundled, each printed: all but
 * its `@charset`, the `@import`s in effect, and (when it has any) the
 * `@layer` statements before them. Comments are dropped. `rewriteUrl` gives
 * each url() its URL first; it changes the sheet's nodes, so a sheet is
 * printed once.
 */
export function sheetRules(sheet: ParsedSheet, rewriteUrl?: (url: string) => { url: string; written: boolean }): string[] {
  return printedNodes(sheet).map((node) => print(sheet.source, node, rewriteUrl));
}

/** A url() in a sheet's rules: its URL, where its token is, and where the URL is inside it (for diagnostics). */
export interface SheetUrl {
  url: string;
  at: number;
  length: number;
  innerAt: number;
  innerLength: number;
}

/** Every url() a sheet's rules print, in order: what sheetRules rewrites. */
export function sheetUrls(sheet: ParsedSheet): SheetUrl[] {
  return printedNodes(sheet).flatMap((node) => urlSites(sheet.source, node).map(({ site }) => site));
}

/**
 * The url()s in a node the bundle prints, each with a setter for its printed
 * form: a parsed value's Url node, or a url token (or `url("...")` with one
 * string) among the tokens of what css-tree keeps as written, a custom
 * property's value or a declaration it could not parse, as esbuild finds
 * url tokens anywhere in a declaration. Not in an at-rule's prelude (esbuild
 * does not load those), and not in an `@import` kept as written. Discovery
 * (sheetUrls) and printing (print) both go through here, so a url() is
 * loaded exactly when it is printed.
 */
function urlSites(source: string, node: CssNode): { site: SheetUrl; write(text: string): void }[] {
  const sites: { site: SheetUrl; write(text: string): void }[] = [];
  walk(node, function (this: { atrule?: CssNode | null; atrulePrelude?: CssNode | null }, inner: CssNode) {
    if (inner.type === 'Atrule' && atRuleName(inner) === 'import') return walk.skip;
    // An at-rule's prelude, parsed or kept as written (an unknown at-rule's
    // Raw): css-tree's prelude context covers only a parsed one. Its block is walked.
    if (this.atrule?.prelude === inner) return walk.skip;
    if (this.atrulePrelude || !inner.loc) return;
    if (inner.type === 'Url') {
      const text = sourceOf(source, inner);
      const innerStart = /^url\(\s*/i.exec(text)?.[0].length ?? 0;
      sites.push({
        site: {
          url: inner.value!, at: inner.loc.start.offset, length: text.length,
          innerAt: inner.loc.start.offset + innerStart, innerLength: text.replace(/\s*\)$/, '').length - innerStart,
        },
        write(printed) {
          inner.type = 'Raw';
          inner.value = printed;
        },
      });
    } else if (inner.type === 'Raw') {
      const raw = inner;
      const original = raw.value!;
      const base = raw.loc!.start.offset;
      const replacements: { start: number; end: number; text: string }[] = [];
      const visit = (components: readonly Component[]) => {
        for (const c of components) {
          const args = c.type === T.Function && valueOf(c) === 'url' ? trim(c.children ?? []) : [];
          const value = c.type === T.Url ? c : args.length === 1 && args[0].type === T.String ? args[0] : null;
          if (value) {
            sites.push({
              site: { url: valueOf(value), at: c.at, length: c.end - c.at, innerAt: value.at, innerLength: value.end - value.at },
              write(printed) {
                replacements.push({ start: c.at - base, end: c.end - base, text: printed });
                let out = original;
                for (const r of [...replacements].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
                raw.value = out;
              },
            });
          } else if (c.children) {
            visit(c.children);
          }
        }
      };
      visit(componentsOf(original, base));
    }
  });
  return sites;
}

/**
 * One node printed: comments dropped, url()s rewritten and quoted as esbuild
 * quotes them, at-rule preludes printed from their tokens as esbuild prints
 * them (css-tree's generator would respace them), an `@import` kept as
 * written printed from its tokens as esbuild prints an unknown at-rule.
 */
function print(source: string, node: CssNode, rewriteUrl?: (url: string) => { url: string; written: boolean }): string {
  if (node.type === 'Atrule' && atRuleName(node) === 'import') return printUnknownAtRule(source, node);
  for (const { site, write } of urlSites(source, node)) {
    const { url, written } = rewriteUrl ? rewriteUrl(site.url) : { url: site.url, written: false };
    write(printUrl(url, written));
  }
  walk(node, (inner: CssNode, item: CssListItem | null, list: CssList | null) => {
    if (inner.type === 'Comment' && item && list) list.remove(item);
    else if (inner.type === 'Atrule' && inner.prelude?.loc) {
      inner.prelude = { type: 'Raw', value: ' ' + printComponents(componentsOf(sourceOf(source, inner.prelude)), true) };
    }
  });
  return generate(node, { decorator: spaceAfterUrl });
}

/** An at-rule from its tokens, as esbuild prints one it does not know: `@name prelude;` or `@name prelude{block}`. */
function printUnknownAtRule(source: string, node: CssNode): string {
  const [keyword, ...rest] = componentsOf(sourceOf(source, node), node.loc!.start.offset);
  const block = rest.find((c) => c.type === T.LeftCurlyBracket);
  const prelude = printComponents(trim(rest.filter((c) => c !== block && c.type !== T.Semicolon)), true);
  return `${keyword.text}${prelude ? ' ' + prelude : ''}${block ? `{${printComponents(trim(block.children ?? []), true)}}` : ';'}`;
}

const AFTER_URL_SPACED = new Set([T.Ident, T.Function, T.Url, T.String, T.Number, T.Dimension, T.Percentage, T.Hash]);

/**
 * css-tree writes no space between a url() and the value after it
 * (`url(a.png)no-repeat`), which CSS allows but esbuild never writes and
 * older parsers trip on: keep one there.
 */
function spaceAfterUrl(handlers: GenerateHandlers): GenerateHandlers {
  const tokenBefore = handlers.tokenBefore;
  handlers.tokenBefore = (prevCode, type, value) => {
    const next = tokenBefore(prevCode, type, value);
    return prevCode >> 1 === T.Url && AFTER_URL_SPACED.has(type) ? next | 1 : next;
  };
  return handlers;
}
