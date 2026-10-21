import { liveTerminals } from './shell-socket.js';
const inFlight = new WeakMap();
/** An HTTP request to the session `ctx` began; the answer ends it. */
export function requestBegan(ctx) {
    inFlight.set(ctx, (inFlight.get(ctx) ?? 0) + 1);
    let ended = false;
    return () => {
        if (ended)
            return;
        ended = true;
        inFlight.set(ctx, (inFlight.get(ctx) ?? 1) - 1);
    };
}
export function threadDemand(host) {
    return {
        wants(pid) {
            const wants = [];
            const own = pid === undefined ? undefined : host.processes.get(pid);
            const terminals = liveTerminals(host.ctx, host.ctx.getWebSockets());
            // The process table names the session's own terminal '' and the socket stamp undefined.
            if (own?.terminal !== undefined)
                terminals.delete(own.terminal === '' ? undefined : own.terminal);
            if (terminals.size > 0)
                wants.push('terminal');
            const ancestry = new Set();
            for (let entry = own; entry !== undefined && !ancestry.has(entry.pid); entry = entry.parentPid === undefined ? undefined : host.processes.get(entry.parentPid)) {
                ancestry.add(entry.pid);
            }
            if (host.processes.getRunning().some((entry) => !ancestry.has(entry.pid) && !host.isShell(entry.pid)))
                wants.push('process');
            if ((inFlight.get(host.ctx) ?? 0) > 0)
                wants.push('request');
            return wants;
        },
    };
}
