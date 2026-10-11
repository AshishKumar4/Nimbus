/** Shared by the host and compiled guest: what identifies and charges runtime code. */
import type { RuntimeCodeEntry } from './commonjs-cell.js';

/** A module's directory and extension determine its resolution/lowering; its basename does not. */
export function runtimeModuleScope(path: string): [dir: string, ext: string] {
  if (path.startsWith('data:')) return ['data:', '.mjs'];
  const p = path.replace(/^\/+/, '');
  const slash = p.lastIndexOf('/');
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return [slash < 0 ? '' : p.slice(0, slash), dot > 0 ? base.slice(dot) : ''];
}

/** Both sides hash the same source, with a module's import/lowering scope. */
export function runtimeCodeKeySource(entry: RuntimeCodeEntry): string {
  if (entry.kind === 'module') return JSON.stringify(['module', ...runtimeModuleScope(entry.path), entry.text]);
  if (entry.kind === 'expression') return JSON.stringify(['expression', entry.code]);
  if (entry.kind === 'wasm') return JSON.stringify(['wasm', entry.bytes]);
  return JSON.stringify([entry.kind, entry.params, entry.body]);
}

/** Text, the retained path, and bounded bookkeeping overhead; data URLs hold the source twice. */
export function runtimeCodeSourceCharge(source: string, entry: RuntimeCodeEntry): number {
  return source.length + (entry.kind === 'module' ? entry.path.length : 0) + 512;
}
