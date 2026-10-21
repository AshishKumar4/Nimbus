/**
 * Node's process warnings (lib/internal/process/warning.js and
 * pre_execution.js setupWarningHandler, v22.23.4), for a process Nimbus
 * makes: the worker's node shims (as a preamble) and lifo's node
 * (substrate/lifo/node-compat/process.ts). process.emitWarning makes the
 * warning an Error named for its type and tells the process's 'warning'
 * listeners on the next tick; the listener Node installs writes it,
 * "(node:<pid>) [<code>] <Type>: <message>", the first time with how to
 * trace it. --disable-warning and --redirect-warnings are not read.
 */

import { captureStack, invalidArgType, isErrorStackTraceLimitWritable } from './node-error.js';

/** A function a warning's stack starts above (process.emitWarning's `ctor`). */
export type WarningConstructor = (...args: never[]) => unknown;

/** process.emitWarning's options form. */
export interface WarningOptions {
  type?: string;
  code?: string;
  detail?: string;
  ctor?: WarningConstructor;
}

/** What Node's warnings read off the process, and how they reach its listeners. */
export interface WarningProcess {
  readonly pid: number;
  readonly argv0?: string;
  readonly release: { readonly name: string };
  readonly env: Readonly<Record<string, string | undefined>>;
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  traceDeprecation?: boolean;
  traceProcessWarnings?: boolean;
  emitWarning(warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void;
  nextTick(callback: () => void): void;
  emit(event: 'warning', warning: Error): boolean;
}

export interface ProcessWarnings {
  /** process.emitWarning. */
  emitWarning(warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void;
  /** The 'warning' listener Node installs; `write` takes each warning's text. */
  onWarning(warning: unknown): void;
  /** Whether Node would install it: not under NODE_NO_WARNINGS=1 or NODE_OPTIONS' --no-warnings. */
  readonly installs: boolean;
  /** Drops the warnings whose tick has not run: an uncaught exception that ends the process runs no more ticks. */
  dropQueued(): void;
}

/** Node's warnings for `process` (read when a warning is made, so a process made after may be named). */
export function createProcessWarnings(process: () => WarningProcess, write: (text: string) => void): ProcessWarnings {
  let traceHintWritten = false;
  // Bumped by dropQueued: a tick queued before it does nothing.
  let generation = 0;
  return {
    emitWarning(warning, type, code, ctor) {
      const proc = process();
      if (proc.noDeprecation && type === 'DeprecationWarning') return;
      let name = type;
      let detail: string | undefined;
      if (typeof type === 'object' && type !== null && !Array.isArray(type)) {
        ctor = type.ctor;
        code = type.code;
        if (typeof type.detail === 'string') detail = type.detail;
        name = type.type || 'Warning';
      } else if (typeof type === 'function') {
        ctor = type;
        code = undefined;
        name = 'Warning';
      }
      if (name !== undefined && typeof name !== 'string') throw invalidArgType('type', 'string', name);
      if (typeof code === 'function') {
        ctor = code;
        code = undefined;
      } else if (code !== undefined && typeof code !== 'string') {
        throw invalidArgType('code', 'string', code);
      }
      let told: Error;
      if (typeof warning === 'string') {
        // Made without frames; captureStack adds them from above `ctor`.
        const limit: number = Reflect.get(Error, 'stackTraceLimit');
        const writable = isErrorStackTraceLimitWritable();
        if (writable) Reflect.set(Error, 'stackTraceLimit', 0);
        told = new Error(warning);
        if (writable) Reflect.set(Error, 'stackTraceLimit', limit);
        told.name = String(name || 'Warning');
        if (code !== undefined) Object.assign(told, { code });
        if (detail !== undefined) Object.assign(told, { detail });
        captureStack(told, ctor ?? proc.emitWarning);
      } else if (warning instanceof Error) {
        told = warning;
      } else {
        throw invalidArgType('warning', ['Error', 'string'], warning);
      }
      if (told.name === 'DeprecationWarning') {
        if (proc.noDeprecation) return;
        if (proc.throwDeprecation) {
          const at = generation;
          proc.nextTick(() => { if (at === generation) throw told; });
          return;
        }
      }
      const at = generation;
      proc.nextTick(() => { if (at === generation) proc.emit('warning', told); });
    },
    dropQueued() {
      generation++;
    },
    onWarning(warning) {
      if (!(warning instanceof Error)) return;
      const proc = process();
      const isDeprecation = warning.name === 'DeprecationWarning';
      if (isDeprecation && proc.noDeprecation) return;
      const trace = proc.traceProcessWarnings || (isDeprecation && proc.traceDeprecation);
      let text = `(${proc.release.name}:${proc.pid}) `;
      if ('code' in warning && warning.code) text += `[${String(warning.code)}] `;
      if (trace && warning.stack) text += warning.stack;
      else text += typeof warning.toString === 'function' ? `${warning.toString()}` : Error.prototype.toString.call(warning);
      if ('detail' in warning && typeof warning.detail === 'string') text += `\n${warning.detail}`;
      if (!trace && !traceHintWritten) {
        const program = String(proc.argv0 || 'node');
        const base = program.slice(program.lastIndexOf('/') + 1);
        const argv0 = base.endsWith('.exe') && base !== '.exe' ? base.slice(0, -4) : base;
        text += `\n(Use \`${argv0} ${isDeprecation ? '--trace-deprecation' : '--trace-warnings'} ...\` to show where the warning was created)`;
        traceHintWritten = true;
      }
      write(text);
    },
    get installs() {
      const env = process().env;
      return env.NODE_NO_WARNINGS !== '1' && !String(env.NODE_OPTIONS || '').split(/\s+/).includes('--no-warnings');
    },
  };
}
