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
/** `error`, a failure of a call on `path` (and `dest`), naming them as its caller gave them. */
function asGiven(error, path, dest) {
    if (!(error instanceof Error))
        return error;
    for (const [field, named] of [['path', path], ['dest', dest]]) {
        if (named === undefined || named.given === named.abs || Reflect.get(error, field) !== named.abs)
            continue;
        Reflect.set(error, field, named.given);
        error.message = error.message.split(`'${named.abs}'`).join(`'${named.given}'`);
    }
    return error;
}
/**
 * The synchronous face while an operation is answered now: its steps call
 * it where they stand, so a failure is thrown once, where the body can
 * catch it, and nothing is yielded.
 */
let answering = null;
/** A step's answer already in hand: `yield*` of it is its value, with nothing yielded. */
class Answered {
    result;
    constructor(value) {
        this.result = { done: true, value };
    }
    next() {
        return this.result;
    }
    [Symbol.iterator]() {
        return this;
    }
}
/**
 * `call`, made on whichever face the driver has: the face's methods take
 * the same arguments and differ only in answering now or with a promise.
 * Answered now, it is called where it stands; answered later, its answer is
 * kept here and read back after the step.
 */
export function step(syscall, path, call, dest) {
    if (answering === null)
        return waitFor(syscall, path, call, dest);
    try {
        return new Answered(syncValue(call(answering)));
    }
    catch (error) {
        throw asGiven(error, path, dest);
    }
}
function* waitFor(syscall, path, call, dest) {
    const slot = { answer: null };
    yield {
        syscall,
        path,
        async later(files) {
            try {
                slot.answer = { value: await call(files) };
            }
            catch (error) {
                throw asGiven(error, path, dest);
            }
        },
    };
    if (slot.answer === null)
        throw new Error(`node-compat: ${syscall} resumed unanswered`);
    return slot.answer.value;
}
/** ENOSYS: the filesystem has no `syscall`. */
export function lacks(syscall, path) {
    return fsError('ENOSYS', syscall, path);
}
/** `op` answered now: each of its steps calls `files` where it stands. */
function answerNow(op, files) {
    const outer = answering;
    answering = files;
    try {
        const next = op.next();
        if (!next.done)
            throw new Error(`node-compat: ${next.value.syscall} waited where it is answered now`);
        return next.value;
    }
    finally {
        answering = outer;
    }
}
/**
 * `op` as its `*Sync` form runs it (`name`, Node's name of that form). With
 * no synchronous face its first step throws EAGAIN, naming the step's
 * syscall and path, and the form that can wait; nothing has been called.
 */
export function runSync(faces, name, op) {
    if (faces.sync !== undefined)
        return answerNow(op, faces.sync);
    const next = resumed(() => op.next());
    if (next.done)
        return next.value;
    const base = name.replace(/Sync$/, '');
    throw fsError('EAGAIN', next.value.syscall, next.value.path?.given, undefined, {
        detail: `resource temporarily unavailable (${name} cannot wait for these files; fs.${base} and fs.promises can)`,
    });
}
/** `op` awaited over the asynchronous face, or answered now from the synchronous one when there is none. */
export async function runAsync(faces, op) {
    if (faces.sync === undefined)
        return answerLater(op, faces.async);
    if (faces.async === undefined)
        return answerNow(op, faces.sync);
    return answerLater(op, faces.async);
}
/** `op` over `files`, each step awaited, its failures thrown into it. */
async function answerLater(op, files) {
    let next = resumed(() => op.next());
    while (!next.done) {
        const step = next.value;
        try {
            await step.later(files);
        }
        catch (error) {
            next = resumed(() => op.throw(error));
            continue;
        }
        next = resumed(() => op.next());
    }
    return next.value;
}
/** `resume` run with no synchronous face answering: its steps wait. */
function resumed(resume) {
    const outer = answering;
    answering = null;
    try {
        return resume();
    }
    finally {
        answering = outer;
    }
}
