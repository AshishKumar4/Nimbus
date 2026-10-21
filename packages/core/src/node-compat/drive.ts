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

/** A path a call names: as the face takes it (absolute), and as its caller gave it, which its errors name, as Node's do. */
export interface Named {
  readonly abs: string;
  readonly given: string;
}

/** One file call an operation waits for; its syscall and path name it in an EAGAIN. */
export interface Step {
  readonly syscall: string;
  readonly path: Named | undefined;
  later(files: FilesFace<'async'>): Promise<void>;
}

/**
 * `error`, a failure of a call on `path` (and `dest`), naming them as its
 * caller gave them: a new error with its fields, the face's own (which it may
 * share or have frozen) its cause and left as it is.
 */
function asGiven(error: unknown, path: Named | undefined, dest: Named | undefined): unknown {
  const renamed = [['path', path], ['dest', dest]] as const;
  if (!(error instanceof Error) || !renamed.some(([field, named]) => named !== undefined && named.given !== named.abs && Reflect.get(error, field) === named.abs)) {
    return error;
  }
  return withFields(error, (fields, message) => {
    for (const [field, named] of renamed) {
      if (named === undefined || fields[field] !== named.abs) continue;
      fields[field] = named.given;
      message = message.split(`'${named.abs}'`).join(`'${named.given}'`);
    }
    return message;
  });
}

/** A new error with `error`'s own fields and message as `change` makes them; `error` is its cause. */
export function withFields(error: Error, change: (fields: Record<string, unknown>, message: string) => string): Error {
  const fields: Record<string, unknown> = { ...error };
  const message = change(fields, error.message);
  return Object.assign(new Error(message, { cause: error }), fields);
}

/** An operation: the steps it makes, and what it answers. */
export type Op<T> = Generator<Step, T, void>;

/**
 * The synchronous face while an operation is answered now: its steps call
 * it where they stand, so a failure is thrown once, where the body can
 * catch it, and nothing is yielded.
 */
let answering: FilesFace<'sync'> | null = null;

/** A step's answer already in hand: `yield*` of it is its value, with nothing yielded. */
class Answered<T> implements Iterator<Step, T, void> {
  private readonly result: IteratorReturnResult<T>;
  constructor(value: T) {
    this.result = { done: true, value };
  }
  next(): IteratorResult<Step, T> {
    return this.result;
  }
  [Symbol.iterator](): Iterator<Step, T, void> {
    return this;
  }
}

/** What a body's `yield*` of a step takes: its answer, now, or the step it waits for. */
export type Stepping<T> = Iterable<Step, T, void>;

/**
 * `call`, made on whichever face the driver has: the face's methods take
 * the same arguments and differ only in answering now or with a promise.
 * Answered now, it is called where it stands; answered later, its answer is
 * kept here and read back after the step.
 */
export function step<T>(
  syscall: string,
  path: Named | undefined,
  call: (files: FilesFace<'sync'> | FilesFace<'async'>) => T | Promise<T>,
  dest?: Named,
): Stepping<T> {
  if (answering === null) return waitFor(syscall, path, call, dest);
  try {
    return new Answered(syncValue(call(answering)));
  } catch (error) {
    throw asGiven(error, path, dest);
  }
}

function* waitFor<T>(
  syscall: string,
  path: Named | undefined,
  call: (files: FilesFace<'sync'> | FilesFace<'async'>) => T | Promise<T>,
  dest: Named | undefined,
): Op<T> {
  const slot: { answer: { value: T } | null } = { answer: null };
  yield {
    syscall,
    path,
    async later(files) {
      try {
        slot.answer = { value: await call(files) };
      } catch (error) {
        throw asGiven(error, path, dest);
      }
    },
  };
  if (slot.answer === null) throw new Error(`node-compat: ${syscall} resumed unanswered`);
  return slot.answer.value;
}

/** ENOSYS: the filesystem has no `syscall`. */
export function lacks(syscall: string, path?: string, dest?: string): Error {
  return fsError('ENOSYS', syscall, path, dest);
}

/** `op` answered now: each of its steps calls `files` where it stands. */
function answerNow<T>(op: Op<T>, files: FilesFace<'sync'>): T {
  const outer = answering;
  answering = files;
  try {
    const next = op.next();
    if (!next.done) throw new Error(`node-compat: ${next.value.syscall} waited where it is answered now`);
    return next.value;
  } finally {
    answering = outer;
  }
}

/**
 * `op` as its `*Sync` form runs it (`name`, Node's name of that form). With
 * no synchronous face its first step throws EAGAIN, naming the step's
 * syscall and path, and the form that can wait; nothing has been called.
 */
export function runSync<T>(faces: NodeFaces, name: string, op: Op<T>): T {
  if (faces.sync !== undefined) return answerNow(op, faces.sync);
  const next = resumed(() => op.next());
  if (next.done) return next.value;
  const base = name.replace(/Sync$/, '');
  throw fsError('EAGAIN', next.value.syscall, next.value.path?.given, undefined, {
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
  let next = resumed(() => op.next());
  while (!next.done) {
    const step = next.value;
    try {
      await step.later(files);
    } catch (error) {
      next = resumed(() => op.throw(error));
      continue;
    }
    next = resumed(() => op.next());
  }
  return next.value;
}

/** `resume` run with no synchronous face answering: its steps wait. */
function resumed<T>(resume: () => IteratorResult<Step, T>): IteratorResult<Step, T> {
  const outer = answering;
  answering = null;
  try {
    return resume();
  } finally {
    answering = outer;
  }
}
