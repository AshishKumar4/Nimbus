import { liveTerminals } from './shell-socket.js';
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
            // The run and what is waiting for it: its ancestors, but one that listens.
            const ancestry = new Set();
            for (let entry = own; entry !== undefined && !ancestry.has(entry.pid); entry = entry.parentPid === undefined ? undefined : host.processes.get(entry.parentPid)) {
                if (entry === own || !host.listens(entry.pid))
                    ancestry.add(entry.pid);
                else
                    break;
            }
            if (host.processes.getRunning().some((entry) => !ancestry.has(entry.pid) && !host.isShell(entry.pid)))
                wants.push('process');
            return wants;
        },
    };
}
