/**
 * Node.js `readline` module shim for Lifo.
 *
 * Provides Interface (createInterface), clearLine, clearScreenDown,
 * cursorTo, moveCursor, and the promises API.
 */
import { EventEmitter } from './events.js';
export class Interface extends EventEmitter {
    _prompt;
    _output;
    _closed = false;
    _lines = [];
    terminal;
    constructor(opts = {}) {
        super();
        this._prompt = opts.prompt ?? '> ';
        this._output = opts.output;
        this.terminal = opts.terminal ?? false;
        // Listen for data on input if provided
        if (opts.input?.on) {
            opts.input.on('data', (chunk) => {
                if (this._closed)
                    return;
                const lines = String(chunk).split(/\r?\n/);
                for (const line of lines) {
                    if (line !== '') {
                        this._lines.push(line);
                        this.emit('line', line);
                    }
                }
            });
            opts.input.on('end', () => {
                if (!this._closed)
                    this.close();
            });
        }
    }
    setPrompt(prompt) {
        this._prompt = prompt;
    }
    getPrompt() {
        return this._prompt;
    }
    prompt(preserveCursor = false) {
        if (this._closed)
            return;
        void preserveCursor;
        this._output?.write?.(this._prompt);
    }
    write(data) {
        if (this._closed)
            return;
        const lines = data.split(/\r?\n/);
        for (const line of lines) {
            if (line !== '') {
                this._lines.push(line);
                this.emit('line', line);
            }
        }
    }
    question(query, optionsOrCb, cb) {
        if (this._closed)
            return;
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        this._output?.write?.(query);
        // Answer comes from next line event
        this.once('line', (line) => callback(line));
    }
    close() {
        if (this._closed)
            return;
        this._closed = true;
        this.emit('close');
    }
    pause() {
        this.emit('pause');
        return this;
    }
    resume() {
        this.emit('resume');
        return this;
    }
    getCursorPos() {
        return { rows: 0, cols: 0 };
    }
    get closed() {
        return this._closed;
    }
    [Symbol.asyncIterator]() {
        const iface = this;
        const queue = [];
        let resolveNext = null;
        iface.on('line', (line) => {
            if (resolveNext) {
                const r = resolveNext;
                resolveNext = null;
                r({ value: line, done: false });
            }
            else {
                queue.push(line);
            }
        });
        iface.on('close', () => {
            if (resolveNext) {
                const r = resolveNext;
                resolveNext = null;
                r({ value: undefined, done: true });
            }
        });
        return {
            next() {
                if (queue.length > 0) {
                    return Promise.resolve({ value: queue.shift(), done: false });
                }
                if (iface._closed) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => { resolveNext = resolve; });
            },
            return() {
                iface.close();
                return Promise.resolve({ value: undefined, done: true });
            },
            throw(err) {
                iface.close();
                return Promise.reject(err);
            },
            [Symbol.asyncIterator]() { return this; },
        };
    }
}
export function createInterface(inputOrOpts, output) {
    if (inputOrOpts && typeof inputOrOpts === 'object' && ('input' in inputOrOpts || 'output' in inputOrOpts || 'prompt' in inputOrOpts)) {
        return new Interface(inputOrOpts);
    }
    return new Interface({ input: inputOrOpts, output });
}
export function clearLine(stream, dir, cb) {
    const mode = dir < 0 ? 1 : dir > 0 ? 0 : 2;
    stream.write?.(`\x1b[${mode}K`);
    cb?.();
    return true;
}
export function clearScreenDown(stream, cb) {
    stream.write?.('\x1b[0J');
    cb?.();
    return true;
}
export function cursorTo(stream, x, y, cb) {
    if (typeof y === 'function') {
        cb = y;
        y = undefined;
    }
    const col = Math.max(0, Math.floor(Number(x) || 0)) + 1;
    if (y === undefined) {
        stream.write?.(`\x1b[${col}G`);
    }
    else {
        const row = Math.max(0, Math.floor(Number(y) || 0)) + 1;
        stream.write?.(`\x1b[${row};${col}H`);
    }
    cb?.();
    return true;
}
export function moveCursor(stream, dx, dy, cb) {
    const x = Math.trunc(Number(dx) || 0);
    const y = Math.trunc(Number(dy) || 0);
    if (x < 0)
        stream.write?.(`\x1b[${-x}D`);
    else if (x > 0)
        stream.write?.(`\x1b[${x}C`);
    if (y < 0)
        stream.write?.(`\x1b[${-y}A`);
    else if (y > 0)
        stream.write?.(`\x1b[${y}B`);
    cb?.();
    return true;
}
export function emitKeypressEvents(_stream) {
    // no-op
}
// readline/promises API
export const promises = {
    createInterface: (opts) => {
        const iface = createInterface(opts);
        const promiseIface = iface;
        const originalQuestion = iface.question.bind(iface);
        promiseIface.question = (query, _options) => {
            return new Promise((resolve) => {
                originalQuestion(query, (answer) => resolve(answer));
            });
        };
        return promiseIface;
    },
};
export default {
    Interface,
    createInterface,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    emitKeypressEvents,
    promises,
};
