/**
 * rolldown-build.ts — esbuild's build contract (EsbuildBuildHost:
 * esbuild-shaped options and a remote resolve/load plugin), run by rolldown.
 *
 * Every Nimbus build serves its modules from a plugin (EsbuildService's VFS
 * plugin, the pre-bundle facet's slice plugin), so rolldown never reads a
 * file: each import goes to `plugin.resolve` with esbuild's arguments (path,
 * importer, namespace, resolveDir, kind) and each module to `plugin.load`,
 * whose esbuild-shaped answer (contents, loader, resolveDir, errors) becomes
 * rolldown's. esbuild keys a module on (namespace, path); here a module of the
 * plugin's main namespace keeps its path as its id, so names of outputs come
 * from files as esbuild's do, and any other namespace is `\0<ns>:<path>`.
 *
 * What a caller reads comes back as esbuild gave it: output files at
 * `outdir/<name>` (or `outfile`), the metafile subset callers read (each
 * output's `entryPoint`, `cssBundle`, `bytes`), diagnostics as `{ text,
 * location }`, and a failed build as esbuild's "Build failed with N errors:"
 * message, its diagnostics alongside. Options no caller uses are refused
 * rather than ignored. CSS is bundled by css-bundle.ts, as esbuild bundled it.
 *
 * The asset loaders are esbuild's: `file` emits the module's bytes under
 * `assetNames` and exports the path relative to the importing chunk,
 * `dataurl` exports a data URL (esbuild's encoding), `base64` the bytes in
 * base64, `text` the text, `binary` a Uint8Array.
 *
 * Self-contained but for types and css-bundle.ts: the build facet's runtime
 * bundles it (rolldown-facet/preamble.ts).
 */

import type * as esbuild from 'esbuild-wasm';
import type {
  EsbuildBuildOutcome,
  EsbuildHostBuildOptions,
  EsbuildRemotePlugin,
} from './esbuild-service.js';
import { bundleCss, CssError, percentEscapedDataUrl, type CssAssets, type CssModule } from './css-bundle.js';

/** The part of rolldown's JavaScript API a build uses. */
export interface RolldownApi {
  rolldown(options: Record<string, unknown>): Promise<{
    generate(options: Record<string, unknown>): Promise<{ output: RolldownOutput[] }>;
    close(): Promise<void>;
  }>;
}

type RolldownOutput =
  | { type: 'chunk'; fileName: string; name: string; code: string; isEntry: boolean; facadeModuleId: string | null; moduleIds: string[]; exports: string[]; map?: { toString(): string } | null }
  | { type: 'asset'; fileName: string; source: string | Uint8Array };

interface RolldownLog {
  code?: string;
  message: string;
  id?: string;
  loc?: { line: number; column: number; file?: string };
  plugin?: string;
}

/** esbuild options a Nimbus build may pass; anything else is refused. */
const SUPPORTED = new Set([
  'entryPoints', 'bundle', 'format', 'target', 'platform', 'outdir', 'outfile', 'sourcemap', 'minify', 'external',
  'define', 'globalName', 'tsconfigRaw', 'alias', 'keepNames', 'entryNames', 'chunkNames', 'assetNames', 'metafile',
  'conditions', 'mainFields', 'logLevel',
]);

const LOADER_MODULE_TYPES: Record<string, string> = {
  js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', json: 'json', text: 'text', empty: 'empty',
};

/** esbuild's MIME types by extension (internal/helpers/mime.go at v0.24.2). */
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.eot': 'application/vnd.ms-fontobject', '.otf': 'font/otf', '.sfnt': 'font/sfnt', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

/** One of Go's content-sniffing signatures (net/http/sniff.go): its MIME type, or '' when `data` does not match. */
type Sniff = (data: Uint8Array, firstNonWS: number) => string;
const bytesOfText = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const exactSig = (sig: string, ct: string): Sniff => {
  const pat = bytesOfText(sig);
  return (data) => (data.length >= pat.length && pat.every((b, i) => data[i] === b) ? ct : '');
};
const maskedSig = (mask: string, pat: string, ct: string, skipWS = false): Sniff => {
  const m = bytesOfText(mask);
  const p = bytesOfText(pat);
  return (data, firstNonWS) => {
    const d = skipWS ? data.subarray(firstNonWS) : data;
    return d.length >= p.length && p.every((b, i) => (d[i] & m[i]) === b) ? ct : '';
  };
};
const htmlSig = (sig: string): Sniff => (data, firstNonWS) => {
  const d = data.subarray(firstNonWS);
  if (d.length < sig.length + 1) return '';
  for (let i = 0; i < sig.length; i++) {
    const b = sig.charCodeAt(i);
    const db = b >= 0x41 && b <= 0x5a ? d[i] & 0xdf : d[i];
    if (b !== db) return '';
  }
  return d[sig.length] === 0x20 || d[sig.length] === 0x3e ? 'text/html; charset=utf-8' : '';
};
const mp4Sig: Sniff = (data) => {
  if (data.length < 12) return '';
  const boxSize = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  if (data.length < boxSize || boxSize % 4 !== 0) return '';
  if (String.fromCharCode(...data.subarray(4, 8)) !== 'ftyp') return '';
  for (let st = 8; st < boxSize; st += 4) {
    if (st === 12) continue;
    if (String.fromCharCode(...data.subarray(st, st + 3)) === 'mp4') return 'video/mp4';
  }
  return '';
};
const textSig: Sniff = (data, firstNonWS) => {
  for (const b of data.subarray(firstNonWS)) {
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) return '';
  }
  return 'text/plain; charset=utf-8';
};
const SNIFF_SIGNATURES: Sniff[] = [
  ...['<!DOCTYPE HTML', '<HTML', '<HEAD', '<SCRIPT', '<IFRAME', '<H1', '<DIV', '<FONT', '<TABLE', '<A', '<STYLE', '<TITLE', '<B', '<BODY', '<BR', '<P', '<!--'].map(htmlSig),
  maskedSig('\xFF\xFF\xFF\xFF\xFF', '<?xml', 'text/xml; charset=utf-8', true),
  exactSig('%PDF-', 'application/pdf'),
  exactSig('%!PS-Adobe-', 'application/postscript'),
  maskedSig('\xFF\xFF\x00\x00', '\xFE\xFF\x00\x00', 'text/plain; charset=utf-16be'),
  maskedSig('\xFF\xFF\x00\x00', '\xFF\xFE\x00\x00', 'text/plain; charset=utf-16le'),
  maskedSig('\xFF\xFF\xFF\x00', '\xEF\xBB\xBF\x00', 'text/plain; charset=utf-8'),
  exactSig('\x00\x00\x01\x00', 'image/x-icon'),
  exactSig('\x00\x00\x02\x00', 'image/x-icon'),
  exactSig('BM', 'image/bmp'),
  exactSig('GIF87a', 'image/gif'),
  exactSig('GIF89a', 'image/gif'),
  maskedSig('\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF', 'RIFF\x00\x00\x00\x00WEBPVP', 'image/webp'),
  exactSig('\x89PNG\x0D\x0A\x1A\x0A', 'image/png'),
  exactSig('\xFF\xD8\xFF', 'image/jpeg'),
  maskedSig('\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF', 'FORM\x00\x00\x00\x00AIFF', 'audio/aiff'),
  maskedSig('\xFF\xFF\xFF', 'ID3', 'audio/mpeg'),
  maskedSig('\xFF\xFF\xFF\xFF\xFF', 'OggS\x00', 'application/ogg'),
  maskedSig('\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF', 'MThd\x00\x00\x00\x06', 'audio/midi'),
  maskedSig('\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF', 'RIFF\x00\x00\x00\x00AVI ', 'video/avi'),
  maskedSig('\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF', 'RIFF\x00\x00\x00\x00WAVE', 'audio/wave'),
  mp4Sig,
  exactSig('\x1A\x45\xDF\xA3', 'video/webm'),
  maskedSig('\x00'.repeat(34) + '\xFF\xFF', '\x00'.repeat(34) + 'LP', 'application/vnd.ms-fontobject'),
  exactSig('\x00\x01\x00\x00', 'font/ttf'),
  exactSig('OTTO', 'font/otf'),
  exactSig('ttcf', 'font/collection'),
  exactSig('wOFF', 'font/woff'),
  exactSig('wOF2', 'font/woff2'),
  exactSig('\x1F\x8B\x08', 'application/x-gzip'),
  exactSig('PK\x03\x04', 'application/zip'),
  exactSig('Rar!\x1A\x07\x00', 'application/x-rar-compressed'),
  exactSig('Rar!\x1A\x07\x01\x00', 'application/x-rar-compressed'),
  exactSig('\x00\x61\x73\x6D', 'application/wasm'),
  textSig,
];

/** Go's http.DetectContentType (net/http/sniff.go, go1.23), which esbuild falls back on. */
function detectContentType(bytes: Uint8Array): string {
  const data = bytes.subarray(0, 512);
  let firstNonWS = 0;
  while (firstNonWS < data.length && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(data[firstNonWS])) firstNonWS++;
  for (const sig of SNIFF_SIGNATURES) {
    const ct = sig(data, firstNonWS);
    if (ct) return ct;
  }
  return 'application/octet-stream';
}

/** esbuild's guessMimeType: by extension, else by the bytes; `; ` written `;`. */
function guessMimeType(ext: string, bytes: Uint8Array): string {
  return (MIME_TYPES[ext] ?? MIME_TYPES[ext.toLowerCase()] ?? detectContentType(bytes)).replaceAll('; ', ';');
}

function extensionOf(path: string): string {
  const bare = path.replace(/[?#].*$/, '');
  const base = bare.slice(bare.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function base64Of(bytes: Uint8Array): string {
  let latin1 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(latin1);
}

/** esbuild's data URL of `bytes`: the shorter of base64 and percent-escaped text, every byte kept (a BOM too). */
export function dataUrlOf(path: string, bytes: Uint8Array): string {
  const mime = guessMimeType(extensionOf(path), bytes);
  const encoded = `data:${mime};base64,${base64Of(bytes)}`;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return encoded;
  }
  const escaped = percentEscapedDataUrl(mime, text);
  return escaped.length < encoded.length ? escaped : encoded;
}

/** esbuild's [hash]: eight base32 characters of the content's digest. */
async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return out;
}

/** esbuild's output name template filled in: `[name]`, `[hash]` and `[ext]`. */
function fill(template: string, { name, hash, ext }: { name: string; hash: string; ext: string }): string {
  return template.replace(/\[name\]/g, name).replace(/\[hash\]/g, hash).replace(/\[ext\]/g, ext);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** `to`, relative to the directory of `from` (both relative to the output root). */
function relativeUrl(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  return (up === 0 ? './' : '../'.repeat(up)) + toParts.slice(common).join('/');
}

/** What became of one module the plugin loaded, for its importers. */
interface Loaded {
  namespace: string;
  path: string;
  resolveDir: string;
  source: string;
  /** The parser's language for its source; absent for a module that is not script. */
  lang?: 'js' | 'jsx' | 'ts' | 'tsx';
}

/** An import that did not resolve: who imports what, how, and what the plugin said. */
interface Unresolved {
  importer: string | undefined;
  source: string;
  kind: string;
  text: string;
  pluginName: string;
}

/**
 * The JavaScript string literal (or template without substitutions) that
 * starts at `start`: where it ends and its value, escapes decoded. Null when
 * no literal starts there.
 */
function stringLiteralAt(source: string, start: number): { end: number; value: string } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === quote) return { end: i + 1, value };
    if (quote === '`' && c === '$' && source[i + 1] === '{') return null;
    if (c !== '\\') {
      value += c;
      continue;
    }
    const e = source[++i];
    const hex = (from: number, to: number) => String.fromCodePoint(parseInt(source.slice(from, to), 16));
    if (e === 'u' && source[i + 1] === '{') {
      const close = source.indexOf('}', i);
      value += hex(i + 2, close);
      i = close;
    } else if (e === 'u') {
      value += hex(i + 1, i + 5);
      i += 4;
    } else if (e === 'x') {
      value += hex(i + 1, i + 3);
      i += 2;
    } else if (e === '\r') {
      if (source[i + 1] === '\n') i++;
    } else if (e !== '\n' && e !== '\u2028' && e !== '\u2029') {
      value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' } as Record<string, string>)[e] ?? e;
    }
  }
  return null;
}

/**
 * Placement is a diagnostic on a build that already failed, so it is bounded
 * to stay small beside the binding's own memory: an importer larger than
 * this is not built again, nor any once a failed build has built this much.
 * Their errors name the file without a line, never a guessed one. Measured
 * in tests/unit/build-facet.mjs: a 3.2 MB importer is skipped (no growth); a
 * 256 KiB one grows the binding by a few MiB at most.
 */
const PLACEMENT_IMPORTER_BYTES = 256 * 1024;
const PLACEMENT_BUILD_BYTES = 1024 * 1024;

/** A specifier rolldown resolves as a package name (a warning when it fails) rather than a path (an error). */
const isBare = (specifier: string) => !/^(\.{1,2}(\/|$)|\/)/.test(specifier);

/**
 * Where each unresolved import is, as rolldown's own resolver places it.
 * The build left them external to go on (esbuild reports every one), so
 * each importer is built again alone, with the build's own input options
 * (platform, target, define, JSX: what decides which imports a module has),
 * its other imports external and these left unresolved: rolldown reports
 * each occurrence with its place, and only real ones (a call of a `require`
 * the code binds itself, or one in a branch a define makes dead, is no
 * import, to rolldown as to esbuild). esbuild reports the first occurrence
 * of each specifier and kind, at its string literal, column and length in
 * UTF-8 bytes. Nothing is parsed here: rolldown names the place, the pass
 * the kind, and the literal there its value and end. Runs after the build's
 * bundle is closed, within PLACEMENT_IMPORTER_BYTES and PLACEMENT_BUILD_BYTES.
 */
async function locateUnresolved(
  api: RolldownApi,
  options: EsbuildHostBuildOptions,
  records: readonly Unresolved[],
  loaded: ReadonlyMap<string, Loaded>,
): Promise<esbuild.Message[]> {
  const byImporter = new Map<string, Unresolved[]>();
  for (const record of records) if (record.importer) byImporter.set(record.importer, [...(byImporter.get(record.importer) ?? []), record]);
  const placed = new Map<Unresolved, esbuild.Location>();
  let spent = 0;
  for (const [importer, mine] of byImporter) {
    const module = loaded.get(importer);
    if (!module) continue;
    const fileOnly = { file: fileOf(module), namespace: '', line: 0, column: 0, length: 0, lineText: '', suggestion: '' };
    const bytes = utf8Length(module.source);
    if (!module.lang || bytes > PLACEMENT_IMPORTER_BYTES || spent + bytes > PLACEMENT_BUILD_BYTES) {
      for (const r of mine) placed.set(r, fileOnly);
      continue;
    }
    spent += bytes;
    // One pass per kind, and paths apart from package names: a reported place
    // belongs to the pass's kind, and rolldown stops at a path's error before
    // it warns of a package.
    const groups = new Map<string, Unresolved[]>();
    for (const r of mine) {
      const group = `${r.kind}\0${isBare(r.source)}`;
      groups.set(group, [...(groups.get(group) ?? []), r]);
    }
    const lineStarts = [0];
    for (const m of module.source.matchAll(/\r\n|\r|\n/g)) lineStarts.push(m.index! + m[0].length);
    const first = new Map<string, { start: number; end: number }>();
    for (const group of groups.values()) {
      const kind = group[0].kind;
      const wanted = new Set(group.map((r) => r.source));
      const places: { line: number; column: number }[] = [];
      const record = (log: RolldownLog) => {
        if (log.code === 'UNRESOLVED_IMPORT' && log.loc) places.push(log.loc);
      };
      try {
        const bundle = await api.rolldown({
          ...inputOptionsOf(options),
          input: 'nimbus-locate', logLevel: 'warn',
          onLog: (_level: string, log: RolldownLog) => record(log),
          plugins: [{
            name: 'nimbus-locate',
            resolveId(source: string, from: string | undefined, extra: { kind?: string }) {
              if (!from) return 'nimbus-locate';
              return (extra.kind ?? 'import-statement') === kind && wanted.has(source) ? null : { id: source, external: true };
            },
            load(id: string) {
              return id === 'nimbus-locate' ? { code: module.source, moduleType: module.lang } : null;
            },
          }],
        });
        try {
          await bundle.generate({ format: 'es' });
        } finally {
          await bundle.close();
        }
      } catch (error) {
        for (const log of Reflect.get(Object(error), 'errors') ?? []) record(log as RolldownLog);
      }
      for (const { line, column } of places) {
        const start = (lineStarts[line - 1] ?? 0) + column;
        const literal = stringLiteralAt(module.source, start);
        if (!literal) continue;
        const key = `${kind}\0${literal.value}`;
        const known = first.get(key);
        if (!known || start < known.start) first.set(key, { start, end: literal.end });
      }
    }
    for (const r of mine) {
      const span = first.get(`${r.kind}\0${r.source}`);
      if (!span) {
        placed.set(r, fileOnly);
        continue;
      }
      const before = module.source.slice(0, span.start);
      const line = before.split(/\r\n|\r|\n/).length;
      const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
      placed.set(r, locate(fileOf(module), module.source, line, utf8Length(before.slice(lineStart)), utf8Length(module.source.slice(span.start, span.end))));
    }
  }
  return records.map((r) => message(r.text, placed.get(r) ?? null, r.pluginName));
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

class BuildError extends Error {
  constructor(readonly messages: esbuild.Message[]) {
    super(messages.map((m) => m.text).join('\n'));
  }
}

function message(text: string, location: esbuild.Location | null = null, pluginName = ''): esbuild.Message {
  return { id: '', pluginName, text, location, notes: [], detail: undefined };
}

/** esbuild's location of `offset` (or of line/column) in `source`. */
function locate(file: string, source: string, line: number, column: number, length = 0): esbuild.Location {
  const lines = source.split(/\r\n|\r|\n/);
  const lineText = lines[line - 1] ?? '';
  return { file, namespace: '', line, column, length, lineText, suggestion: '' };
}

/** `Build failed with N errors:` and one line per error, as esbuild words its rejection. */
export function esbuildFailureText(errors: readonly esbuild.Message[]): string {
  // A place without a line (one placement could not afford) names the file alone.
  const lines = errors.map((e) => {
    const text = e.pluginName ? `[plugin: ${e.pluginName}] ${e.text}` : e.text;
    if (!e.location) return `error: ${text}`;
    return e.location.line > 0 ? `${e.location.file}:${e.location.line}:${e.location.column}: ERROR: ${text}` : `${e.location.file}: ERROR: ${text}`;
  });
  return `Build failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function refuse(text: string): never {
  throw new BuildError([message(text)]);
}

/** The build failed with imports that did not resolve: they are placed once its bundle is closed. */
class UnresolvedImports extends Error {}

/**
 * The input options a build and its placement pass give rolldown alike:
 * everything that decides which imports a module has (platform, target,
 * define, JSX) and how it parses.
 */
function inputOptionsOf(options: EsbuildHostBuildOptions): Record<string, unknown> {
  return {
    cwd: '/',
    platform: options.platform ?? 'browser',
    tsconfig: false,
    transform: {
      target: typeof options.target === 'string' ? options.target : 'esnext',
      define: options.define,
      // esbuild's default for JSX without a tsconfig: React.createElement.
      jsx: { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' },
    },
    checks: { pluginTimings: false },
    // esbuild keeps an imported constant a reference: inlining its value
    // changes what a cycle sees before the constant's module has run.
    optimization: { inlineConst: false },
  };
}

export async function buildWithRolldown(
  api: RolldownApi,
  options: EsbuildHostBuildOptions,
  plugin: EsbuildRemotePlugin,
): Promise<EsbuildBuildOutcome> {
  // This build's diagnostics and modules: overlapping builds each keep their own.
  const state: BuildState = { raised: [], unresolved: [], loaded: new Map() };
  try {
    return await build(api, options, plugin, state);
  } catch (error) {
    // Every bundle of the build is closed by now: placement adds its own, bounded.
    const errors = error instanceof BuildError
      ? error.messages
      : error instanceof UnresolvedImports
        ? sortedMessages(await locateUnresolved(api, options, state.unresolved, state.loaded))
        : sortedMessages([...await locateUnresolved(api, options, state.unresolved, state.loaded), ...messagesOf(error, state.raised, state.loaded)]);
    return { outputFiles: [], errors, warnings: [], failure: esbuildFailureText(errors) };
  }
}

/** What one build has said and loaded so far. */
interface BuildState {
  /** Errors a hook threw: rolldown's own failure carries their text. */
  raised: esbuild.Message[];
  /** Imports that did not resolve: the build goes on, as esbuild's does, and fails with every one. */
  unresolved: Unresolved[];
  /** The modules the plugin loaded, by id. */
  loaded: Map<string, Loaded>;
}

/** In esbuild's order: by file, line and column, those without a place first. */
function sortedMessages(messages: esbuild.Message[]): esbuild.Message[] {
  const key = (m: esbuild.Message) => m.location;
  return messages
    .map((m, i) => [m, i] as const)
    .sort(([a, i], [b, j]) => {
      const la = key(a);
      const lb = key(b);
      if (!la || !lb) return la ? 1 : lb ? -1 : i - j;
      if (la.file !== lb.file) return la.file < lb.file ? -1 : 1;
      return la.line - lb.line || la.column - lb.column || i - j;
    })
    .map(([m]) => m);
}

/**
 * A rolldown failure's diagnostics; anything else is one error with its
 * message. An error the adapter raised from a hook (a load the plugin failed)
 * comes back inside rolldown's own, by text only: `raised` holds it as
 * esbuild worded it.
 */
function messagesOf(error: unknown, raised: readonly esbuild.Message[], loaded: ReadonlyMap<string, Loaded>): esbuild.Message[] {
  const logs = error instanceof Error ? Reflect.get(error, 'errors') : undefined;
  if (!Array.isArray(logs) || !logs.length) return [message(error instanceof Error ? error.message : String(error))];
  const unclaimed = [...raised];
  return logs.map((log: RolldownLog) => {
    const i = unclaimed.findIndex((m) => log.message.includes(m.text));
    return i >= 0 ? unclaimed.splice(i, 1)[0] : fromLog(log, loaded);
  });
}

/**
 * A rolldown diagnostic as esbuild's: its first line of text, its place in
 * its module, and every other place it labels (rolldown draws them in the
 * message: `N │ <line>`, then `╰── <label>` under the column) as a note.
 */
function fromLog(log: RolldownLog, modules: ReadonlyMap<string, Loaded>): esbuild.Message {
  // eslint-disable-next-line no-control-regex
  const plain = log.message.replace(/\u001b\[[0-9;]*m/g, '');
  const firstLine = plain.split('\n')[0].replace(/^\[[A-Z_]+\]\s*/, '').replace(/^(Error|Warning):\s*/, '');
  const loaded = log.id ? modules.get(log.id) : undefined;
  const location = log.loc && loaded
    ? locate(fileOf(loaded), loaded.source, log.loc.line, log.loc.column)
    : null;
  const result = message(firstLine, location, log.plugin ?? '');
  if (loaded) {
    let sourceLine = 0;
    let gutter = 0;
    for (const line of plain.split('\n')) {
      const source = /^\s*(\d+) │ /.exec(line);
      if (source) {
        sourceLine = Number(source[1]);
        gutter = source[0].length;
        continue;
      }
      const label = /[╰├]── (.*)$/.exec(line);
      if (!label || !sourceLine) continue;
      const column = line.search(/[╰├]/) - gutter;
      if (location && sourceLine === location.line && column === location.column) continue;
      result.notes.push({ text: label[1].trim(), location: locate(fileOf(loaded), loaded.source, sourceLine, column) });
    }
  }
  return result;
}

/** How esbuild names a module's file in a diagnostic: `<namespace>:<path>`, the path alone for `file`. */
function fileOf(module: { namespace: string; path: string }): string {
  return module.namespace === 'file' || module.namespace === '' ? module.path : `${module.namespace}:${module.path}`;
}

async function build(
  api: RolldownApi,
  options: EsbuildHostBuildOptions,
  plugin: EsbuildRemotePlugin,
  { raised, unresolved, loaded }: BuildState,
): Promise<EsbuildBuildOutcome> {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !SUPPORTED.has(key)) refuse(`Nimbus's bundler does not support the esbuild option "${key}"`);
  }
  if (options.bundle === false) refuse('Nimbus\'s bundler only bundles (bundle: false is not supported)');
  if (options.tsconfigRaw !== undefined && options.tsconfigRaw !== '' && JSON.stringify(options.tsconfigRaw) !== '{}') {
    refuse('Nimbus\'s bundler does not support tsconfigRaw');
  }
  const entryPoints = Array.isArray(options.entryPoints) ? options.entryPoints : null;
  if (!entryPoints || entryPoints.some((e) => typeof e !== 'string')) refuse('Nimbus\'s bundler takes entryPoints as a list of paths');
  if (options.outfile && entryPoints.length !== 1) refuse('outfile needs exactly one entry point');
  const format = options.format ?? 'esm';
  if (format !== 'esm' && format !== 'cjs' && format !== 'iife') refuse(`Nimbus's bundler does not support format "${format}"`);
  const target = typeof options.target === 'string' ? options.target : 'esnext';
  if (!/^(esnext|es20\d\d)$/.test(target)) refuse(`Nimbus's bundler does not support target "${String(options.target)}"`);

  const alias = Object.entries(options.alias ?? {});
  const aliased = (path: string) => {
    for (const [from, to] of alias) {
      if (path === from) return to;
      if (path.startsWith(from + '/')) return to + path.slice(from.length);
    }
    return path;
  };

  // The namespace most modules load in: the plugin's answer for the first entry.
  let mainNamespace: string | null = null;
  const idOf = (namespace: string, path: string) => (namespace === mainNamespace ? path : `\0${namespace}:${path}`);
  const decode = (id: string): { namespace: string; path: string } => {
    const known = loaded.get(id);
    if (known) return known;
    const m = /^\0([^:]*):([\s\S]*)$/.exec(id);
    return m ? { namespace: m[1], path: m[2] } : { namespace: mainNamespace ?? 'file', path: id };
  };
  const pending = new Map<string, { namespace: string; path: string }>();
  const css = new Map<string, CssModule>();
  const warnings: esbuild.Message[] = [];
  const template = (names: string | undefined, fallback: string) => (names ?? fallback).replace(/\[ext\]/g, '[extname]');

  // Emitted assets (the `file` loader's, from JavaScript or a stylesheet's
  // url()), by output path. A name holds its bytes' hash before any script or
  // stylesheet names it, so theirs follow from it; two different files at one
  // path are an error, as in esbuild.
  const assetFiles = new Map<string, Uint8Array>();
  const assetNames = new Map<string, Promise<string>>();
  const collisions = new Set<string>();
  const emitAsset = (module: { namespace: string; path: string }, bytes: Uint8Array): Promise<string> => {
    const key = fileOf(module);
    if (!assetNames.has(key)) {
      assetNames.set(key, (async () => {
        const base = module.path.slice(module.path.lastIndexOf('/') + 1);
        const ext = extensionOf(base);
        const name = ext ? base.slice(0, -ext.length) : base;
        const fileName = fill(options.assetNames ?? '[name]-[hash]', { name, hash: await contentHash(bytes), ext: ext.slice(1) }) + ext;
        const known = assetFiles.get(fileName);
        if (known && !sameBytes(known, bytes)) collisions.add(fileName);
        else assetFiles.set(fileName, bytes);
        return fileName;
      })());
    }
    return assetNames.get(key)!;
  };
  // Where an entry's script and stylesheet are written, relative to the output
  // directory: the path a `file` import's string is relative to.
  const entryDir = (() => {
    if (options.outfile) return '';
    const names = options.entryNames ?? '[name]';
    const dir = names.slice(0, names.lastIndexOf('/') + 1);
    return dir.includes('[') ? null : dir;
  })();

  const raise = (text: string, pluginName = ''): never => {
    raised.push(message(text, null, pluginName));
    throw new Error(text);
  };
  // An import that did not resolve stays external so the build goes on to
  // report every other error with it; locateUnresolved places them all.
  const unresolvedImport = (text: string, importer: string | undefined, source: string, kind: string, pluginName: string) => {
    unresolved.push({ importer, source, kind, text, pluginName });
    return { id: source, external: true };
  };

  // Per entry chunk, its CSS modules in the order its JavaScript evaluates
  // them: rolldown renders an empty module into no chunk, so the graph says.
  const cssOrder = new Map<string, string[]>();
  type ModuleInfo = { importedIds: readonly string[]; dynamicallyImportedIds: readonly string[] } | null;
  const vfs = {
    name: plugin.name,
    generateBundle(this: { getModuleInfo(id: string): ModuleInfo }, _options: unknown, bundle: Record<string, RolldownOutput>) {
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk' || !out.facadeModuleId) continue;
        const order: string[] = [];
        const seen = new Set<string>();
        const visit = (id: string) => {
          if (seen.has(id)) return;
          seen.add(id);
          const info = this.getModuleInfo(id);
          for (const child of info?.importedIds ?? []) visit(child);
          if (css.has(id)) order.push(id);
          for (const child of info?.dynamicallyImportedIds ?? []) visit(child);
        };
        visit(out.facadeModuleId);
        cssOrder.set(out.fileName, order);
      }
    },
    async resolveId(source: string, importer: string | undefined, extra: { kind?: string; isEntry?: boolean; attributes?: Record<string, string> }) {
      if (source.startsWith('\0')) return null;
      const from = importer ? decode(importer) : null;
      const kind = extra.isEntry && !importer ? 'entry-point' : (extra.kind ?? 'import-statement');
      const path = kind === 'entry-point' ? source : aliased(source);
      const answer = await plugin.resolve({
        path,
        importer: from ? from.path : '',
        namespace: from ? from.namespace : 'file',
        resolveDir: from ? (loaded.get(importer!)?.resolveDir ?? '') : '',
        kind: kind as esbuild.ImportKind,
        with: extra.attributes ?? {},
      });
      if (answer?.errors?.length) return unresolvedImport(answer.errors[0].text ?? 'error', importer, source, kind, plugin.name);
      if (answer?.warnings?.length) for (const w of answer.warnings) warnings.push(message(w.text ?? ''));
      if (!answer || (!answer.path && !answer.external)) return unresolvedImport(`Could not resolve ${JSON.stringify(source)}`, importer, source, kind, '');
      if (answer!.external) return { id: answer!.path ?? path, external: true };
      const namespace = answer!.namespace ?? 'file';
      if (mainNamespace === null) mainNamespace = namespace;
      const id = idOf(namespace, answer!.path!);
      pending.set(id, { namespace, path: answer!.path! });
      return id;
    },
    async load(id: string) {
      const { namespace, path } = pending.get(id) ?? decode(id);
      const answer = await plugin.load({ path, namespace, suffix: '', with: {} });
      if (answer?.errors?.length) raise(answer.errors[0].text ?? 'error', plugin.name);
      if (answer?.warnings?.length) for (const w of answer.warnings) warnings.push(message(w.text ?? ''));
      if (!answer || answer.contents === undefined) raise(`No loader produced ${fileOf({ namespace, path })}`);
      const loader = answer!.loader ?? 'js';
      const contents = answer!.contents!;
      const text = typeof contents === 'string' ? contents : loader === 'binary' || loader === 'base64' || loader === 'dataurl' || loader === 'file' ? '' : new TextDecoder().decode(contents);
      const lastSlash = path.lastIndexOf('/');
      loaded.set(id, {
        namespace, path,
        resolveDir: answer!.resolveDir ?? (namespace === 'file' || namespace === mainNamespace ? (lastSlash > 0 ? path.slice(0, lastSlash) : '/') : ''),
        source: text,
        lang: loader === 'js' || loader === 'jsx' || loader === 'ts' || loader === 'tsx' ? loader : undefined,
      });
      if (loader === 'css') {
        // esbuild bundles a JavaScript build's stylesheets into a sheet beside it, so it needs a place for that sheet.
        if (!options.outdir && !options.outfile) raise(`Cannot import ${JSON.stringify(fileOf({ namespace, path }))} into a JavaScript file without an output path configured`);
        css.set(id, { namespace, path, resolveDir: loaded.get(id)!.resolveDir, source: text });
        return { code: '', moduleType: 'js', moduleSideEffects: true };
      }
      const bytesOf = () => (typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
      // An asset loader's module is its one value, as esbuild's is: imported,
      // the default export; required, module.exports itself. rolldown's `json`
      // (and `text`) modules are exactly that, so a string value is a JSON one.
      const value = (string: string) => ({ code: JSON.stringify(string), moduleType: 'json' });
      if (loader === 'file') {
        if (entryDir === null) raise(`Nimbus's bundler does not support a placeholder in the directory of entryNames with the "file" loader (${fileOf({ namespace, path })})`);
        return value(relativeUrl(`${entryDir}entry.js`, await emitAsset({ namespace, path }, bytesOf())));
      }
      if (loader === 'dataurl') return value(dataUrlOf(path, bytesOf()));
      if (loader === 'base64') return value(base64Of(bytesOf()));
      // A Uint8Array of the bytes, decoded from base64 as esbuild's __toBinary
      // does (rolldown's `binary` takes a string, and would store its UTF-8);
      // CommonJS, so a require() gets the array itself.
      if (loader === 'binary') {
        return { code: `module.exports = Uint8Array.from(atob(${JSON.stringify(base64Of(bytesOf()))}), (c) => c.charCodeAt(0));`, moduleType: 'js' };
      }
      const moduleType = LOADER_MODULE_TYPES[loader];
      if (!moduleType) raise(`Nimbus's bundler does not support the "${loader}" loader (${fileOf({ namespace, path })})`);
      return { code: text, moduleType };
    },
  };

  const bundle = await api.rolldown({
    ...inputOptionsOf(options),
    input: entryPoints,
    plugins: [vfs],
    onLog(level: string, log: RolldownLog) {
      if (level === 'warn') warnings.push(fromLog(log, loaded));
    },
  });
  try {
    const { output } = await bundle.generate({
      format: format === 'esm' ? 'es' : format,
      name: options.globalName,
      minify: options.minify === true,
      keepNames: options.keepNames === true,
      sourcemap: options.sourcemap === true || options.sourcemap === 'external' ? true : options.sourcemap === 'inline' ? 'inline' : false,
      entryFileNames: options.outfile ? options.outfile.slice(options.outfile.lastIndexOf('/') + 1) : `${template(options.entryNames, '[name]')}.js`,
      chunkFileNames: `${template(options.chunkNames, '[name]-[hash]')}.js`,
      assetFileNames: `${template(options.assetNames, '[name]-[hash]')}[extname]`,
      codeSplitting: false,
    });
    // Placed by buildWithRolldown once this bundle is closed.
    if (unresolved.length) throw new UnresolvedImports();
    const outdir = options.outfile ? options.outfile.slice(0, options.outfile.lastIndexOf('/')) || '/' : (options.outdir ?? '/dist');
    const at = (fileName: string) => `${outdir.replace(/\/+$/, '')}/${fileName}`;
    const encoder = new TextEncoder();
    const outputFiles: EsbuildBuildOutcome['outputFiles'] = [];
    const outputs: esbuild.Metafile['outputs'] = {};
    const relative = (path: string) => path.replace(/^\/+/, '');
    for (const out of output) {
      if (out.type === 'chunk') {
        const contents = encoder.encode(out.code);
        const path = at(out.fileName);
        outputFiles.push({ path, contents });
        const entry = out.isEntry && out.facadeModuleId ? decode(out.facadeModuleId) : null;
        // In the order the chunk's JavaScript first imports them.
        const cssOfChunk = (cssOrder.get(out.fileName) ?? []).map((id) => css.get(id)!);
        let cssBundle: string | undefined;
        if (cssOfChunk.length) {
          // The stylesheet sits beside the script, named by the same template and its own bytes' hash.
          const cssDir = out.fileName.slice(0, out.fileName.lastIndexOf('/') + 1);
          const sheetAssets: CssAssets = {
            emit: async (module, bytes) => relativeUrl(`${cssDir}sheet.css`, await emitAsset(module, bytes)),
            dataUrl: dataUrlOf,
          };
          let bundled: Uint8Array;
          try {
            bundled = encoder.encode(await bundleCss(cssOfChunk, plugin, sheetAssets, { minify: options.minify === true }));
          } catch (error) {
            if (error instanceof CssError) throw new BuildError([error.diagnostic]);
            throw error;
          }
          const cssFileName = options.outfile
            ? out.fileName.replace(/\.js$/, '') + '.css'
            : fill(options.entryNames ?? '[name]', { name: out.name, hash: await contentHash(bundled), ext: 'css' }) + '.css';
          const cssPath = at(cssFileName);
          outputFiles.push({ path: cssPath, contents: bundled });
          outputs[relative(cssPath)] = { imports: [], exports: [], inputs: {}, bytes: bundled.length };
          cssBundle = relative(cssPath);
        }
        outputs[relative(path)] = {
          imports: [], exports: out.exports, inputs: {}, bytes: contents.length,
          ...(entry ? { entryPoint: fileOf(entry) } : {}),
          ...(cssBundle ? { cssBundle } : {}),
        };
      } else {
        const contents = typeof out.source === 'string' ? encoder.encode(out.source) : out.source;
        const path = at(out.fileName);
        outputFiles.push({ path, contents });
        outputs[relative(path)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
      }
    }
    if (collisions.size) {
      throw new BuildError([...collisions].map((fileName) => message(`Two output files share the same path but have different contents: ${at(fileName).replace(/^\/+/, '')}`)));
    }
    for (const [fileName, contents] of assetFiles) {
      const path = at(fileName);
      outputFiles.push({ path, contents });
      outputs[relative(path)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
    }
    return { outputFiles, errors: [], warnings, metafile: { inputs: {}, outputs } };
  } finally {
    await bundle.close();
  }
}
