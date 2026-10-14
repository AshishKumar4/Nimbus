import realm from 'node:process';
/** A line as Node's console writes it: the engine's own util.format. */
const format = (...args) => realm.getBuiltinModule('node:util').format(...args);
export function createConsole(stdout, stderr) {
    const timers = new Map();
    return {
        log: (...args) => {
            stdout.write(format(...args) + '\n');
        },
        info: (...args) => {
            stdout.write(format(...args) + '\n');
        },
        warn: (...args) => {
            stderr.write(format(...args) + '\n');
        },
        error: (...args) => {
            stderr.write(format(...args) + '\n');
        },
        debug: (...args) => {
            stdout.write(format(...args) + '\n');
        },
        dir: (obj, options) => {
            stdout.write(realm.getBuiltinModule('node:util').inspect(obj, { customInspect: false, ...options }) + '\n');
        },
        time: (label = 'default') => {
            timers.set(label, performance.now());
        },
        timeEnd: (label = 'default') => {
            const start = timers.get(label);
            if (start !== undefined) {
                const elapsed = performance.now() - start;
                stdout.write(`${label}: ${elapsed.toFixed(3)}ms\n`);
                timers.delete(label);
            }
            else {
                stderr.write(`Warning: No such label '${label}' for console.timeEnd()\n`);
            }
        },
        timeLog: (label = 'default', ...args) => {
            const start = timers.get(label);
            if (start !== undefined) {
                const elapsed = performance.now() - start;
                stdout.write(format('%s: %s', label, `${elapsed.toFixed(3)}ms`, ...args) + '\n');
            }
        },
        trace: (...args) => {
            stderr.write('Trace: ' + format(...args) + '\n');
        },
        assert: (condition, ...args) => {
            if (!condition) {
                stderr.write('Assertion failed: ' + (args.length > 0 ? format(...args) : '') + '\n');
            }
        },
        clear: () => { },
        count: (() => {
            const counts = new Map();
            return (label = 'default') => {
                const count = (counts.get(label) ?? 0) + 1;
                counts.set(label, count);
                stdout.write(`${label}: ${count}\n`);
            };
        })(),
        countReset: () => { },
        group: () => { },
        groupEnd: () => { },
        table: (data) => {
            stdout.write(format(data) + '\n');
        },
    };
}
