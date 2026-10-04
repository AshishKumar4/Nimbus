/**
 * One turn of the event loop, unclamped: setImmediate where the host has it
 * (Bun, Node, workerd with nodejs_compat), else a MessageChannel post. A
 * timer would do, but hosts clamp it to about a millisecond.
 *
 * Work that never waits on I/O runs on microtasks, where no timer, Ctrl-C or
 * `kill` reaches it, so long work yields a turn now and then. Not per step:
 * in a Durable Object every turn that wrote storage waits for the write's
 * commit before the next runs (about 40 ms on a local workerd), so a turn per
 * 8 KiB written made `yes | head -c 48M > f` take minutes. Counted, not
 * timed: workerd's clock stands still while code runs.
 */
const eventLoopHost = globalThis;
export const yieldToEventLoop = typeof eventLoopHost.setImmediate === 'function'
    ? () => new Promise((resolve) => eventLoopHost.setImmediate(resolve))
    : (() => {
        const channel = new eventLoopHost.MessageChannel();
        const waiting = [];
        channel.port1.onmessage = () => waiting.shift()?.();
        return () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
    })();
