/**
 * The drivers of Node's `fs` operations (node-compat/fs.ts). Each operation
 * is a generator: its argument checks, paths, encodings and shaping run in
 * its body, and each file call it makes is a step it yields. The sync
 * driver (`*Sync`) answers each step from the synchronous face; with none,
 * it throws EAGAIN at the first step, before anything is called. The async
 * driver (callbacks, `fs.promises`) awaits the asynchronous face, or, with
 * none, answers from the synchronous one as it always has.
 */
import { fsError } from '../vfs/vfs-error.js';
import { syncValue } from '../vfs/vfs.js';
import type { FilesFace, NodeFaces } from './faces.js';

/** One file call an operation makes: answered now, or later; its syscall and path name it in an EAGAIN. */
export interface Step {
  readonly syscall: string;
  readonly path: string | undefined;
  now(files: FilesFace<'sync'>): void;
  later(files: FilesFace<'async'>): Promise<void>;
}

/** An operation: the steps it makes, and what it answers. */
export type Op<T> = Generator<Step, T, void>;

/**
 * `call`, made on whichever face the driver has: the face's methods take
 * the same arguments and differ only in answering now or with a promise.
 * Its answer is kept here and read back after the step.
 */
export function* step<T>(syscall: string, path: string | undefined, call: (files: FilesFace<'sync'> | FilesFace<'async'>) => T | Promise<T>): Op<T> {
  const slot: { answer: { value: T } | null } = { answer: null };
  yield {
    syscall,
    path,
    now(files) { slot.answer = { value: syncValue(call(files)) }; },
    async later(files) { slot.answer = { value: await call(files) }; },
  };
  if (slot.answer === null) throw new Error(`node-compat: ${syscall} resumed unanswered`);
  return slot.answer.value;
}

/** ENOSYS: the filesystem has no `syscall`. */
export function lacks(syscall: string, path?: string): Error {
  return fsError('ENOSYS', syscall, path);
}

/** `op` answered now, its failures thrown into it as each step's are. */
function answerNow<T>(op: Op<T>, files: FilesFace<'sync'>): T {
  let next = op.next();
  while (!next.done) {
    try {
      next.value.now(files);
    } catch (error) {
      next = op.throw(error);
      continue;
    }
    next = op.next();
  }
  return next.value;
}

/**
 * `op` as its `*Sync` form runs it (`name`, Node's name of that form). With
 * no synchronous face its first step throws EAGAIN, naming the step's
 * syscall and path, and the form that can wait; nothing has been called.
 */
export function runSync<T>(faces: NodeFaces, name: string, op: Op<T>): T {
  if (faces.sync !== undefined) return answerNow(op, faces.sync);
  const next = op.next();
  if (next.done) return next.value;
  const base = name.replace(/Sync$/, '');
  throw fsError('EAGAIN', next.value.syscall, next.value.path, undefined, {
    detail: `resource temporarily unavailable (${name} cannot wait for these files; fs.${base} and fs.promises can)`,
  });
}

/** `op` awaited over the asynchronous face, or answered now from the synchronous one when there is none. */
export async function runAsync<T>(faces: NodeFaces, op: Op<T>): Promise<T> {
  if (faces.sync === undefined) return answerLater(op, faces.async);
  if (faces.async === undefined) return answerNow(op, faces.sync);
  return answerLater(op, faces.async);
}

/** `op` over `files`, each step awaited, its failures thrown into it. */
async function answerLater<T>(op: Op<T>, files: FilesFace<'async'>): Promise<T> {
  let next = op.next();
  while (!next.done) {
    try {
      await next.value.later(files);
    } catch (error) {
      next = op.throw(error);
      continue;
    }
    next = op.next();
  }
  return next.value;
}
