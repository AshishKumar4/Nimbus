export function waitForSignalOrTimeout(promise, signal, timeoutMs) {
    if (signal.aborted) {
        return Promise.resolve({ type: 'aborted' });
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let onAbort;
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        };
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        onAbort = () => finish({ type: 'aborted' });
        timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => finish({ type: 'done', value }), (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}
export function waitForAbort(signal) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
export async function waitForAbortOrTimeout(signal, timeoutMs) {
    const result = await waitForSignalOrTimeout(new Promise(() => { }), signal, timeoutMs);
    return result.type === 'aborted' ? 'aborted' : 'timeout';
}
