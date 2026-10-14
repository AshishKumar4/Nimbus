import type { Console as EngineConsole } from 'node:console';
import realm from 'node:process';
import type { InspectOptions } from 'node:util';
import type { CommandOutputStream } from '../commands/types.js';

/** A line as Node's console writes it: the engine's own util.format. */
const format = (...args: unknown[]): string => realm.getBuiltinModule('node:util').format(...args);

export function createConsole(stdout: CommandOutputStream, stderr: CommandOutputStream) {
  const timers = new Map<string, number>();

  return {
    log: (...args: unknown[]) => {
      stdout.write(format(...args) + '\n');
    },
    info: (...args: unknown[]) => {
      stdout.write(format(...args) + '\n');
    },
    warn: (...args: unknown[]) => {
      stderr.write(format(...args) + '\n');
    },
    error: (...args: unknown[]) => {
      stderr.write(format(...args) + '\n');
    },
    debug: (...args: unknown[]) => {
      stdout.write(format(...args) + '\n');
    },
    dir: (obj: unknown, options?: InspectOptions) => {
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
      } else {
        stderr.write(`Warning: No such label '${label}' for console.timeEnd()\n`);
      }
    },
    timeLog: (label = 'default', ...args: unknown[]) => {
      const start = timers.get(label);
      if (start !== undefined) {
        const elapsed = performance.now() - start;
        stdout.write(format('%s: %s', label, `${elapsed.toFixed(3)}ms`, ...args) + '\n');
      }
    },
    trace: (...args: unknown[]) => {
      stderr.write('Trace: ' + format(...args) + '\n');
    },
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) {
        stderr.write('Assertion failed: ' + (args.length > 0 ? format(...args) : '') + '\n');
      }
    },
    clear: () => { /* no-op */ },
    count: (() => {
      const counts = new Map<string, number>();
      return (label = 'default') => {
        const count = (counts.get(label) ?? 0) + 1;
        counts.set(label, count);
        stdout.write(`${label}: ${count}\n`);
      };
    })(),
    countReset: () => { /* no-op */ },
    group: () => { /* no-op */ },
    groupEnd: () => { /* no-op */ },
    table: (data: unknown) => {
      stdout.write(format(data) + '\n');
    },
    /** The engine's Console class, as Node's console has it (loaded when first reached). */
    get Console(): typeof EngineConsole {
      return realm.getBuiltinModule('node:console').Console;
    },
  };
}
