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

  /** Node's ERR_STREAM_DESTROYED, for a write or end() a destroyed stream refuses. */
  function _destroyedError(method) {
    return Object.assign(new Error('Cannot call ' + method + ' after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
  }

  /**
   * Node's errorBuffer: once destroyed, queued writes and end() callbacks
   * are answered, never left waiting on a stream that will not write them.
   */
  function _errorBuffer(state, err) {
    for (const { chunk, callback } of state.buffer.splice(0)) {
      state.bufferedLength -= (chunk?.length || 0);
      state.pending--;
      if (callback) callback(err ?? _destroyedError('write'));
    }
    for (const cb of state.finishCallbacks.splice(0)) cb(err ?? _destroyedError('end'));
  }

  /** Node's errorOrDestroy for the writable side: autoDestroy closes it. */
  function _errorOrDestroy(stream, err) {
    const state = stream._writableState;
    if (state.destroyed) return;
    if (state.autoDestroy) stream.destroy(err);
    else stream.emit('error', err);
  }

  /**
   * Destroy either side of a stream, and both of a Duplex, once: 'error' if
   * given, then 'close' unless the stream was created with emitClose: false.
   */
  function _destroyStream(stream, err) {
    const r = stream._readableState, w = stream._writableState;
    if ((r && r.destroyed) || (w && w.destroyed)) return stream;
    if (r) { r.destroyed = true; stream.readable = false; }
    if (w) {
      w.destroyed = true;
      // A write in flight answers the queue when it calls back.
      if (!w.writing) queueMicrotask(() => _errorBuffer(w));
    }
    if (err) stream.emit('error', err);
    if ((r || w).emitClose) stream.emit('close');
    return stream;
  }

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
        autoDestroy: opts?.autoDestroy !== false,
        emitClose: opts?.emitClose !== false,
        destroyed: false,
        readableLength: 0,
        // A consumer reads it in readable mode: a 'readable' listener, or an
        // async iterator, which owns it for its life. Node's flushStdio
        // leaves such a stream to its consumer.
        readableListening: false,
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
        this._emitEnd();
        return true;
      }
      return false;
    }

    /**
     * 'end', then Node's autoDestroy (on unless the stream opts out): a
     * stream done reading, and done writing if it is a Duplex, is destroyed,
     * so 'close' follows 'end'. Consumers wait on it: node-static ends the
     * response on its file stream's 'close'.
     */
    _emitEnd() {
      this.emit('end');
      const ws = this._writableState;
      if (this._readableState.autoDestroy && (!ws || (ws.autoDestroy && ws.finished))) {
        queueMicrotask(() => this.destroy());
      }
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
        queueMicrotask(() => this._emitEnd());
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
          queueMicrotask(() => this._emitEnd());
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
      else if (event === 'readable') this._readableState.readableListening = true;
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

    destroy(err) { return _destroyStream(this, err); }

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
      state.readableListening = true;
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
    // Node (lib/internal/streams/from.js): object mode unless the caller says
    // otherwise, so values arrive as yielded; and a string or Buffer is
    // emitted whole rather than iterated. http-server streams
    // \`Readable.from(bytes)\` of each text file into the response, which
    // refuses a byte-number chunk.
    const r = new Readable({ ...opts, objectMode: opts?.objectMode ?? true });
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
      r._read = function () { this.push(iterable); this.push(null); };
      return r;
    }
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
  //
  // Node's order (lib/internal/streams/writable.js): one _write at a time,
  // the rest queued; end() waits for every write to call back before
  // _final, 'finish' follows _final's callback, and autoDestroy then closes
  // the stream (a Duplex once its readable side has ended too). An
  // asynchronous _write or _transform is therefore complete, and a
  // Transform's output delivered, before 'finish' and 'close'.
  function _writableState(opts, highWaterMark) {
    return {
      buffer: [],
      writing: false,
      // Writes and _final not yet called back.
      pending: 0,
      ending: false,
      finalCalled: false,
      finished: false,
      finishCallbacks: [],
      highWaterMark,
      needDrain: false,
      autoDestroy: opts?.autoDestroy !== false,
      emitClose: opts?.emitClose !== false,
      destroyed: false,
      corked: 0,
      bufferedLength: 0,
    };
  }

  function _write(stream, chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const state = stream._writableState;
    if (state.ending || state.destroyed) {
      // A destroyed stream reports nothing further; the write's callback is
      // still answered.
      const err = state.ending
        ? Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
        : _destroyedError('write');
      if (state.destroyed) { if (callback) queueMicrotask(() => callback(err)); return false; }
      if (callback) callback(err);
      _errorOrDestroy(stream, err);
      return false;
    }
    if (typeof chunk === 'string') chunk = _enc.encode(chunk);
    state.bufferedLength += (chunk?.length || 0);
    state.pending++;
    const request = { chunk, encoding, callback };
    if (state.writing || state.corked > 0) state.buffer.push(request);
    else _doWrite(stream, request);
    if (state.bufferedLength >= state.highWaterMark) {
      state.needDrain = true;
      return false;
    }
    return true;
  }

  function _doWrite(stream, { chunk, encoding, callback }) {
    const state = stream._writableState;
    state.writing = true;
    let called = false;
    stream._write(chunk, encoding, (err) => {
      if (called) return;
      called = true;
      state.writing = false;
      state.bufferedLength -= (chunk?.length || 0);
      state.pending--;
      if (err) {
        // Node's onwriteError: this callback, then the queue, then 'error'
        // unless the stream was destroyed.
        if (callback) callback(err);
        _errorBuffer(state, err);
        _errorOrDestroy(stream, err);
        return;
      }
      // The next queued write starts before this one's callback, then
      // 'drain', as Node's onwrite/afterWrite order them.
      if (state.buffer.length > 0 && state.corked === 0 && !state.destroyed) _doWrite(stream, state.buffer.shift());
      if (state.needDrain && state.bufferedLength === 0 && !state.ending) {
        state.needDrain = false;
        stream.emit('drain');
      }
      if (callback) callback();
      if (state.destroyed) _errorBuffer(state);
      else _finishMaybe(stream);
    });
  }

  function _end(stream, chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const state = stream._writableState;
    if (chunk !== undefined && chunk !== null) _write(stream, chunk, encoding);
    if (state.corked > 0) { state.corked = 1; _uncork(stream); }
    if (callback) {
      if (state.finished) queueMicrotask(() => callback());
      else state.finishCallbacks.push(callback);
    }
    if (!state.ending) {
      state.ending = true;
      // A stream ended with nothing in flight finishes on a later tick.
      queueMicrotask(() => _finishMaybe(stream));
    }
    return stream;
  }

  function _uncork(stream) {
    const state = stream._writableState;
    if (state.corked > 0) state.corked--;
    if (state.corked === 0 && !state.writing && state.buffer.length > 0) _doWrite(stream, state.buffer.shift());
  }

  /** _final, then 'finish', once end() was called and every write called back. */
  function _finishMaybe(stream) {
    const state = stream._writableState;
    if (!state.ending || state.finished || state.writing || state.buffer.length > 0 || state.pending > 0 || state.destroyed) return;
    if (!state.finalCalled && typeof stream._final === 'function') {
      state.finalCalled = true;
      state.pending++;
      let called = false;
      const onFinal = (err) => {
        if (called) return;
        called = true;
        state.pending--;
        if (err) {
          for (const cb of state.finishCallbacks.splice(0)) cb(err);
          _errorOrDestroy(stream, err);
          return;
        }
        queueMicrotask(() => _finish(stream));
      };
      try { stream._final(onFinal); } catch (err) { onFinal(err); }
      return;
    }
    if (!state.finalCalled) {
      state.finalCalled = true;
      _finish(stream);
    }
  }

  function _finish(stream) {
    const state = stream._writableState;
    if (state.finished || state.destroyed) return;
    state.finished = true;
    for (const cb of state.finishCallbacks.splice(0)) cb();
    stream.emit('finish');
    // autoDestroy, as Readable's _emitEnd: 'close' follows 'finish', for a
    // Duplex once its readable side has ended too.
    const rs = stream._readableState;
    if (state.autoDestroy && (!rs || (rs.autoDestroy && rs.endEmitted))) queueMicrotask(() => stream.destroy());
  }

  class Writable extends __eventsMod {
    constructor(opts) {
      super();
      this._writableState = _writableState(opts, opts?.highWaterMark ?? 16384);
      this.writable = true;
      if (opts?.write) this._write = opts.write.bind(this);
      if (opts?.final) this._final = opts.final.bind(this);
      if (opts?.destroy) this._destroy = opts.destroy.bind(this);
    }

    _write(chunk, encoding, callback) { callback(); }

    write(chunk, encoding, callback) { return _write(this, chunk, encoding, callback); }
    end(chunk, encoding, callback) { return _end(this, chunk, encoding, callback); }
    cork() { this._writableState.corked++; }
    uncork() { _uncork(this); }
    destroy(err) { return _destroyStream(this, err); }

    get writableEnded() { return this._writableState.ending; }
    get writableFinished() { return this._writableState.finished; }
    get writableLength() { return this._writableState.bufferedLength; }
  }

  // ── Duplex ──────────────────────────────────────────────────────────
  class Duplex extends Readable {
    constructor(opts) {
      super(opts);
      this._writableState = _writableState(opts, opts?.writableHighWaterMark ?? opts?.highWaterMark ?? 16384);
      this.writable = true;
      if (opts?.write) this._write = opts.write.bind(this);
      if (opts?.final) this._final = opts.final.bind(this);
    }
    _write(chunk, encoding, callback) { callback(); }
    write(chunk, encoding, callback) { return _write(this, chunk, encoding, callback); }
    end(chunk, encoding, callback) { return _end(this, chunk, encoding, callback); }
    cork() { this._writableState.corked++; }
    uncork() { _uncork(this); }
    get writableEnded() { return this._writableState.ending; }
    get writableFinished() { return this._writableState.finished; }
    get writableLength() { return this._writableState.bufferedLength; }
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
  // attached, mirroring Node exactly. Like Node's (lib/internal/streams/
  // legacy.js) it is a function, not a class: send (express.static) does
  // \`Stream.call(this)\`, which a class constructor refuses.
  function Stream(opts) { __eventsMod.call(this, opts); }
  Object.setPrototypeOf(Stream.prototype, __eventsMod.prototype);
  Object.setPrototypeOf(Stream, __eventsMod);
  Stream.prototype.pipe = function pipe(dest, opts) {
    const src = this;
    src.on('data', (chunk) => { dest.write(chunk); });
    src.on('end', () => { if (!opts || opts.end !== false) dest.end(); });
    return dest;
  };
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
