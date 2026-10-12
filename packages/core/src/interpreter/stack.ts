/**
 * Interpreted activations live in the already allocated function environment.
 * A call records its position once; a fault supplies its innermost position
 * lazily. Nothing allocates a stack, or writes a statement position, until an
 * error is made. Native wrappers delimit these activations in V8's stack.
 */
import {
  SafeWeakMap, charCodeAt, globalObject, newSafeList, objectHasOwn, reflectGetOwnPropertyDescriptor, reflectOwnKeys, objectGetPrototypeOf,
} from './intrinsics.js';
import type { Env } from './runtime.js';

export interface StackUnit {
  readonly file: string | null;
  readonly source: string;
  readonly esModule: boolean;
  readonly capture: ((error: object, frames: readonly InterpretedFrame[]) => void) | null;
  readonly isProxy: ((value: unknown) => boolean) | null;
  readonly isError: ((value: unknown) => boolean) | null;
}
export interface StackInfo {
  readonly unit: StackUnit;
  readonly name: string;
  readonly start: number;
  readonly strict: boolean;
  readonly shape: string;
}
export interface InterpretedFrame {
  readonly unit: StackUnit;
  readonly name: string | null;
  readonly method: string | null;
  readonly type: string | null;
  readonly line: number;
  readonly column: number;
  readonly enclosingLine: number;
  readonly enclosingColumn: number;
  readonly constructor: boolean;
  readonly async: boolean;
  readonly top: boolean;
  readonly fn: unknown;
  readonly receiver: unknown;
}

// Suffix slots, filled with own properties by frameTemplate/withElement.
export const STACK_SLOTS = 9;
const INFO = 0, FN = 1, RECEIVER = 2, CONSTRUCTOR = 3, PARENT = 4, ASYNC_PARENT = 5, ASYNC_AT = 6, RESUMED = 7, AT = 8;
let active: Env | null = null;
let pendingAsync: Env | null = null;
const promises = new SafeWeakMap<object, Env>();
const stamped = new SafeWeakMap<object, readonly InterpretedFrame[]>();

export function initializeStack(env: Env, info: StackInfo, fn: unknown, receiver: unknown, constructor: boolean): void {
  const at = env.length - STACK_SLOTS;
  env[at + INFO] = info;
  env[at + FN] = fn;
  env[at + RECEIVER] = receiver;
  env[at + CONSTRUCTOR] = constructor;
  env[at + PARENT] = null;
  env[at + ASYNC_PARENT] = null;
  env[at + ASYNC_AT] = 0;
  env[at + RESUMED] = false;
  env[at + AT] = info.start;
}

export function pushStack(env: Env): Env | null {
  const previous = active;
  env[env.length - STACK_SLOTS + PARENT] = previous;
  active = env;
  return previous;
}
export function popStack(previous: Env | null): void {
  if (active !== null) active[active.length - STACK_SLOTS + PARENT] = null;
  active = previous;
}

/** Called only immediately before invoking a callee, after its arguments. */
export function callPosition(position: number): void {
  if (active !== null) active[active.length - STACK_SLOTS + AT] = position;
  pendingAsync = null;
}

/** The native async wrapper has returned its promise to the call expression. */
export function callResult<T>(value: T): T {
  if (!object(value)) { pendingAsync = null; return value; }
  if (pendingAsync !== null) promises.set(value, pendingAsync);
  pendingAsync = null;
  if (active !== null) {
    const info = active[active.length - STACK_SLOTS + INFO] as StackInfo;
    if (info.unit.isError !== null && info.unit.isError(value)) stampStack(value);
  }
  return value;
}

export function suspendedStack(env: Env): void {
  const at = env.length - STACK_SLOTS;
  env[at + RESUMED] = true;
  const info = env[at + INFO] as StackInfo;
  if (info.shape === 'async' || info.shape === 'asyncArrow' || info.shape === 'asyncGenerator') pendingAsync = env;
}

/** Only an await establishes an async parent; an un-awaited call does not. */
export function awaitStack(value: unknown, position: number): void {
  if (active === null || !object(value)) return;
  const child = promises.get(value);
  if (child === undefined) return;
  const at = child.length - STACK_SLOTS;
  child[at + ASYNC_PARENT] = active;
  child[at + ASYNC_AT] = position;
}

function object(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function place(source: string, offset: number): readonly [number, number] {
  let line = 1, start = 0;
  for (let i = 0; i < offset; i++) {
    const c = charCodeAt(source, i);
    if (c === 13) {
      if (charCodeAt(source, i + 1) === 10) i++;
      line++; start = i + 1;
    } else if (c === 10 || c === 0x2028 || c === 0x2029) {
      line++; start = i + 1;
    }
  }
  return [line, offset - start + 1];
}

// V8's names do not invoke a receiver's constructor/name getters.
function dataName(value: unknown, key: string, isProxy: ((value: unknown) => boolean) | null): unknown {
  if (!object(value)) return undefined;
  for (let o: object | null = value; o !== null; o = objectGetPrototypeOf(o)) {
    if (isProxy !== null && isProxy(o)) return undefined;
    const descriptor = reflectGetOwnPropertyDescriptor(o, key);
    if (descriptor !== undefined) return objectHasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  return undefined;
}

function methodName(receiver: unknown, fn: unknown, name: string, isProxy: ((value: unknown) => boolean) | null): string | null {
  if (!object(receiver) || typeof fn !== 'function') return null;
  if (name !== '' && dataName(receiver, name, isProxy) === fn) return name;
  let found: string | null = null;
  for (let o: object | null = receiver; o !== null; o = objectGetPrototypeOf(o)) {
    if (isProxy !== null && isProxy(o)) return null;
    const keys = reflectOwnKeys(o);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== 'string') continue;
      const descriptor = reflectGetOwnPropertyDescriptor(o, key);
      if (descriptor !== undefined && objectHasOwn(descriptor, 'value') && descriptor.value === fn) {
        if (found !== null && found !== key) return null;
        found = key;
      }
    }
  }
  return found;
}

function snapshot(position: number | undefined, above: unknown): readonly InterpretedFrame[] {
  const frames = newSafeList<InterpretedFrame>();
  let env = active;
  let async = false, strict = false;
  let skipping = typeof above === 'function';
  while (env !== null) {
    const at = env.length - STACK_SLOTS;
    const info = env[at + INFO] as StackInfo;
    const fn = env[at + FN];
    strict = strict || info.strict;
    if (skipping) {
      if (fn === above) skipping = false;
    } else if (info.unit.file !== null) {
      const loc = place(info.unit.source, position === undefined ? env[at + AT] as number : position);
      const enclosing = place(info.unit.source, info.start);
      const receiver = env[at + RECEIVER];
      const named = dataName(fn, 'name', info.unit.isProxy);
      const name = typeof named === 'string' && named !== '' ? named : info.name;
      const constructor = env[at + CONSTRUCTOR] === true;
      const hasReceiver = receiver !== undefined && receiver !== null && receiver !== globalObject
        && info.shape !== 'arrow' && info.shape !== 'asyncArrow' && (info.unit.isProxy === null || !info.unit.isProxy(receiver));
      const isMethod = !constructor && hasReceiver;
      const method = isMethod ? methodName(receiver, fn, name, info.unit.isProxy) : null;
      const ctor = hasReceiver ? (typeof receiver === 'function' ? receiver : dataName(receiver, 'constructor', info.unit.isProxy)) : undefined;
      const typeName = dataName(ctor, 'name', info.unit.isProxy);
      frames[frames.length] = {
        unit: info.unit, name: name === '' ? null : name, method,
        type: isMethod ? (typeof typeName === 'string' && typeName !== '' ? typeName : 'Object') : null,
        line: loc[0], column: loc[1], enclosingLine: enclosing[0], enclosingColumn: enclosing[1],
        constructor, async, top: info.shape === 'module' || (!constructor && !hasReceiver), fn: strict ? undefined : fn, receiver: strict ? undefined : receiver,
      };
    }
    const parent = env[at + PARENT] as Env | null;
    if (parent !== null) { env = parent; position = undefined; }
    else if (env[at + RESUMED] === true) {
      position = env[at + ASYNC_AT] as number;
      env = env[at + ASYNC_PARENT] as Env | null;
      async = true;
    } else env = null;
  }
  return skipping ? newSafeList<InterpretedFrame>() : frames;
}

/** Stamp before code can read .stack. Re-throwing an error keeps its origin. */
export function stampStack(error: unknown, position?: number, above?: unknown, replace = false): void {
  if (!object(error) || active === null || (!replace && stamped.has(error))) return;
  const info = active[active.length - STACK_SLOTS + INFO] as StackInfo;
  if (info.unit.capture === null) return;
  try {
    const frames = snapshot(position, above);
    if (frames.length === 0 && typeof above !== 'function') return;
    stamped.set(error, frames);
    info.unit.capture(error, frames);
  } catch {
    // Diagnostics cannot replace the thrown value (a Proxy receiver or a
    // locked Error formatter may refuse introspection).
  }
}

export function stackFrames(error: object): readonly InterpretedFrame[] | null {
  return stamped.get(error) ?? null;
}

/** Preserve the original thrown value; stacks are metadata, not semantics. */
export function errorAt(error: unknown, position: number): never {
  stampStack(error, position);
  throw error;
}
