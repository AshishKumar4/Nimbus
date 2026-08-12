import { EventEmitter } from './events.js';
export class Readable extends EventEmitter {
    _buffer = [];
    _ended = false;
    readable = true;
    push(chunk) {
        if (chunk === null) {
            this._ended = true;
            this.readable = false;
            this.emit('end');
        }
        else {
            this._buffer.push(chunk);
            this.emit('data', chunk);
        }
    }
    read() {
        if (this._buffer.length > 0)
            return this._buffer.shift();
        return null;
    }
    pipe(dest) {
        this.on('data', (chunk) => dest.write(chunk));
        this.on('end', () => dest.end());
        return dest;
    }
    destroy() {
        this._ended = true;
        this.readable = false;
        this.emit('close');
        return this;
    }
    setEncoding(_encoding) {
        return this;
    }
    resume() {
        return this;
    }
    pause() {
        return this;
    }
}
export class Writable extends EventEmitter {
    _ended = false;
    writable = true;
    write(chunk, _encoding, cb) {
        if (this._ended)
            return false;
        this.emit('data', chunk);
        if (cb)
            cb();
        return true;
    }
    end(chunk) {
        if (chunk)
            this.write(chunk);
        this._ended = true;
        this.writable = false;
        this.emit('finish');
        this.emit('close');
    }
    destroy() {
        this._ended = true;
        this.writable = false;
        this.emit('close');
        return this;
    }
}
export class Duplex extends Readable {
    writable = true;
    _writableEnded = false;
    write(chunk, _encoding, cb) {
        if (this._writableEnded)
            return false;
        this.emit('data', chunk);
        if (cb)
            cb();
        return true;
    }
    end(chunk) {
        if (chunk)
            this.write(chunk);
        this._writableEnded = true;
        this.writable = false;
        this.emit('finish');
    }
}
export class PassThrough extends Duplex {
}
export default { Readable, Writable, Duplex, PassThrough };
