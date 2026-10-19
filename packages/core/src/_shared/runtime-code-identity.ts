/**
 * Shared by the host and compiled guest: what identifies and charges runtime
 * code. The guest asks it as it compiles code a program produced, after the
 * program may have replaced any built-in, so it calls only the launch's
 * captures, and serialises lists that inherit nothing (no toJSON a program
 * put on Array.prototype is asked); the host's answer is the same string.
 */
import type { RuntimeCodeEntry } from './commonjs-cell.js';
import { JSONStringify, SafeList, stringCharCodeAt, stringLastIndexOf, stringSlice, stringStartsWith } from './primordials.js';

/** A module's directory and extension determine its resolution/lowering; its basename does not. */
export function runtimeModuleScope(path: string): [dir: string, ext: string] {
  if (stringStartsWith(path, 'data:')) return ['data:', '.mjs'];
  let at = 0;
  while (at < path.length && stringCharCodeAt(path, at) === 0x2f) at++;
  const p = stringSlice(path, at);
  const slash = stringLastIndexOf(p, '/');
  const base = stringSlice(p, slash + 1);
  const dot = stringLastIndexOf(base, '.');
  return [slash < 0 ? '' : stringSlice(p, 0, slash), dot > 0 ? stringSlice(base, dot) : ''];
}

/** `items` as a list that inherits nothing. */
function listOf<T>(items: readonly T[]): SafeList<T | undefined> {
  const out = new SafeList<T | undefined>();
  for (let i = 0; i < items.length; i++) out[i] = items[i];
  return out;
}

/** Both sides hash the same source, with a module's import/lowering scope. */
export function runtimeCodeKeySource(entry: RuntimeCodeEntry): string {
  if (entry.kind === 'module') {
    const scope = runtimeModuleScope(entry.path);
    return JSONStringify(listOf(['module', scope[0], scope[1], entry.text]));
  }
  if (entry.kind === 'expression') return JSONStringify(listOf(['expression', entry.code]));
  if (entry.kind === 'wasm') return JSONStringify(listOf(['wasm', entry.bytes]));
  return JSONStringify(listOf<string | SafeList<string | undefined>>([entry.kind, listOf(entry.params), entry.body]));
}

/** Text, the retained path, and bounded bookkeeping overhead; data URLs hold the source twice. */
export function runtimeCodeSourceCharge(source: string, entry: RuntimeCodeEntry): number {
  return source.length + (entry.kind === 'module' ? entry.path.length : 0) + 512;
}
