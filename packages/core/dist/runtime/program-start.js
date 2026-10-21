export const LOCAL_PLACEMENT = Object.freeze({ kind: 'local' });
/**
 * `stdin`'s bytes into `sink`, in order, then its end, as a pipe's writer
 * gives them; a source that fails ends it there, as a writer that dies
 * closes its pipe. Once the program has ended (`ended`) or takes no more,
 * the source is let go: a read still waiting is cancelled. A sink that fails
 * lets the source go with its error and ends the input; when that fails too
 * it rejects, and the caller is left a program it can only kill.
 */
export async function feedProgramInput(stdin, sink, ended) {
    const reader = stdin.getReader();
    const gone = ended.then(() => null, () => null);
    try {
        for (;;) {
            let next;
            try {
                next = await Promise.race([reader.read(), gone]);
            }
            catch {
                break;
            }
            if (next !== null && next.done)
                break;
            if (next === null || !(await sink.write(next.value))) {
                await reader.cancel();
                return;
            }
        }
    }
    catch (error) {
        await reader.cancel(error);
    }
    finally {
        reader.releaseLock();
    }
    await sink.end();
}
