/**
 * streams.ts — Node.js-compatible stream classes for Nimbus v2.0.
 *
 * These are generated as raw JS strings (like node-shims.ts) and
 * embedded in the dynamic worker code. They implement the Node
 * stream contract: Readable, Writable, Transform, Duplex, PassThrough,
 * pipeline(), and finished().
 *
 * Backpressure: write() returns false when the internal buffer exceeds
 * highWaterMark, and emits 'drain' when the buffer is flushed.
 */

export function generateStreamsCode(): string {
  return `
// ═══════════════════════════════════════════════════════════════════════
// ── Node-compatible Streams (Nimbus v2.0) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const __streamMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ── Readable ────────────────────────────────────────────────────────
  class Readable extends __eventsMod {
    constructor(opts) {
      super();
      this._readableState = {
        buffer: [],
        ended: false,
        endEmitted: false,
        flowing: null,
        highWaterMark: opts?.highWaterMark ?? 16384,
        encoding: opts?.encoding || null,
        objectMode: opts?.objectMode ?? false,
        destroyed: false,
        readableLength: 0,
      };
      this.readable = true;
      if (opts?.read) this._read = opts.read.bind(this);
    }

    _read(size) { /* override in subclass */ }

    read(size) {
      const state = this._readableState;
      if (state.buffer.length === 0) {
        if (state.ended) return null;
        this._read(size || state.highWaterMark);
        return state.buffer.length > 0 ? state.buffer.shift() : null;
      }
      const chunk = state.buffer.shift();
      state.readableLength -= (chunk?.length || 0);
      if (state.buffer.length === 0 && state.ended && !state.endEmitted) {
        state.endEmitted = true;
        queueMicrotask(() => this.emit('end'));
      }
      return chunk;
    }

    push(chunk, encoding) {
      const state = this._readableState;
      if (chunk === null) {
        state.ended = true;
        if (state.buffer.length === 0 && !state.endEmitted) {
          state.endEmitted = true;
          queueMicrotask(() => this.emit('end'));
        }
        return false;
      }
      if (typeof chunk === 'string' && !state.objectMode) {
        chunk = _enc.encode(chunk);
      }
      state.buffer.push(chunk);
      state.readableLength += (chunk?.length || 0);
      if (state.flowing) {
        queueMicrotask(() => {
          while (state.buffer.length > 0 && state.flowing) {
            const c = state.buffer.shift();
            state.readableLength -= (c?.length || 0);
            this.emit('data', c);
          }
          // After draining, fire 'end' if push(null) was queued but
          // deferred because the buffer was non-empty at the time.
          // Guarded by endEmitted so a concurrent .read() drain doesn't
          // double-fire (W8 fix: real Node uses an endEmitted flag).
          if (state.ended && state.buffer.length === 0 && !state.endEmitted) {
            state.endEmitted = true;
            this.emit('end');
          }
        });
      }
      return state.readableLength < state.highWaterMark;
    }

    pipe(dest, opts) {
      this.on('data', (chunk) => {
        const canContinue = dest.write(chunk);
        if (!canContinue) {
          this.pause();
          dest.once('drain', () => this.resume());
        }
      });
      this.on('end', () => {
        if (opts?.end !== false) dest.end();
      });
      this.resume();
      return dest;
    }

    unpipe(dest) {
      this.removeAllListeners('data');
      return this;
    }

    resume() {
      const state = this._readableState;
      if (!state.flowing) {
        state.flowing = true;
        queueMicrotask(() => {
          while (state.buffer.length > 0 && state.flowing) {
            const chunk = state.buffer.shift();
            state.readableLength -= (chunk?.length || 0);
            this.emit('data', chunk);
          }
          if (state.ended && state.buffer.length === 0 && !state.endEmitted) {
            state.endEmitted = true;
            this.emit('end');
          }
        });
      }
      return this;
    }

    pause() {
      this._readableState.flowing = false;
      return this;
    }

    setEncoding(enc) {
      this._readableState.encoding = enc;
      return this;
    }

    destroy(err) {
      if (this._readableState.destroyed) return this;
      this._readableState.destroyed = true;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }

    get readableEnded() { return this._readableState.ended; }
    get readableLength() { return this._readableState.readableLength; }
    get readableFlowing() { return this._readableState.flowing; }

    [Symbol.asyncIterator]() {
      const self = this;
      return {
        next() {
          return new Promise((resolve) => {
            const chunk = self.read();
            if (chunk !== null) return resolve({ value: chunk, done: false });
            if (self._readableState.ended) return resolve({ value: undefined, done: true });
            const onData = (c) => { self.off('end', onEnd); resolve({ value: c, done: false }); };
            const onEnd = () => { self.off('data', onData); resolve({ value: undefined, done: true }); };
            self.once('data', onData);
            self.once('end', onEnd);
          });
        },
      };
    }
  }

  // ── Writable ────────────────────────────────────────────────────────
  class Writable extends __eventsMod {
    constructor(opts) {
      super();
      this._writableState = {
        buffer: [],
        ended: false,
        finished: false,
        highWaterMark: opts?.highWaterMark ?? 16384,
        needDrain: false,
        destroyed: false,
        corked: 0,
        bufferedLength: 0,
      };
      this.writable = true;
      if (opts?.write) this._write = opts.write.bind(this);
      if (opts?.final) this._final = opts.final.bind(this);
      if (opts?.destroy) this._destroy = opts.destroy.bind(this);
    }

    _write(chunk, encoding, callback) { callback(); }
    _final(callback) { callback(); }

    write(chunk, encoding, callback) {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      const state = this._writableState;
      if (state.ended) {
        const err = new Error('write after end');
        if (callback) callback(err);
        this.emit('error', err);
        return false;
      }
      if (typeof chunk === 'string') chunk = _enc.encode(chunk);

      if (state.corked > 0) {
        state.buffer.push({ chunk, callback });
        state.bufferedLength += (chunk?.length || 0);
        return state.bufferedLength < state.highWaterMark;
      }

      state.bufferedLength += (chunk?.length || 0);
      this._write(chunk, encoding, (err) => {
        state.bufferedLength -= (chunk?.length || 0);
        if (err) { if (callback) callback(err); this.emit('error', err); return; }
        if (callback) callback();
        if (state.needDrain && state.bufferedLength < state.highWaterMark) {
          state.needDrain = false;
          this.emit('drain');
        }
      });

      if (state.bufferedLength >= state.highWaterMark) {
        state.needDrain = true;
        return false;
      }
      return true;
    }

    end(chunk, encoding, callback) {
      if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      const state = this._writableState;
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      state.ended = true;
      this._final((err) => {
        state.finished = true;
        if (err) this.emit('error', err);
        this.emit('finish');
        if (callback) callback(err);
      });
      return this;
    }

    cork() { this._writableState.corked++; }

    uncork() {
      const state = this._writableState;
      if (state.corked > 0) state.corked--;
      if (state.corked === 0 && state.buffer.length > 0) {
        const buf = [...state.buffer];
        state.buffer = [];
        for (const { chunk, callback } of buf) {
          this._write(chunk, undefined, (err) => {
            state.bufferedLength -= (chunk?.length || 0);
            if (callback) callback(err);
          });
        }
      }
    }

    destroy(err) {
      if (this._writableState.destroyed) return this;
      this._writableState.destroyed = true;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }

    get writableEnded() { return this._writableState.ended; }
    get writableFinished() { return this._writableState.finished; }
    get writableLength() { return this._writableState.bufferedLength; }
  }

  // ── Duplex ──────────────────────────────────────────────────────────
  class Duplex extends Readable {
    constructor(opts) {
      super(opts);
      // Mixin Writable state
      this._writableState = {
        buffer: [],
        ended: false,
        finished: false,
        highWaterMark: opts?.writableHighWaterMark ?? opts?.highWaterMark ?? 16384,
        needDrain: false,
        destroyed: false,
        corked: 0,
        bufferedLength: 0,
      };
      this.writable = true;
      if (opts?.write) this._write = opts.write.bind(this);
      if (opts?.final) this._final = opts.final.bind(this);
    }
    _write(chunk, encoding, callback) { callback(); }
    _final(callback) { callback(); }
    write(chunk, encoding, callback) { return Writable.prototype.write.call(this, chunk, encoding, callback); }
    end(chunk, encoding, callback) { return Writable.prototype.end.call(this, chunk, encoding, callback); }
    cork() { Writable.prototype.cork.call(this); }
    uncork() { Writable.prototype.uncork.call(this); }
  }

  // ── Transform ───────────────────────────────────────────────────────
  class Transform extends Duplex {
    constructor(opts) {
      super(opts);
      if (opts?.transform) this._transform = opts.transform.bind(this);
      if (opts?.flush) this._flush = opts.flush.bind(this);
    }

    _transform(chunk, encoding, callback) { callback(null, chunk); }
    _flush(callback) { callback(); }

    _write(chunk, encoding, callback) {
      this._transform(chunk, encoding, (err, data) => {
        if (err) return callback(err);
        if (data !== null && data !== undefined) this.push(data);
        callback();
      });
    }

    _final(callback) {
      this._flush((err, data) => {
        if (err) return callback(err);
        if (data !== null && data !== undefined) this.push(data);
        this.push(null);
        callback();
      });
    }
  }

  // ── PassThrough ─────────────────────────────────────────────────────
  class PassThrough extends Transform {
    constructor(opts) { super(opts); }
    _transform(chunk, encoding, callback) { callback(null, chunk); }
  }

  // ── pipeline ────────────────────────────────────────────────────────
  function pipeline(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const streams = args;
    if (streams.length < 2) {
      if (callback) callback(new Error('pipeline requires at least 2 streams'));
      return streams[0];
    }
    let error = null;
    for (let i = 0; i < streams.length - 1; i++) {
      const src = streams[i];
      const dst = streams[i + 1];
      src.pipe(dst);
      src.on('error', (e) => { error = e; dst.destroy(e); });
    }
    const last = streams[streams.length - 1];
    last.on('finish', () => { if (callback) callback(error); });
    last.on('error', (e) => { if (!error) { error = e; } if (callback) callback(error); });
    return last;
  }

  // ── finished ────────────────────────────────────────────────────────
  function finished(stream, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    const onFinish = () => { cleanup(); if (callback) callback(null); };
    const onEnd = () => { cleanup(); if (callback) callback(null); };
    const onError = (err) => { cleanup(); if (callback) callback(err); };
    const onClose = () => { cleanup(); if (callback) callback(null); };
    stream.on('finish', onFinish);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
    function cleanup() {
      stream.off('finish', onFinish);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    }
    return cleanup;
  }

  // X.5-Z5 Defect-A fix: real Node's \`require('stream')\` returns the
  // legacy Stream class (a function) with Readable/Writable/etc. as own
  // properties. Userland code (notably readable-stream@2's
  // _stream_writable.js:96 and \`send/index.js\`'s util.inherits(SendStream,
  // require('stream'))) reads \`Stream.prototype\` for prototype chaining.
  // Our namespace-object shape lacks it, so Object.create(stream.prototype, ...)
  // throws "Object prototype may only be an Object or null: undefined".
  // Plant a non-enumerable .prototype pointing at Readable.prototype to
  // satisfy that contract without breaking any other access pattern.
  // See audit/sections/X5Z5-plan.md §1.3 Primary fix.
  const __streamMod = {
    Readable, Writable, Duplex, Transform, PassThrough,
    Stream: Readable,
    pipeline, finished,
    // Aliases for compatibility
    _Readable: Readable, _Writable: Writable, _Transform: Transform,
  };
  Object.defineProperty(__streamMod, 'prototype', {
    value: Readable.prototype, enumerable: false,
  });
  return __streamMod;
})();
`;
}
