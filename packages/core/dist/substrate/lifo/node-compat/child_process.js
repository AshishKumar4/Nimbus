import { EventEmitter } from 'node:events';
export function createChildProcess(executeCapture) {
    function exec(cmd, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        const child = new EventEmitter();
        if (!executeCapture) {
            // exec's own 'error' listener answers the callback, as Node's execFile
            // adds one: an exec whose child cannot start never throws.
            child.on('error', (err) => { if (callback)
                callback(err instanceof Error ? err : new Error(String(err)), '', ''); });
            queueMicrotask(() => {
                child.emit('error', new Error('child_process.exec() requires shell interpreter'));
            });
            return child;
        }
        const run = executeCapture;
        queueMicrotask(async () => {
            try {
                const output = await run(cmd);
                if (callback)
                    callback(null, output, '');
                child.emit('close', 0);
            }
            catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                if (callback)
                    callback(err, '', err.message);
                child.emit('close', 1);
            }
        });
        return child;
    }
    function execSync() {
        throw new Error('child_process.execSync() is not supported in Lifo');
    }
    function spawn() {
        throw new Error('child_process.spawn() is not supported in Lifo');
    }
    function fork() {
        throw new Error('child_process.fork() is not supported in Lifo');
    }
    return { exec, execSync, spawn, fork };
}
