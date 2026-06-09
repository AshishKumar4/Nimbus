import { format } from './util.js';
export function createConsole(stdout, stderr) {
    const timers = new Map();
    return {
        log: (...args) => {
            stdout.write(format(args[0], ...args.slice(1)) + '\n');
        },
        info: (...args) => {
            stdout.write(format(args[0], ...args.slice(1)) + '\n');
        },
        warn: (...args) => {
            stderr.write(format(args[0], ...args.slice(1)) + '\n');
        },
        error: (...args) => {
            stderr.write(format(args[0], ...args.slice(1)) + '\n');
        },
        debug: (...args) => {
            stdout.write(format(args[0], ...args.slice(1)) + '\n');
        },
        dir: (obj) => {
            stdout.write(format('%o', obj) + '\n');
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
                stdout.write(`${label}: ${elapsed.toFixed(3)}ms ${args.map((a) => format('%o', a)).join(' ')}\n`);
            }
        },
        trace: (...args) => {
            stderr.write('Trace: ' + format(args[0], ...args.slice(1)) + '\n');
        },
        assert: (condition, ...args) => {
            if (!condition) {
                stderr.write('Assertion failed: ' + (args.length > 0 ? format(args[0], ...args.slice(1)) : '') + '\n');
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
            stdout.write(format('%o', data) + '\n');
        },
    };
}
