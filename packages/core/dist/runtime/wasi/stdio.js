/** The one live WASI fd1/fd2 relay, shared by every runtime and scheduler. */
export const WASI_OUTPUT_IN_FLIGHT_BYTES = 1 << 20;
export function wasiOutputRelay(target) {
    let chain = null;
    let inFlight = 0;
    let lost = null;
    const send = (fd, bytes) => {
        if (bytes.byteLength === 0)
            return;
        let at = 0;
        const admit = () => {
            if (lost !== null)
                throw new Error(lost);
            while (at < bytes.byteLength) {
                const room = WASI_OUTPUT_IN_FLIGHT_BYTES - inFlight;
                if (room === 0)
                    return chain.then(admit);
                const size = Math.min(room, bytes.byteLength - at);
                const part = at === 0 && size === bytes.byteLength ? bytes : bytes.subarray(at, at + size);
                at += size;
                inFlight += size;
                const write = () => fd === 1 ? target.stdout(part) : target.stderr(part);
                // A local capability is blocking. A remote RpcPromise is adopted,
                // never mistaken for a plain reply; subsequent bytes keep its order.
                let delivered;
                try {
                    delivered = chain ? chain.then(write) : write();
                }
                catch (error) {
                    inFlight -= size;
                    throw error;
                }
                if (delivered && typeof delivered.then === 'function') {
                    const pending = Promise.resolve(delivered)
                        .catch((error) => { lost ??= error instanceof Error ? error.message : String(error); })
                        .finally(() => { inFlight -= size; if (chain === pending)
                        chain = null; });
                    chain = pending;
                }
                else
                    inFlight -= size;
            }
        };
        return admit();
    };
    return {
        stdoutBytes: (bytes) => send(1, bytes),
        stderrBytes: (bytes) => send(2, bytes),
        ready: () => inFlight >= WASI_OUTPUT_IN_FLIGHT_BYTES ? chain ?? undefined : undefined,
        drain: () => (chain ?? Promise.resolve()).then(() => lost),
    };
}
