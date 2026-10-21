/**
 * cjs-module-exports.ts — the names an ES module may import from a CommonJS
 * module, as Node 22.23.4 names them before the module runs
 * (lib/internal/modules/esm/translators.js cjsPreparseModuleExports): what
 * cjs-module-lexer, at Node's own version, finds in its source, `default`
 * first, and the names of every module it re-exports (`module.exports =
 * require('x')`, `__exportStar`, Babel's loop) that require() resolves to a
 * `.js`, a `.cjs` or a file of an extension require has no loader for,
 * walked the same way. A module whose source does not lex has no names but
 * `default`; a re-export that does not resolve, or whose resolution require()
 * refuses (a path a package's "exports" hides), adds none. A cycle stops at a
 * module already being read: its names are the ones found so far, as Node's,
 * which records them first.
 *
 * One walk over a host that answers in place (a process's filesystem) or
 * with promises (the session's).
 */

import { createCjsLexer, type CjsLexer } from './cjs-module-lexer.js';

type MaybePromise<T> = T | Promise<T>;

/** What the walk asks of the filesystem and the require resolver. */
export interface CjsModuleExportsHost<A extends 'sync' | 'async' = 'sync'> {
  /** A module's source, or null when it cannot be read. */
  source(path: string): A extends 'sync' ? string | null : MaybePromise<string | null>;
  /** The absolute path `require(specifier)` from the module at `fromPath` loads, or null; a refusal may throw. */
  resolve(specifier: string, fromPath: string): A extends 'sync' ? string | null : MaybePromise<string | null>;
}

/** One question the walk asks its host. */
type Question = { source: string } | { resolve: string; from: string };

/** Extensions require loads as something other than CommonJS source. */
const NOT_COMMONJS: Readonly<Record<string, true>> = { '.json': true, '.node': true, '.mjs': true };

let lexer: CjsLexer | null = null;

function* walk(path: string, cache: Map<string, Set<string>>, source: string | undefined): Generator<Question, Set<string>, unknown> {
  const known = cache.get(path);
  if (known !== undefined) return known;
  const text = source ?? (yield { source: path });
  let exports: readonly string[] = [];
  let reexports: readonly string[] = [];
  try {
    ({ exports, reexports } = (lexer ??= createCjsLexer())(typeof text === 'string' ? text : ''));
  } catch {
    // No names but `default`, as Node's.
  }
  const names = new Set(['default', ...exports]);
  cache.set(path, names);
  for (const reexport of reexports) {
    let resolved: unknown;
    try {
      resolved = yield { resolve: reexport, from: path };
    } catch {
      continue; // As Node's: a re-export require() refuses is skipped.
    }
    if (typeof resolved !== 'string' || !resolved.startsWith('/')) continue;
    const slash = resolved.lastIndexOf('/');
    const dot = resolved.lastIndexOf('.');
    if (dot > slash && NOT_COMMONJS[resolved.slice(dot)]) continue;
    for (const name of yield* walk(resolved, cache, undefined)) names.add(name);
  }
  return names;
}

/**
 * The names an ES module may import from the CommonJS module at `path`
 * (`source`, when the caller holds it), `default` first. `cache` keeps each
 * module's names across calls, and is what ends a cycle.
 */
export function cjsModuleExportNames(
  path: string,
  host: CjsModuleExportsHost,
  cache: Map<string, Set<string>> = new Map(),
  source?: string,
): Set<string> {
  const steps = walk(path, cache, source);
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    const q = step.value;
    let answer: string | null;
    try {
      answer = 'source' in q ? host.source(q.source) : host.resolve(q.resolve, q.from);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(answer);
  }
}

/** cjsModuleExportNames over a host whose answers may be promises (the session's filesystem). */
export async function cjsModuleExportNamesAsync(
  path: string,
  host: CjsModuleExportsHost<'async'>,
  cache: Map<string, Set<string>> = new Map(),
  source?: string,
): Promise<Set<string>> {
  const steps = walk(path, cache, source);
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    const q = step.value;
    let answer: string | null;
    try {
      answer = await ('source' in q ? host.source(q.source) : host.resolve(q.resolve, q.from));
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(answer);
  }
}
