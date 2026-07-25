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
export function generateStreamsCode() {
    return `
// ═══════════════════════════════════════════════════════════════════════
// ── Node-compatible Streams (Nimbus v2.0) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const __streamMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();
  const _Decoder = TextDecoder;

  // ── Readable ────────────────────────────────────────────────────────
  //
  // Node's read machinery is a PULL: the consumer's demand is what causes
  // \`_read()\` to be called. Two consumer idioms create demand implicitly —
  // attaching a 'data' listener and \`.pipe()\` — and both put the stream in
  // flowing mode. Honouring that is not cosmetic: a source whose \`_read()\`
  // is never called produces nothing at all, so
  // \`fs.createReadStream(f).on('data', …)\` and \`.pipe(res)\` hang forever
  // (every static file server, and the doom-web asset serve, are exactly
  // this shape). \`_flow\` below is the single pump used by flowing mode,
  // \`read()\`, and the async iterator, so a source that pushes
  // ASYNCHRONOUSLY (a live VFS range read) works through all three.
  class Readable extends __eventsMod {
    constructor(opts) {
      super();
      this._readableState = {
        buffer: [],
        ended: false,
        endEmitted: false,
        flowing: null,
        // reading — a _read() call is outstanding: no push() and no EOF has
        // landed since. Keeps the pump from stacking redundant _read calls
        // while an async source is in flight.
        reading: false,
        pumping: false,
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

    /** Ask the source for more, unless it already owes us a push or is done. */
    _maybeRead() {
      const state = this._readableState;
      if (state.reading || state.ended || state.destroyed) return;
      state.reading = true;
      try { this._read(state.highWaterMark); }
      catch (err) { state.reading = false; this.destroy(err); }
    }

    _shift() {
      const state = this._readableState;
      const chunk = state.buffer.shift();
      state.readableLength -= (chunk?.length || 0);
      return this._decode(chunk);
    }

    _decode(chunk) {
      const enc = this._readableState.encoding;
      if (!enc || enc === 'buffer' || !(chunk instanceof Uint8Array)) return chunk;
      try { return new _Decoder(enc === 'binary' ? 'latin1' : enc).decode(chunk); }
      catch { return chunk; }
    }

    _maybeEmitEnd() {
      const state = this._readableState;
      if (state.ended && state.buffer.length === 0 && !state.endEmitted) {
        state.endEmitted = true;
        this.readable = false;
        this.emit('end');
        return true;
      }
      return false;
    }

    /**
     * Drain buffered chunks to 'data' listeners while flowing, then ask the
     * source for more. Deferred to a microtask so a synchronous \`push()\`
     * from inside \`_read()\` cannot recurse into the stack.
     */
    _flow() {
      const state = this._readableState;
      if (state.pumping) return;
      state.pumping = true;
      queueMicrotask(() => {
        state.pumping = false;
        while (state.flowing && state.buffer.length > 0 && !state.destroyed) {
          this.emit('data', this._shift());
        }
        if (this._maybeEmitEnd()) return;
        if (state.flowing && !state.destroyed) this._maybeRead();
      });
    }

    read(size) {
      const state = this._readableState;
      if (state.buffer.length === 0) {
        if (state.ended) return null;
        this._maybeRead();
        if (state.buffer.length === 0) return null;
      }
      const chunk = this._shift();
      if (state.buffer.length === 0 && state.ended && !state.endEmitted) {
        state.endEmitted = true;
        this.readable = false;
        queueMicrotask(() => this.emit('end'));
      }
      return chunk;
    }

    push(chunk, encoding) {
      const state = this._readableState;
      state.reading = false;
      if (chunk === null) {
        state.ended = true;
        if (state.flowing) this._flow();
        else if (state.buffer.length === 0 && !state.endEmitted) {
          state.endEmitted = true;
          this.readable = false;
          queueMicrotask(() => this.emit('end'));
        }
        return false;
      }
      if (typeof chunk === 'string' && !state.objectMode) {
        chunk = _enc.encode(chunk);
      }
      state.buffer.push(chunk);
      state.readableLength += (chunk?.length || 0);
      if (state.flowing) this._flow();
      return state.readableLength < state.highWaterMark;
    }

    // Node switches to flowing mode when a 'data' listener is attached,
    // unless the consumer explicitly called pause().
    on(event, listener) {
      const result = super.on(event, listener);
      if (event === 'data' && this._readableState.flowing !== false) this.resume();
      return result;
    }
    addListener(event, listener) { return this.on(event, listener); }

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
      if (state.flowing !== true) {
        state.flowing = true;
        this._flow();
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
      this.readable = false;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }

    get readableEnded() { return this._readableState.endEmitted; }
    get readableLength() { return this._readableState.readableLength; }
    get readableFlowing() { return this._readableState.flowing; }

    // One chunk per tick: resume, take the next 'data', pause again. Uses
    // the same pump as flowing mode, so an asynchronous source works here
    // too (the old implementation called read() once and then waited for a
    // 'data' event that nothing would ever emit in paused mode).
    [Symbol.asyncIterator]() {
      const self = this;
      const state = self._readableState;
      const iterator = {
        next() {
          return new Promise((resolve, reject) => {
            if (state.buffer.length > 0) {
              const chunk = self._shift();
              self._maybeEmitEnd();
              return resolve({ value: chunk, done: false });
            }
            if (state.ended || state.destroyed) return resolve({ value: undefined, done: true });
            const cleanup = () => {
              self.off('data', onData);
              self.off('end', onEnd);
              self.off('error', onError);
            };
            const onData = (c) => { cleanup(); self.pause(); resolve({ value: c, done: false }); };
            const onEnd = () => { cleanup(); resolve({ value: undefined, done: true }); };
            const onError = (e) => { cleanup(); reject(e); };
            self.once('data', onData);
            self.once('end', onEnd);
            self.once('error', onError);
            self.resume();
          });
        },
        return() {
          self.destroy();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() { return iterator; },
      };
      return iterator;
    }
  }

  // ── Readable.from / Readable.fromWeb ────────────────────────────────
  // Node exposes these statics; libraries that stream a fetch
  // \`response.body\` (a web ReadableStream) into a Node pipeline rely on
  // \`Readable.fromWeb\` (giget's template download:
  // \`pipeline(response.body, createWriteStream(...))\`). A web
  // ReadableStream has no \`.pipe\`, so it must be adapted first.
  Readable.from = function from(iterable, opts) {
    const r = new Readable({ objectMode: opts?.objectMode ?? false, ...opts });
    r._read = () => {};
    (async () => {
      try {
        for await (const chunk of iterable) r.push(chunk);
        r.push(null);
      } catch (err) { r.destroy(err); }
    })();
    return r;
  };
  Readable.fromWeb = function fromWeb(webStream, opts) {
    const r = new Readable({ ...opts });
    const reader = webStream.getReader();
    r._read = () => {};
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { r.push(null); break; }
          r.push(value);
        }
      } catch (err) { r.destroy(err); }
    })();
    return r;
  };

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
    // Adapt non-Node sources (web ReadableStream from fetch, async
    // iterables) to a Node Readable so \`.pipe\` exists. Node's pipeline
    // performs the same normalization via Readable.from/fromWeb.
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      if (s && typeof s.pipe !== 'function') {
        if (typeof s.getReader === 'function') streams[i] = Readable.fromWeb(s);
        else if (s[Symbol.asyncIterator] || s[Symbol.iterator]) streams[i] = Readable.from(s);
      }
    }
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

  // Real Node's \`require('stream')\` IS the legacy \`Stream\` constructor
  // (a function extending EventEmitter), carrying Readable/Writable/etc.
  // as own properties. Userland relies on this in two ways:
  //   - \`class X extends require('stream')\` / \`util.inherits(X, stream)\`
  //     (minipass — bundled by degit/create-cloudflare — does
  //     \`class Minipass extends Stream__default['default']\`).
  //   - \`require('stream').prototype\` for prototype chaining
  //     (readable-stream@2 _stream_writable.js, send/index.js).
  // A plain namespace object satisfies neither: it is not a constructor,
  // so \`class extends\` throws "Class extends value is not a constructor".
  // Make the export the Stream constructor itself with the named exports
  // attached, mirroring Node exactly.
  class Stream extends __eventsMod {
    pipe(dest, opts) {
      const src = this;
      src.on('data', (chunk) => { dest.write(chunk); });
      src.on('end', () => { if (!opts || opts.end !== false) dest.end(); });
      return dest;
    }
  }
  // ── stream state introspection (node:stream named helpers) ─────────
  // Modern libraries (e.g. those bundled by create-cloudflare) call these
  // off the stream module. They read the public stream state flags.
  const isErrored = (s) => !!(s && (s.errored || (s._readableState && s._readableState.errored) || (s._writableState && s._writableState.errored)));
  const isReadable = (s) => !!(s && s.readable && !(s._readableState && s._readableState.endEmitted));
  const isWritable = (s) => !!(s && s.writable && !(s._writableState && s._writableState.finished));
  const isDisturbed = (s) => !!(s && (s.readableDidRead || (s._readableState && (s._readableState.dataEmitted || s._readableState.endEmitted))));
  const addAbortSignal = (signal, stream) => {
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { stream.destroy(new Error('AbortError')); }, { once: true });
    }
    return stream;
  };

  const __streamMod = Object.assign(Stream, {
    Readable, Writable, Duplex, Transform, PassThrough,
    Stream,
    pipeline, finished,
    isErrored, isReadable, isWritable, isDisturbed, addAbortSignal,
    // Aliases for compatibility
    _Readable: Readable, _Writable: Writable, _Transform: Transform,
  });
  return __streamMod;
})();
`;
}
