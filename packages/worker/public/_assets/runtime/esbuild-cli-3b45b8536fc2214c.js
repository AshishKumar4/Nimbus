const __esbuildGoRuntime = function (globalThis, fs) {
// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

"use strict";

(() => {
	const enosys = () => {
		const err = new Error("not implemented");
		err.code = "ENOSYS";
		return err;
	};

	if (!globalThis.fs) {
		let outputBuf = "";
		globalThis.fs = {
			constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
			writeSync(fd, buf) {
				outputBuf += decoder.decode(buf);
				const nl = outputBuf.lastIndexOf("\n");
				if (nl != -1) {
					console.log(outputBuf.substring(0, nl));
					outputBuf = outputBuf.substring(nl + 1);
				}
				return buf.length;
			},
			write(fd, buf, offset, length, position, callback) {
				if (offset !== 0 || length !== buf.length || position !== null) {
					callback(enosys());
					return;
				}
				const n = this.writeSync(fd, buf);
				callback(null, n);
			},
			chmod(path, mode, callback) { callback(enosys()); },
			chown(path, uid, gid, callback) { callback(enosys()); },
			close(fd, callback) { callback(enosys()); },
			fchmod(fd, mode, callback) { callback(enosys()); },
			fchown(fd, uid, gid, callback) { callback(enosys()); },
			fstat(fd, callback) { callback(enosys()); },
			fsync(fd, callback) { callback(null); },
			ftruncate(fd, length, callback) { callback(enosys()); },
			lchown(path, uid, gid, callback) { callback(enosys()); },
			link(path, link, callback) { callback(enosys()); },
			lstat(path, callback) { callback(enosys()); },
			mkdir(path, perm, callback) { callback(enosys()); },
			open(path, flags, mode, callback) { callback(enosys()); },
			read(fd, buffer, offset, length, position, callback) { callback(enosys()); },
			readdir(path, callback) { callback(enosys()); },
			readlink(path, callback) { callback(enosys()); },
			rename(from, to, callback) { callback(enosys()); },
			rmdir(path, callback) { callback(enosys()); },
			stat(path, callback) { callback(enosys()); },
			symlink(path, link, callback) { callback(enosys()); },
			truncate(path, length, callback) { callback(enosys()); },
			unlink(path, callback) { callback(enosys()); },
			utimes(path, atime, mtime, callback) { callback(enosys()); },
		};
	}

	if (!globalThis.process) {
		globalThis.process = {
			getuid() { return -1; },
			getgid() { return -1; },
			geteuid() { return -1; },
			getegid() { return -1; },
			getgroups() { throw enosys(); },
			pid: -1,
			ppid: -1,
			umask() { throw enosys(); },
			cwd() { throw enosys(); },
			chdir() { throw enosys(); },
		}
	}

	if (!globalThis.crypto) {
		throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
	}

	if (!globalThis.performance) {
		throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
	}

	if (!globalThis.TextEncoder) {
		throw new Error("globalThis.TextEncoder is not available, polyfill required");
	}

	if (!globalThis.TextDecoder) {
		throw new Error("globalThis.TextDecoder is not available, polyfill required");
	}

	const encoder = new TextEncoder("utf-8");
	const decoder = new TextDecoder("utf-8");

	globalThis.Go = class {
		constructor() {
			this.argv = ["js"];
			this.env = {};
			this.exit = (code) => {
				if (code !== 0) {
					console.warn("exit code:", code);
				}
			};
			this._exitPromise = new Promise((resolve) => {
				this._resolveExitPromise = resolve;
			});
			this._pendingEvent = null;
			this._scheduledTimeouts = new Map();
			this._nextCallbackTimeoutID = 1;

			const setInt64 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
				this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
			}

			const setInt32 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
			}

			const getInt64 = (addr) => {
				const low = this.mem.getUint32(addr + 0, true);
				const high = this.mem.getInt32(addr + 4, true);
				return low + high * 4294967296;
			}

			const loadValue = (addr) => {
				const f = this.mem.getFloat64(addr, true);
				if (f === 0) {
					return undefined;
				}
				if (!isNaN(f)) {
					return f;
				}

				const id = this.mem.getUint32(addr, true);
				return this._values[id];
			}

			const storeValue = (addr, v) => {
				const nanHead = 0x7FF80000;

				if (typeof v === "number" && v !== 0) {
					if (isNaN(v)) {
						this.mem.setUint32(addr + 4, nanHead, true);
						this.mem.setUint32(addr, 0, true);
						return;
					}
					this.mem.setFloat64(addr, v, true);
					return;
				}

				if (v === undefined) {
					this.mem.setFloat64(addr, 0, true);
					return;
				}

				let id = this._ids.get(v);
				if (id === undefined) {
					id = this._idPool.pop();
					if (id === undefined) {
						id = this._values.length;
					}
					this._values[id] = v;
					this._goRefCounts[id] = 0;
					this._ids.set(v, id);
				}
				this._goRefCounts[id]++;
				let typeFlag = 0;
				switch (typeof v) {
					case "object":
						if (v !== null) {
							typeFlag = 1;
						}
						break;
					case "string":
						typeFlag = 2;
						break;
					case "symbol":
						typeFlag = 3;
						break;
					case "function":
						typeFlag = 4;
						break;
				}
				this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
				this.mem.setUint32(addr, id, true);
			}

			const loadSlice = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return new Uint8Array(this._inst.exports.mem.buffer, array, len);
			}

			const loadSliceOfValues = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				const a = new Array(len);
				for (let i = 0; i < len; i++) {
					a[i] = loadValue(array + i * 8);
				}
				return a;
			}

			const loadString = (addr) => {
				const saddr = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
			}

			const timeOrigin = Date.now() - performance.now();
			this.importObject = {
				_gotest: {
					add: (a, b) => a + b,
				},
				gojs: {
					// Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
					// may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
					// function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
					// This changes the SP, thus we have to update the SP used by the imported function.

					// func wasmExit(code int32)
					"runtime.wasmExit": (sp) => {
						sp >>>= 0;
						const code = this.mem.getInt32(sp + 8, true);
						this.exited = true;
						delete this._inst;
						delete this._values;
						delete this._goRefCounts;
						delete this._ids;
						delete this._idPool;
						this.exit(code);
					},

					// func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
					"runtime.wasmWrite": (sp) => {
						sp >>>= 0;
						const fd = getInt64(sp + 8);
						const p = getInt64(sp + 16);
						const n = this.mem.getInt32(sp + 24, true);
						fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
					},

					// func resetMemoryDataView()
					"runtime.resetMemoryDataView": (sp) => {
						sp >>>= 0;
						this.mem = new DataView(this._inst.exports.mem.buffer);
					},

					// func nanotime1() int64
					"runtime.nanotime1": (sp) => {
						sp >>>= 0;
						setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);
					},

					// func walltime() (sec int64, nsec int32)
					"runtime.walltime": (sp) => {
						sp >>>= 0;
						const msec = (new Date).getTime();
						setInt64(sp + 8, msec / 1000);
						this.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
					},

					// func scheduleTimeoutEvent(delay int64) int32
					"runtime.scheduleTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this._nextCallbackTimeoutID;
						this._nextCallbackTimeoutID++;
						this._scheduledTimeouts.set(id, setTimeout(
							() => {
								this._resume();
								while (this._scheduledTimeouts.has(id)) {
									// for some reason Go failed to register the timeout event, log and try again
									// (temporary workaround for https://github.com/golang/go/issues/28975)
									console.warn("scheduleTimeoutEvent: missed timeout event");
									this._resume();
								}
							},
							getInt64(sp + 8),
						));
						this.mem.setInt32(sp + 16, id, true);
					},

					// func clearTimeoutEvent(id int32)
					"runtime.clearTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this.mem.getInt32(sp + 8, true);
						clearTimeout(this._scheduledTimeouts.get(id));
						this._scheduledTimeouts.delete(id);
					},

					// func getRandomData(r []byte)
					"runtime.getRandomData": (sp) => {
						sp >>>= 0;
						crypto.getRandomValues(loadSlice(sp + 8));
					},

					// func finalizeRef(v ref)
					"syscall/js.finalizeRef": (sp) => {
						sp >>>= 0;
						const id = this.mem.getUint32(sp + 8, true);
						this._goRefCounts[id]--;
						if (this._goRefCounts[id] === 0) {
							const v = this._values[id];
							this._values[id] = null;
							this._ids.delete(v);
							this._idPool.push(id);
						}
					},

					// func stringVal(value string) ref
					"syscall/js.stringVal": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, loadString(sp + 8));
					},

					// func valueGet(v ref, p string) ref
					"syscall/js.valueGet": (sp) => {
						sp >>>= 0;
						const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
						sp = this._inst.exports.getsp() >>> 0; // see comment above
						storeValue(sp + 32, result);
					},

					// func valueSet(v ref, p string, x ref)
					"syscall/js.valueSet": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
					},

					// func valueDelete(v ref, p string)
					"syscall/js.valueDelete": (sp) => {
						sp >>>= 0;
						Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
					},

					// func valueIndex(v ref, i int) ref
					"syscall/js.valueIndex": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
					},

					// valueSetIndex(v ref, i int, x ref)
					"syscall/js.valueSetIndex": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
					},

					// func valueCall(v ref, m string, args []ref) (ref, bool)
					"syscall/js.valueCall": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const m = Reflect.get(v, loadString(sp + 16));
							const args = loadSliceOfValues(sp + 32);
							const result = Reflect.apply(m, v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, result);
							this.mem.setUint8(sp + 64, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, err);
							this.mem.setUint8(sp + 64, 0);
						}
					},

					// func valueInvoke(v ref, args []ref) (ref, bool)
					"syscall/js.valueInvoke": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.apply(v, undefined, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueNew(v ref, args []ref) (ref, bool)
					"syscall/js.valueNew": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.construct(v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueLength(v ref) int
					"syscall/js.valueLength": (sp) => {
						sp >>>= 0;
						setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
					},

					// valuePrepareString(v ref) (ref, int)
					"syscall/js.valuePrepareString": (sp) => {
						sp >>>= 0;
						const str = encoder.encode(String(loadValue(sp + 8)));
						storeValue(sp + 16, str);
						setInt64(sp + 24, str.length);
					},

					// valueLoadString(v ref, b []byte)
					"syscall/js.valueLoadString": (sp) => {
						sp >>>= 0;
						const str = loadValue(sp + 8);
						loadSlice(sp + 16).set(str);
					},

					// func valueInstanceOf(v ref, t ref) bool
					"syscall/js.valueInstanceOf": (sp) => {
						sp >>>= 0;
						this.mem.setUint8(sp + 24, (loadValue(sp + 8) instanceof loadValue(sp + 16)) ? 1 : 0);
					},

					// func copyBytesToGo(dst []byte, src ref) (int, bool)
					"syscall/js.copyBytesToGo": (sp) => {
						sp >>>= 0;
						const dst = loadSlice(sp + 8);
						const src = loadValue(sp + 32);
						if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					// func copyBytesToJS(dst ref, src []byte) (int, bool)
					"syscall/js.copyBytesToJS": (sp) => {
						sp >>>= 0;
						const dst = loadValue(sp + 8);
						const src = loadSlice(sp + 16);
						if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					"debug": (value) => {
						console.log(value);
					},
				}
			};
		}

		async run(instance) {
			if (!(instance instanceof WebAssembly.Instance)) {
				throw new Error("Go.run: WebAssembly.Instance expected");
			}
			this._inst = instance;
			this.mem = new DataView(this._inst.exports.mem.buffer);
			this._values = [ // JS values that Go currently has references to, indexed by reference id
				NaN,
				0,
				null,
				true,
				false,
				globalThis,
				this,
			];
			this._goRefCounts = new Array(this._values.length).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id
			this._ids = new Map([ // mapping from JS values to reference ids
				[0, 1],
				[null, 2],
				[true, 3],
				[false, 4],
				[globalThis, 5],
				[this, 6],
			]);
			this._idPool = [];   // unused ids that have been garbage collected
			this.exited = false; // whether the Go program has exited

			// Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
			let offset = 4096;

			const strPtr = (str) => {
				const ptr = offset;
				const bytes = encoder.encode(str + "\0");
				new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
				offset += bytes.length;
				if (offset % 8 !== 0) {
					offset += 8 - (offset % 8);
				}
				return ptr;
			};

			const argc = this.argv.length;

			const argvPtrs = [];
			this.argv.forEach((arg) => {
				argvPtrs.push(strPtr(arg));
			});
			argvPtrs.push(0);

			const keys = Object.keys(this.env).sort();
			keys.forEach((key) => {
				argvPtrs.push(strPtr(`${key}=${this.env[key]}`));
			});
			argvPtrs.push(0);

			const argv = offset;
			argvPtrs.forEach((ptr) => {
				this.mem.setUint32(offset, ptr, true);
				this.mem.setUint32(offset + 4, 0, true);
				offset += 8;
			});

			// The linker guarantees global data starts from at least wasmMinDataAddr.
			// Keep in sync with cmd/link/internal/ld/data.go:wasmMinDataAddr.
			const wasmMinDataAddr = 4096 + 8192;
			if (offset >= wasmMinDataAddr) {
				throw new Error("total length of command line and environment variables exceeds limit");
			}

			this._inst.exports.run(argc, argv);
			if (this.exited) {
				this._resolveExitPromise();
			}
			await this._exitPromise;
		}

		_resume() {
			if (this.exited) {
				throw new Error("Go program has already exited");
			}
			this._inst.exports.resume();
			if (this.exited) {
				this._resolveExitPromise();
			}
		}

		_makeFuncWrapper(id) {
			const go = this;
			return function () {
				const event = { id: id, this: this, args: arguments };
				go._pendingEvent = event;
				go._resume();
				return event.result;
			};
		}
	}
})();

return globalThis.Go;
};
"use strict";
(() => {
  function pending(result) {
    return (typeof result === "object" || typeof result === "function") && result !== null && typeof result.then === "function";
  }
  function hop(result) {
    return pending(result) ? Promise.resolve(result).catch(restoreCode) : result;
  }
  function bytes(result) {
    return pending(result) ? Promise.resolve(result).catch(restoreCode).then(asBytes) : asBytes(result);
  }
  function asBytes(value) {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  function restoreCode(error) {
    if (error instanceof Error && !("code" in error)) {
      const code = /^([A-Z]+):/.exec(error.message)?.[1];
      if (code) throw Object.assign(error, { code });
    }
    throw error;
  }
  function supervisorFilesystem(supervisor, local) {
    return {
      synchronous: local,
      stat: (...args) => hop(supervisor.stat(...args)),
      readFile: (...args) => bytes(supervisor.readFileBytes(...args)),
      writeFile: (...args) => hop(supervisor.writeFile(...args)),
      readRange: (...args) => bytes(supervisor.fsReadRange(...args)),
      writeRange: (...args) => hop(supervisor.fsWriteRange(...args)),
      truncate: (...args) => hop(supervisor.fsTruncate(...args)),
      utimes: (...args) => hop(supervisor.utimes(...args)),
      chmod: (...args) => hop(supervisor.chmod(...args)),
      access: (...args) => hop(supervisor.access(...args)),
      chown: (...args) => hop(supervisor.chown(...args)),
      open: (...args) => hop(supervisor.fsOpen(...args)),
      read: (...args) => bytes(supervisor.fsRead(...args)),
      write: (...args) => hop(supervisor.fsWrite(...args)),
      close: (...args) => hop(supervisor.fsClose(...args)),
      readdir: (...args) => hop(supervisor.readdir(...args)),
      mkdir: (...args) => hop(supervisor.mkdir(...args)),
      unlink: (...args) => hop(supervisor.unlink(...args)),
      rmdir: (...args) => hop(supervisor.rmdir(...args)),
      rename: (...args) => hop(supervisor.rename(...args)),
      readlink: (...args) => hop(supervisor.readlink(...args)),
      symlink: (...args) => hop(supervisor.symlink(...args)),
      fsync: (...args) => hop(supervisor.fsSync(...args)),
      revision: (...args) => hop(supervisor.fsRevision(...args)),
      acquire: (...args) => hop(supervisor.fsAcquire(...args)),
      list: (...args) => hop(supervisor.fsList(...args)),
      realpath: (...args) => hop(supervisor.fsRealpath(...args)),
      remove: (...args) => hop(supervisor.fsRemove(...args)),
      copyFile: (...args) => hop(supervisor.fsCopyFile(...args)),
      fstat: (...args) => hop(supervisor.fsFstat(...args)),
      dup: (...args) => hop(supervisor.fsDup(...args)),
      seek: (...args) => hop(supervisor.fsSeek(...args)),
      setStatus: (...args) => hop(supervisor.fsSetStatus(...args)),
      readdirHandle: (...args) => hop(supervisor.fsReaddirHandle(...args)),
      ftruncate: (...args) => hop(supervisor.fsFtruncate(...args)),
      fchmod: (...args) => hop(supervisor.fsFchmod(...args)),
      fchown: (...args) => hop(supervisor.fsFchown(...args)),
      futimes: (...args) => hop(supervisor.fsFutimes(...args)),
      appendOnce: (...args) => hop(supervisor.fsAppend(...args)),
      acknowledgeAppend: (...args) => hop(supervisor.fsAppendAck(...args)),
      writeBatch: (...args) => hop(supervisor.writeBatch(...args)),
      writeStream: (...args) => Promise.resolve(supervisor.writeBatchStream(...args)).catch(restoreCode),
      acquireExclusiveMutation: (...args) => hop(supervisor.fsAcquireExclusiveMutation(...args)),
      releaseExclusiveMutation: (...args) => hop(supervisor.fsReleaseExclusiveMutation(...args))
    };
  }

  var O_WRONLY = 1;
  var O_RDWR = 2;
  var O_CREAT = 64;
  var O_EXCL = 128;
  var O_TRUNC = 512;
  var O_APPEND = 1024;
  var O_DIRECTORY = 65536;
  var CONSTANTS = { O_RDONLY: 0, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY };
  var GO_ERRNO_CODES = {
    EPERM: true,
    ENOENT: true,
    EINTR: true,
    EIO: true,
    EBADF: true,
    EAGAIN: true,
    ENOMEM: true,
    EACCES: true,
    EBUSY: true,
    EEXIST: true,
    EXDEV: true,
    ENOTDIR: true,
    EISDIR: true,
    EINVAL: true,
    EMFILE: true,
    ENOTTY: true,
    EFBIG: true,
    ENOSPC: true,
    ESPIPE: true,
    EROFS: true,
    EMLINK: true,
    EPIPE: true,
    ENAMETOOLONG: true,
    ENOTEMPTY: true,
    ENOSYS: true
  };
  var WRITE_SLICE_BYTES = 1 << 20;
  var S_IFREG = 32768;
  var S_IFDIR = 16384;
  var S_IFLNK = 40960;
  var S_IFIFO = 4096;
  function errno(code, detail) {
    return Object.assign(new Error(`${code}: ${detail}`), { code });
  }
  function goError(error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : void 0;
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(message), {
      code: typeof code === "string" && GO_ERRNO_CODES[code] ? code : "EIO"
    });
  }
  function resolvePath(cwd, path) {
    const parts = [];
    for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }
  function goStats(stat, size = stat.size) {
    const type = stat.type === "directory" ? S_IFDIR : stat.type === "symlink" ? S_IFLNK : S_IFREG;
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: type | stat.mode & 4095,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: stat.atime,
      mtimeMs: stat.mtime,
      ctimeMs: stat.ctime,
      isDirectory: () => stat.type === "directory"
    };
  }
  var Stdio = class {
    constructor(stdin, output) {
      this.stdin = stdin;
      this.output = output;
    }
    stdin;
    output;
    stdinOffset = 0;
    held = [];
    hold(fd, bytes2) {
      this.held.push({ fd, bytes: bytes2 });
    }
    async write(fd, bytes2) {
      await this.flush();
      for (let done = 0; done < bytes2.length; done += WRITE_SLICE_BYTES) {
        await this.output(fd, bytes2.slice(done, done + WRITE_SLICE_BYTES));
      }
    }
    async flush() {
      for (let next = this.held.shift(); next; next = this.held.shift()) {
        await this.output(next.fd, next.bytes);
      }
    }
    read(buffer, offset, length) {
      const input = this.stdin ?? new Uint8Array(0);
      const chunk = input.subarray(this.stdinOffset, this.stdinOffset + length);
      buffer.set(chunk, offset);
      this.stdinOffset += chunk.length;
      return chunk.length;
    }
  };
  var isOutput = (fd) => fd === 1 || fd === 2;
  function goFilesystem(vfs, stdio, state, live, crash) {
    const files =   new Map();
    let nextFd = 3;
    const at = (path) => resolvePath(state.cwd, path);
    const add = (file2) => {
      const fd = nextFd++;
      files.set(fd, file2);
      return fd;
    };
    const file = (fd) => {
      const open = files.get(fd);
      if (!open) throw errno("EBADF", `fd ${fd}`);
      return open;
    };
    const settle = (work, callback) => {
      Promise.resolve().then(work).then(
        (value) => {
          if (live()) deliver(callback, null, value);
        },
        (error) => {
          if (live()) deliver(callback, goError(error), void 0);
        }
      );
    };
    const deliver = (callback, error, value) => {
      try {
        callback(error, value);
      } catch (trap) {
        crash(trap);
      }
    };
    const stat = async (path, followSymlinks) => {
      const found = await vfs.stat(path, { followSymlinks });
      if (!found) throw errno("ENOENT", path);
      return goStats(found);
    };
    const fs = {
      constants: CONSTANTS,
      writeSync(fd, buffer) {
        if (isOutput(fd)) stdio.hold(fd, buffer.slice());
        return buffer.length;
      },
      write(fd, buffer, offset, length, position, callback) {
        settle(async () => {
          const data = buffer.subarray(offset, offset + length);
          if (isOutput(fd)) {
            await stdio.write(fd, data);
            return length;
          }
          const open = file(fd);
          if (open.kind !== "handle") throw errno("EBADF", `fd ${fd} is not open for writing`);
          for (let done = 0; done < length; ) {
            const slice = data.slice(done, Math.min(length, done + WRITE_SLICE_BYTES));
            const written = await vfs.write(open.handle, position === null ? null : position + done, slice);
            if (written <= 0) throw errno("EIO", `short write to ${open.path}`);
            done += written;
          }
          return length;
        }, callback);
      },
      read(fd, buffer, offset, length, position, callback) {
        settle(async () => {
          if (fd === 0) return stdio.read(buffer, offset, length);
          const open = file(fd);
          if (open.kind === "directory") throw errno("EISDIR", open.path);
          if (open.kind === "bytes") {
            const start = position ?? open.position;
            const chunk = open.bytes.subarray(start, start + length);
            buffer.set(chunk, offset);
            if (position === null) open.position += chunk.length;
            return chunk.length;
          }
          const bytes2 = await vfs.read(open.handle, position, length);
          buffer.set(bytes2, offset);
          return bytes2.length;
        }, callback);
      },
      open(path, flags, mode, callback) {
        settle(async () => {
          const target = at(path);
          const access = flags & 3;
          if (access === 0 && (flags & (O_CREAT | O_TRUNC | O_APPEND)) === 0) {
            const found = await vfs.stat(target);
            if (!found) throw errno("ENOENT", target);
            if (found.type === "directory") return add({ kind: "directory", path: target, stat: goStats(found) });
            if (flags & O_DIRECTORY) throw errno("ENOTDIR", target);
            const bytes2 = await vfs.readFile(target);
            if (!bytes2) throw errno("ENOENT", target);
            return add({ kind: "bytes", path: target, bytes: bytes2, stat: goStats(found, bytes2.length), position: 0 });
          }
          const openFlags = {
            read: access === O_RDWR,
            write: true,
            create: (flags & O_CREAT) !== 0,
            exclusive: (flags & O_EXCL) !== 0,
            truncate: (flags & O_TRUNC) !== 0,
            append: (flags & O_APPEND) !== 0,
            mode
          };
          const handle = await vfs.open(target, openFlags);
          return add({ kind: "handle", path: target, handle: handle.id });
        }, callback);
      },
      close(fd, callback) {
        settle(async () => {
          const open = file(fd);
          files.delete(fd);
          if (open.kind === "handle") await vfs.close(open.handle);
        }, callback);
      },
      fstat(fd, callback) {
        settle(async () => {
          if (fd <= 2) {
            return {
              dev: 0,
              ino: fd,
              mode: S_IFIFO | 384,
              nlink: 1,
              uid: 0,
              gid: 0,
              rdev: 0,
              size: 0,
              blksize: 4096,
              blocks: 0,
              atimeMs: 0,
              mtimeMs: 0,
              ctimeMs: 0,
              isDirectory: () => false
            };
          }
          const open = file(fd);
          return open.kind === "handle" ? goStats(await vfs.fstat(open.handle)) : open.stat;
        }, callback);
      },
      stat(path, callback) {
        settle(() => stat(at(path), true), callback);
      },
      lstat(path, callback) {
        settle(() => stat(at(path), false), callback);
      },
      readdir(path, callback) {
        settle(async () => (await vfs.readdir(at(path))).map((entry) => entry.name), callback);
      },
      mkdir(path, perm, callback) {
        settle(() => vfs.mkdir(at(path), { mode: perm }), callback);
      },
      rmdir(path, callback) {
        settle(() => vfs.rmdir(at(path)), callback);
      },
      unlink(path, callback) {
        settle(() => vfs.unlink(at(path)), callback);
      },
      rename(from, to, callback) {
        settle(() => vfs.rename(at(from), at(to)), callback);
      },
      readlink(path, callback) {
        settle(async () => {
          const target = await vfs.readlink(at(path));
          if (target === null) throw errno("EINVAL", `${path} is not a symbolic link`);
          return target;
        }, callback);
      },
      symlink(target, path, callback) {
        settle(() => vfs.symlink(target, at(path)), callback);
      },
      link(_existing, path, callback) {
        settle(() => {
          throw errno("ENOSYS", `hard links are not supported: ${path}`);
        }, callback);
      },
      chmod(path, mode, callback) {
        settle(() => vfs.chmod(at(path), mode), callback);
      },
      fchmod(fd, mode, callback) {
        settle(() => {
          const open = file(fd);
          return open.kind === "handle" ? vfs.fchmod(open.handle, mode) : vfs.chmod(open.path, mode);
        }, callback);
      },
      chown(path, uid, gid, callback) {
        settle(() => vfs.chown(at(path), uid, gid), callback);
      },
      lchown(path, uid, gid, callback) {
        settle(() => vfs.chown(at(path), uid, gid, { followSymlinks: false }), callback);
      },
      fchown(fd, uid, gid, callback) {
        settle(() => {
          const open = file(fd);
          return open.kind === "handle" ? vfs.fchown(open.handle, uid, gid) : vfs.chown(open.path, uid, gid);
        }, callback);
      },
      utimes(path, atime, mtime, callback) {
        settle(() => vfs.utimes(at(path), atime * 1e3, mtime * 1e3), callback);
      },
      truncate(path, length, callback) {
        settle(() => vfs.truncate(at(path), length), callback);
      },
      ftruncate(fd, length, callback) {
        settle(() => {
          const open = file(fd);
          if (open.kind !== "handle") throw errno("EBADF", `fd ${fd} is not open for writing`);
          return vfs.ftruncate(open.handle, length);
        }, callback);
      },
      fsync(fd, callback) {
        settle(() => {
          const open = file(fd);
          return open.kind === "handle" ? vfs.fsync(open.handle) : void 0;
        }, callback);
      }
    };
    return { fs, files };
  }
  globalThis.__esbuildCliRun = async function __esbuildCliRun(args, supervisor, output, module) {
    const stdio = new Stdio(args.stdin, output);
    const vfs = supervisorFilesystem(supervisor);
    const state = { cwd: args.cwd, umask: args.umask };
    let go = null;
    let crash = () => {
    };
    const crashed = new Promise((_, reject) => {
      crash = reject;
    });
    const { fs, files } = goFilesystem(vfs, stdio, state, () => go !== null && !go.exited, (error) => crash(error));
    const process = {
      pid: 1,
      ppid: 0,
      getuid: () => args.uid,
      geteuid: () => args.uid,
      getgid: () => args.gid,
      getegid: () => args.gid,
      getgroups: () => args.groups,
      umask(mask) {
        const prior = state.umask;
        if (typeof mask === "number") state.umask = mask;
        return prior;
      },
      cwd: () => state.cwd,
      chdir(path) {
        state.cwd = resolvePath(state.cwd, path);
      }
    };
    const Go = __esbuildGoRuntime({ Object, Array, Uint8Array, TextEncoder, TextDecoder, crypto, performance, fs, process }, fs);
    const program = new Go();
    go = program;
    program.argv = ["esbuild", ...args.argv];
    program.env = args.env;
    let exitCode = 0;
    program.exit = (code) => {
      exitCode = code;
    };
    try {
      const instance = await WebAssembly.instantiate(module, program.importObject);
      await Promise.race([program.run(instance), crashed]);
    } catch (error) {
      stdio.hold(2, new TextEncoder().encode(`esbuild: ${error instanceof Error ? error.message : String(error)}
`));
      exitCode = exitCode || 1;
    } finally {
      for (const timer of program._scheduledTimeouts.values()) clearTimeout(timer);
      for (const open of files.values()) {
        if (open.kind === "handle") await Promise.resolve(vfs.close(open.handle)).catch(() => void 0);
      }
      files.clear();
    }
    await stdio.flush();
    return exitCode;
  };
})();
