export const LOCAL_PLACEMENT = Object.freeze({ kind: 'local' });
/**
 * `stdin`'s bytes into `sink`, in order, then its end, as a pipe's writer
 * gives them; a source that fails ends it there, as a writer that dies
 * closes its pipe. Once the program has ended (`ended`) or takes no more,
 * the source is let go: a read still waiting is cancelled. A sink that
 * fails lets the source go and is the caller's to hear.
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
                await sink.end();
                return;
            }
            if (next !== null && next.done) {
                await sink.end();
                return;
            }
            if (next === null || !(await sink.write(next.value))) {
                await reader.cancel();
                return;
            }
        }
    }
    catch (error) {
        await reader.cancel(error);
        throw error;
    }
    finally {
        reader.releaseLock();
    }
}
