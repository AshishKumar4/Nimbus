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
    return pending(result) ? Promise.resolve(result) : result;
  }
  function bytes(result) {
    return pending(result) ? Promise.resolve(result).then(asBytes) : asBytes(result);
  }
  function asBytes(value) {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
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
      copyTree: (...args) => hop(supervisor.fsCopyTree(...args)),
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
      writeStream: (...args) => Promise.resolve(supervisor.writeBatchStream(...args)),
      acquireExclusiveMutation: (...args) => hop(supervisor.fsAcquireExclusiveMutation(...args)),
      releaseExclusiveMutation: (...args) => hop(supervisor.fsReleaseExclusiveMutation(...args))
    };
  }

  var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];
  var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];
  var nonASCIIidentifierChars = "\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0CF3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u180F-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1ABF-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\u30FB\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA8FF-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F\uFF65";
  var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C5C\u0C5D\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDC-\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D04-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E86-\u0E8A\u0E8C-\u0EA3\u0EA5\u0EA7-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u1711\u171F-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4C\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C8A\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1CFA\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7DC\uA7F1-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB69\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
  var reservedWords = {
    3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
    5: "class enum extends super const export import",
    6: "enum",
    strict: "implements interface let package private protected public static yield",
    strictBind: "eval arguments"
  };
  var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";
  var keywords$1 = {
    5: ecma5AndLessKeywords,
    "5module": ecma5AndLessKeywords + " export import",
    6: ecma5AndLessKeywords + " const class extends export import super"
  };
  var keywordRelationalOperator = /^in(stanceof)?$/;
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
  function isInAstralSet(code, set) {
    var pos = 65536;
    for (var i2 = 0; i2 < set.length; i2 += 2) {
      pos += set[i2];
      if (pos > code) {
        return false;
      }
      pos += set[i2 + 1];
      if (pos >= code) {
        return true;
      }
    }
    return false;
  }
  function isIdentifierStart(code, astral) {
    if (code < 65) {
      return code === 36;
    }
    if (code < 91) {
      return true;
    }
    if (code < 97) {
      return code === 95;
    }
    if (code < 123) {
      return true;
    }
    if (code <= 65535) {
      return code >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code));
    }
    if (astral === false) {
      return false;
    }
    return isInAstralSet(code, astralIdentifierStartCodes);
  }
  function isIdentifierChar(code, astral) {
    if (code < 48) {
      return code === 36;
    }
    if (code < 58) {
      return true;
    }
    if (code < 65) {
      return false;
    }
    if (code < 91) {
      return true;
    }
    if (code < 97) {
      return code === 95;
    }
    if (code < 123) {
      return true;
    }
    if (code <= 65535) {
      return code >= 170 && nonASCIIidentifier.test(String.fromCharCode(code));
    }
    if (astral === false) {
      return false;
    }
    return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
  }
  var TokenType = function TokenType2(label, conf) {
    if (conf === void 0) conf = {};
    this.label = label;
    this.keyword = conf.keyword;
    this.beforeExpr = !!conf.beforeExpr;
    this.startsExpr = !!conf.startsExpr;
    this.isLoop = !!conf.isLoop;
    this.isAssign = !!conf.isAssign;
    this.prefix = !!conf.prefix;
    this.postfix = !!conf.postfix;
    this.binop = conf.binop || null;
    this.updateContext = null;
  };
  function binop(name, prec) {
    return new TokenType(name, { beforeExpr: true, binop: prec });
  }
  var beforeExpr = { beforeExpr: true };
  var startsExpr = { startsExpr: true };
  var keywords = {};
  function kw(name, options) {
    if (options === void 0) options = {};
    options.keyword = name;
    return keywords[name] = new TokenType(name, options);
  }
  var types$1 = {
    num: new TokenType("num", startsExpr),
    regexp: new TokenType("regexp", startsExpr),
    string: new TokenType("string", startsExpr),
    name: new TokenType("name", startsExpr),
    privateId: new TokenType("privateId", startsExpr),
    eof: new TokenType("eof"),
    bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
    bracketR: new TokenType("]"),
    braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
    braceR: new TokenType("}"),
    parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
    parenR: new TokenType(")"),
    comma: new TokenType(",", beforeExpr),
    semi: new TokenType(";", beforeExpr),
    colon: new TokenType(":", beforeExpr),
    dot: new TokenType("."),
    question: new TokenType("?", beforeExpr),
    questionDot: new TokenType("?."),
    arrow: new TokenType("=>", beforeExpr),
    template: new TokenType("template"),
    invalidTemplate: new TokenType("invalidTemplate"),
    ellipsis: new TokenType("...", beforeExpr),
    backQuote: new TokenType("`", startsExpr),
    dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),
    eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
    assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
    incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
    prefix: new TokenType("!/~", { beforeExpr: true, prefix: true, startsExpr: true }),
    logicalOR: binop("||", 1),
    logicalAND: binop("&&", 2),
    bitwiseOR: binop("|", 3),
    bitwiseXOR: binop("^", 4),
    bitwiseAND: binop("&", 5),
    equality: binop("==/!=/===/!==", 6),
    relational: binop("</>/<=/>=", 7),
    bitShift: binop("<</>>/>>>", 8),
    plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
    modulo: binop("%", 10),
    star: binop("*", 10),
    slash: binop("/", 10),
    starstar: new TokenType("**", { beforeExpr: true }),
    coalesce: binop("??", 1),
    _break: kw("break"),
    _case: kw("case", beforeExpr),
    _catch: kw("catch"),
    _continue: kw("continue"),
    _debugger: kw("debugger"),
    _default: kw("default", beforeExpr),
    _do: kw("do", { isLoop: true, beforeExpr: true }),
    _else: kw("else", beforeExpr),
    _finally: kw("finally"),
    _for: kw("for", { isLoop: true }),
    _function: kw("function", startsExpr),
    _if: kw("if"),
    _return: kw("return", beforeExpr),
    _switch: kw("switch"),
    _throw: kw("throw", beforeExpr),
    _try: kw("try"),
    _var: kw("var"),
    _const: kw("const"),
    _while: kw("while", { isLoop: true }),
    _with: kw("with"),
    _new: kw("new", { beforeExpr: true, startsExpr: true }),
    _this: kw("this", startsExpr),
    _super: kw("super", startsExpr),
    _class: kw("class", startsExpr),
    _extends: kw("extends", beforeExpr),
    _export: kw("export"),
    _import: kw("import", startsExpr),
    _null: kw("null", startsExpr),
    _true: kw("true", startsExpr),
    _false: kw("false", startsExpr),
    _in: kw("in", { beforeExpr: true, binop: 7 }),
    _instanceof: kw("instanceof", { beforeExpr: true, binop: 7 }),
    _typeof: kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true }),
    _void: kw("void", { beforeExpr: true, prefix: true, startsExpr: true }),
    _delete: kw("delete", { beforeExpr: true, prefix: true, startsExpr: true })
  };
  var lineBreak = /\r\n?|\n|\u2028|\u2029/;
  var lineBreakG = new RegExp(lineBreak.source, "g");
  function isNewLine(code) {
    return code === 10 || code === 13 || code === 8232 || code === 8233;
  }
  function nextLineBreak(code, from, end) {
    if (end === void 0) end = code.length;
    for (var i2 = from; i2 < end; i2++) {
      var next = code.charCodeAt(i2);
      if (isNewLine(next)) {
        return i2 < end - 1 && next === 13 && code.charCodeAt(i2 + 1) === 10 ? i2 + 2 : i2 + 1;
      }
    }
    return -1;
  }
  var nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
  var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;
  var ref = Object.prototype;
  var hasOwnProperty = ref.hasOwnProperty;
  var toString = ref.toString;
  var hasOwn = Object.hasOwn || (function(obj, propName) {
    return hasOwnProperty.call(obj, propName);
  });
  var isArray = Array.isArray || (function(obj) {
    return toString.call(obj) === "[object Array]";
  });
  var regexpCache =   Object.create(null);
  function wordsRegexp(words) {
    return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
  }
  function codePointToString(code) {
    if (code <= 65535) {
      return String.fromCharCode(code);
    }
    code -= 65536;
    return String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
  }
  var loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/;
  var Position = function Position2(line, col) {
    this.line = line;
    this.column = col;
  };
  Position.prototype.offset = function offset(n2) {
    return new Position(this.line, this.column + n2);
  };
  var SourceLocation = function SourceLocation2(p, start, end) {
    this.start = start;
    this.end = end;
    if (p.sourceFile !== null) {
      this.source = p.sourceFile;
    }
  };
  function getLineInfo(input, offset2) {
    for (var line = 1, cur = 0; ; ) {
      var nextBreak = nextLineBreak(input, cur, offset2);
      if (nextBreak < 0) {
        return new Position(line, offset2 - cur);
      }
      ++line;
      cur = nextBreak;
    }
  }
  var defaultOptions = {
    ecmaVersion: null,
    sourceType: "script",
    onInsertedSemicolon: null,
    onTrailingComma: null,
    allowReserved: null,
    allowReturnOutsideFunction: false,
    allowImportExportEverywhere: false,
    allowAwaitOutsideFunction: null,
    allowSuperOutsideMethod: null,
    allowHashBang: false,
    checkPrivateFields: true,
    locations: false,
    onToken: null,
    onComment: null,
    ranges: false,
    program: null,
    sourceFile: null,
    directSourceFile: null,
    preserveParens: false
  };
  var warnedAboutEcmaVersion = false;
  function getOptions(opts) {
    var options = {};
    for (var opt in defaultOptions) {
      options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt];
    }
    if (options.ecmaVersion === "latest") {
      options.ecmaVersion = 1e8;
    } else if (options.ecmaVersion == null) {
      if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
        warnedAboutEcmaVersion = true;
        console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.");
      }
      options.ecmaVersion = 11;
    } else if (options.ecmaVersion >= 2015) {
      options.ecmaVersion -= 2009;
    }
    if (options.allowReserved == null) {
      options.allowReserved = options.ecmaVersion < 5;
    }
    if (!opts || opts.allowHashBang == null) {
      options.allowHashBang = options.ecmaVersion >= 14;
    }
    if (isArray(options.onToken)) {
      var tokens = options.onToken;
      options.onToken = function(token) {
        return tokens.push(token);
      };
    }
    if (isArray(options.onComment)) {
      options.onComment = pushComment(options, options.onComment);
    }
    if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction) {
      throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs");
    }
    return options;
  }
  function pushComment(options, array) {
    return function(block, text, start, end, startLoc, endLoc) {
      var comment = {
        type: block ? "Block" : "Line",
        value: text,
        start,
        end
      };
      if (options.locations) {
        comment.loc = new SourceLocation(this, startLoc, endLoc);
      }
      if (options.ranges) {
        comment.range = [start, end];
      }
      array.push(comment);
    };
  }
  var SCOPE_TOP = 1;
  var SCOPE_FUNCTION = 2;
  var SCOPE_ASYNC = 4;
  var SCOPE_GENERATOR = 8;
  var SCOPE_ARROW = 16;
  var SCOPE_SIMPLE_CATCH = 32;
  var SCOPE_SUPER = 64;
  var SCOPE_DIRECT_SUPER = 128;
  var SCOPE_CLASS_STATIC_BLOCK = 256;
  var SCOPE_CLASS_FIELD_INIT = 512;
  var SCOPE_SWITCH = 1024;
  var SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK;
  function functionFlags(async, generator) {
    return SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | (generator ? SCOPE_GENERATOR : 0);
  }
  var BIND_NONE = 0;
  var BIND_VAR = 1;
  var BIND_LEXICAL = 2;
  var BIND_FUNCTION = 3;
  var BIND_SIMPLE_CATCH = 4;
  var BIND_OUTSIDE = 5;
  var Parser = function Parser2(options, input, startPos) {
    this.options = options = getOptions(options);
    this.sourceFile = options.sourceFile;
    this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5]);
    var reserved = "";
    if (options.allowReserved !== true) {
      reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3];
      if (options.sourceType === "module") {
        reserved += " await";
      }
    }
    this.reservedWords = wordsRegexp(reserved);
    var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
    this.reservedWordsStrict = wordsRegexp(reservedStrict);
    this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind);
    this.input = String(input);
    this.containsEsc = false;
    if (startPos) {
      this.pos = startPos;
      this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1;
      this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
    } else {
      this.pos = this.lineStart = 0;
      this.curLine = 1;
    }
    this.type = types$1.eof;
    this.value = null;
    this.start = this.end = this.pos;
    this.startLoc = this.endLoc = this.curPosition();
    this.lastTokEndLoc = this.lastTokStartLoc = null;
    this.lastTokStart = this.lastTokEnd = this.pos;
    this.context = this.initialContext();
    this.exprAllowed = true;
    this.inModule = options.sourceType === "module";
    this.strict = this.inModule || this.strictDirective(this.pos);
    this.potentialArrowAt = -1;
    this.potentialArrowInForAwait = false;
    this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
    this.labels = [];
    this.undefinedExports =   Object.create(null);
    if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!") {
      this.skipLineComment(2);
    }
    this.scopeStack = [];
    this.enterScope(
      this.options.sourceType === "commonjs" ? SCOPE_FUNCTION : SCOPE_TOP
    );
    this.regexpState = null;
    this.privateNameStack = [];
  };
  var prototypeAccessors = { inFunction: { configurable: true }, inGenerator: { configurable: true }, inAsync: { configurable: true }, canAwait: { configurable: true }, allowReturn: { configurable: true }, allowSuper: { configurable: true }, allowDirectSuper: { configurable: true }, treatFunctionsAsVar: { configurable: true }, allowNewDotTarget: { configurable: true }, allowUsing: { configurable: true }, inClassStaticBlock: { configurable: true } };
  Parser.prototype.parse = function parse() {
    var node = this.options.program || this.startNode();
    this.nextToken();
    return this.parseTopLevel(node);
  };
  prototypeAccessors.inFunction.get = function() {
    return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
  };
  prototypeAccessors.inGenerator.get = function() {
    return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0;
  };
  prototypeAccessors.inAsync.get = function() {
    return (this.currentVarScope().flags & SCOPE_ASYNC) > 0;
  };
  prototypeAccessors.canAwait.get = function() {
    for (var i2 = this.scopeStack.length - 1; i2 >= 0; i2--) {
      var ref2 = this.scopeStack[i2];
      var flags = ref2.flags;
      if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) {
        return false;
      }
      if (flags & SCOPE_FUNCTION) {
        return (flags & SCOPE_ASYNC) > 0;
      }
    }
    return this.inModule && this.options.ecmaVersion >= 13 || this.options.allowAwaitOutsideFunction;
  };
  prototypeAccessors.allowReturn.get = function() {
    if (this.inFunction) {
      return true;
    }
    if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) {
      return true;
    }
    return false;
  };
  prototypeAccessors.allowSuper.get = function() {
    var ref2 = this.currentThisScope();
    var flags = ref2.flags;
    return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod;
  };
  prototypeAccessors.allowDirectSuper.get = function() {
    return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0;
  };
  prototypeAccessors.treatFunctionsAsVar.get = function() {
    return this.treatFunctionsAsVarInScope(this.currentScope());
  };
  prototypeAccessors.allowNewDotTarget.get = function() {
    for (var i2 = this.scopeStack.length - 1; i2 >= 0; i2--) {
      var ref2 = this.scopeStack[i2];
      var flags = ref2.flags;
      if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) || flags & SCOPE_FUNCTION && !(flags & SCOPE_ARROW)) {
        return true;
      }
    }
    return false;
  };
  prototypeAccessors.allowUsing.get = function() {
    var ref2 = this.currentScope();
    var flags = ref2.flags;
    if (flags & SCOPE_SWITCH) {
      return false;
    }
    if (!this.inModule && flags & SCOPE_TOP) {
      return false;
    }
    return true;
  };
  prototypeAccessors.inClassStaticBlock.get = function() {
    return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0;
  };
  Parser.extend = function extend() {
    var plugins = [], len = arguments.length;
    while (len--) plugins[len] = arguments[len];
    var cls = this;
    for (var i2 = 0; i2 < plugins.length; i2++) {
      cls = plugins[i2](cls);
    }
    return cls;
  };
  Parser.parse = function parse2(input, options) {
    return new this(options, input).parse();
  };
  Parser.parseExpressionAt = function parseExpressionAt(input, pos, options) {
    var parser = new this(options, input, pos);
    parser.nextToken();
    return parser.parseExpression();
  };
  Parser.tokenizer = function tokenizer(input, options) {
    return new this(options, input);
  };
  Object.defineProperties(Parser.prototype, prototypeAccessors);
  var pp$9 = Parser.prototype;
  var literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/;
  pp$9.strictDirective = function(start) {
    if (this.options.ecmaVersion < 5) {
      return false;
    }
    for (; ; ) {
      skipWhiteSpace.lastIndex = start;
      start += skipWhiteSpace.exec(this.input)[0].length;
      var match = literal.exec(this.input.slice(start));
      if (!match) {
        return false;
      }
      if ((match[1] || match[2]) === "use strict") {
        skipWhiteSpace.lastIndex = start + match[0].length;
        var spaceAfter = skipWhiteSpace.exec(this.input), end = spaceAfter.index + spaceAfter[0].length;
        var next = this.input.charAt(end);
        return next === ";" || next === "}" || lineBreak.test(spaceAfter[0]) && !(/[(`.[+\-/*%<>=,?^&]/.test(next) || next === "!" && this.input.charAt(end + 1) === "=");
      }
      start += match[0].length;
      skipWhiteSpace.lastIndex = start;
      start += skipWhiteSpace.exec(this.input)[0].length;
      if (this.input[start] === ";") {
        start++;
      }
    }
  };
  pp$9.eat = function(type) {
    if (this.type === type) {
      this.next();
      return true;
    } else {
      return false;
    }
  };
  pp$9.isContextual = function(name) {
    return this.type === types$1.name && this.value === name && !this.containsEsc;
  };
  pp$9.eatContextual = function(name) {
    if (!this.isContextual(name)) {
      return false;
    }
    this.next();
    return true;
  };
  pp$9.expectContextual = function(name) {
    if (!this.eatContextual(name)) {
      this.unexpected();
    }
  };
  pp$9.canInsertSemicolon = function() {
    return this.type === types$1.eof || this.type === types$1.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  };
  pp$9.insertSemicolon = function() {
    if (this.canInsertSemicolon()) {
      if (this.options.onInsertedSemicolon) {
        this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
      }
      return true;
    }
  };
  pp$9.semicolon = function() {
    if (!this.eat(types$1.semi) && !this.insertSemicolon()) {
      this.unexpected();
    }
  };
  pp$9.afterTrailingComma = function(tokType, notNext) {
    if (this.type === tokType) {
      if (this.options.onTrailingComma) {
        this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
      }
      if (!notNext) {
        this.next();
      }
      return true;
    }
  };
  pp$9.expect = function(type) {
    this.eat(type) || this.unexpected();
  };
  pp$9.unexpected = function(pos) {
    this.raise(pos != null ? pos : this.start, "Unexpected token");
  };
  var DestructuringErrors = function DestructuringErrors2() {
    this.shorthandAssign = this.trailingComma = this.parenthesizedAssign = this.parenthesizedBind = this.doubleProto = -1;
  };
  pp$9.checkPatternErrors = function(refDestructuringErrors, isAssign) {
    if (!refDestructuringErrors) {
      return;
    }
    if (refDestructuringErrors.trailingComma > -1) {
      this.raiseRecoverable(refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element");
    }
    var parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind;
    if (parens > -1) {
      this.raiseRecoverable(parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern");
    }
  };
  pp$9.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
    if (!refDestructuringErrors) {
      return false;
    }
    var shorthandAssign = refDestructuringErrors.shorthandAssign;
    var doubleProto = refDestructuringErrors.doubleProto;
    if (!andThrow) {
      return shorthandAssign >= 0 || doubleProto >= 0;
    }
    if (shorthandAssign >= 0) {
      this.raise(shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns");
    }
    if (doubleProto >= 0) {
      this.raiseRecoverable(doubleProto, "Redefinition of __proto__ property");
    }
  };
  pp$9.checkYieldAwaitInDefaultParams = function() {
    if (this.yieldPos && (!this.awaitPos || this.yieldPos < this.awaitPos)) {
      this.raise(this.yieldPos, "Yield expression cannot be a default value");
    }
    if (this.awaitPos) {
      this.raise(this.awaitPos, "Await expression cannot be a default value");
    }
  };
  pp$9.isSimpleAssignTarget = function(expr) {
    if (expr.type === "ParenthesizedExpression") {
      return this.isSimpleAssignTarget(expr.expression);
    }
    return expr.type === "Identifier" || expr.type === "MemberExpression";
  };
  var pp$8 = Parser.prototype;
  pp$8.parseTopLevel = function(node) {
    var exports =   Object.create(null);
    if (!node.body) {
      node.body = [];
    }
    while (this.type !== types$1.eof) {
      var stmt = this.parseStatement(null, true, exports);
      node.body.push(stmt);
    }
    if (this.inModule) {
      for (var i2 = 0, list = Object.keys(this.undefinedExports); i2 < list.length; i2 += 1) {
        var name = list[i2];
        this.raiseRecoverable(this.undefinedExports[name].start, "Export '" + name + "' is not defined");
      }
    }
    this.adaptDirectivePrologue(node.body);
    this.next();
    node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType;
    return this.finishNode(node, "Program");
  };
  var loopLabel = { kind: "loop" };
  var switchLabel = { kind: "switch" };
  pp$8.isLet = function(context) {
    if (this.options.ecmaVersion < 6 || !this.isContextual("let")) {
      return false;
    }
    skipWhiteSpace.lastIndex = this.pos;
    var skip = skipWhiteSpace.exec(this.input);
    var next = this.pos + skip[0].length, nextCh = this.fullCharCodeAt(next);
    if (nextCh === 91 || nextCh === 92) {
      return true;
    }
    if (context) {
      return false;
    }
    if (nextCh === 123) {
      return true;
    }
    if (isIdentifierStart(nextCh)) {
      var start = next;
      do {
        next += nextCh <= 65535 ? 1 : 2;
      } while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)));
      if (nextCh === 92) {
        return true;
      }
      var ident = this.input.slice(start, next);
      if (!keywordRelationalOperator.test(ident)) {
        return true;
      }
    }
    return false;
  };
  pp$8.isAsyncFunction = function() {
    if (this.options.ecmaVersion < 8 || !this.isContextual("async")) {
      return false;
    }
    skipWhiteSpace.lastIndex = this.pos;
    var skip = skipWhiteSpace.exec(this.input);
    var next = this.pos + skip[0].length, after;
    return !lineBreak.test(this.input.slice(this.pos, next)) && this.input.slice(next, next + 8) === "function" && (next + 8 === this.input.length || !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92));
  };
  pp$8.isUsingKeyword = function(isAwaitUsing, isFor) {
    if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using")) {
      return false;
    }
    skipWhiteSpace.lastIndex = this.pos;
    var skip = skipWhiteSpace.exec(this.input);
    var next = this.pos + skip[0].length;
    if (lineBreak.test(this.input.slice(this.pos, next))) {
      return false;
    }
    if (isAwaitUsing) {
      var usingEndPos = next + 5, after;
      if (this.input.slice(next, usingEndPos) !== "using" || usingEndPos === this.input.length || isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) || after === 92) {
        return false;
      }
      skipWhiteSpace.lastIndex = usingEndPos;
      var skipAfterUsing = skipWhiteSpace.exec(this.input);
      next = usingEndPos + skipAfterUsing[0].length;
      if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) {
        return false;
      }
    }
    var ch = this.fullCharCodeAt(next);
    if (!isIdentifierStart(ch) && ch !== 92) {
      return false;
    }
    var idStart = next;
    do {
      next += ch <= 65535 ? 1 : 2;
    } while (isIdentifierChar(ch = this.fullCharCodeAt(next)));
    if (ch === 92) {
      return true;
    }
    var id = this.input.slice(idStart, next);
    if (keywordRelationalOperator.test(id) || isFor && id === "of") {
      return false;
    }
    return true;
  };
  pp$8.isAwaitUsing = function(isFor) {
    return this.isUsingKeyword(true, isFor);
  };
  pp$8.isUsing = function(isFor) {
    return this.isUsingKeyword(false, isFor);
  };
  pp$8.parseStatement = function(context, topLevel, exports) {
    var starttype = this.type, node = this.startNode(), kind;
    if (this.isLet(context)) {
      starttype = types$1._var;
      kind = "let";
    }
    switch (starttype) {
      case types$1._break:
      case types$1._continue:
        return this.parseBreakContinueStatement(node, starttype.keyword);
      case types$1._debugger:
        return this.parseDebuggerStatement(node);
      case types$1._do:
        return this.parseDoStatement(node);
      case types$1._for:
        return this.parseForStatement(node);
      case types$1._function:
        if (context && (this.strict || context !== "if" && context !== "label") && this.options.ecmaVersion >= 6) {
          this.unexpected();
        }
        return this.parseFunctionStatement(node, false, !context);
      case types$1._class:
        if (context) {
          this.unexpected();
        }
        return this.parseClass(node, true);
      case types$1._if:
        return this.parseIfStatement(node);
      case types$1._return:
        return this.parseReturnStatement(node);
      case types$1._switch:
        return this.parseSwitchStatement(node);
      case types$1._throw:
        return this.parseThrowStatement(node);
      case types$1._try:
        return this.parseTryStatement(node);
      case types$1._const:
      case types$1._var:
        kind = kind || this.value;
        if (context && kind !== "var") {
          this.unexpected();
        }
        return this.parseVarStatement(node, kind);
      case types$1._while:
        return this.parseWhileStatement(node);
      case types$1._with:
        return this.parseWithStatement(node);
      case types$1.braceL:
        return this.parseBlock(true, node);
      case types$1.semi:
        return this.parseEmptyStatement(node);
      case types$1._export:
      case types$1._import:
        if (this.options.ecmaVersion > 10 && starttype === types$1._import) {
          skipWhiteSpace.lastIndex = this.pos;
          var skip = skipWhiteSpace.exec(this.input);
          var next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next);
          if (nextCh === 40 || nextCh === 46) {
            return this.parseExpressionStatement(node, this.parseExpression());
          }
        }
        if (!this.options.allowImportExportEverywhere) {
          if (!topLevel) {
            this.raise(this.start, "'import' and 'export' may only appear at the top level");
          }
          if (!this.inModule) {
            this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
          }
        }
        return starttype === types$1._import ? this.parseImport(node) : this.parseExport(node, exports);
      default:
        if (this.isAsyncFunction()) {
          if (context) {
            this.unexpected();
          }
          this.next();
          return this.parseFunctionStatement(node, true, !context);
        }
        var usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null;
        if (usingKind) {
          if (!this.allowUsing) {
            this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
          }
          if (usingKind === "await using") {
            if (!this.canAwait) {
              this.raise(this.start, "Await using cannot appear outside of async function");
            }
            this.next();
          }
          this.next();
          this.parseVar(node, false, usingKind);
          this.semicolon();
          return this.finishNode(node, "VariableDeclaration");
        }
        var maybeName = this.value, expr = this.parseExpression();
        if (starttype === types$1.name && expr.type === "Identifier" && this.eat(types$1.colon)) {
          return this.parseLabeledStatement(node, maybeName, expr, context);
        } else {
          return this.parseExpressionStatement(node, expr);
        }
    }
  };
  pp$8.parseBreakContinueStatement = function(node, keyword) {
    var isBreak = keyword === "break";
    this.next();
    if (this.eat(types$1.semi) || this.insertSemicolon()) {
      node.label = null;
    } else if (this.type !== types$1.name) {
      this.unexpected();
    } else {
      node.label = this.parseIdent();
      this.semicolon();
    }
    var i2 = 0;
    for (; i2 < this.labels.length; ++i2) {
      var lab = this.labels[i2];
      if (node.label == null || lab.name === node.label.name) {
        if (lab.kind != null && (isBreak || lab.kind === "loop")) {
          break;
        }
        if (node.label && isBreak) {
          break;
        }
      }
    }
    if (i2 === this.labels.length) {
      this.raise(node.start, "Unsyntactic " + keyword);
    }
    return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
  };
  pp$8.parseDebuggerStatement = function(node) {
    this.next();
    this.semicolon();
    return this.finishNode(node, "DebuggerStatement");
  };
  pp$8.parseDoStatement = function(node) {
    this.next();
    this.labels.push(loopLabel);
    node.body = this.parseStatement("do");
    this.labels.pop();
    this.expect(types$1._while);
    node.test = this.parseParenExpression();
    if (this.options.ecmaVersion >= 6) {
      this.eat(types$1.semi);
    } else {
      this.semicolon();
    }
    return this.finishNode(node, "DoWhileStatement");
  };
  pp$8.parseForStatement = function(node) {
    this.next();
    var awaitAt = this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await") ? this.lastTokStart : -1;
    this.labels.push(loopLabel);
    this.enterScope(0);
    this.expect(types$1.parenL);
    if (this.type === types$1.semi) {
      if (awaitAt > -1) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, null);
    }
    var isLet = this.isLet();
    if (this.type === types$1._var || this.type === types$1._const || isLet) {
      var init$1 = this.startNode(), kind = isLet ? "let" : this.value;
      this.next();
      this.parseVar(init$1, true, kind);
      this.finishNode(init$1, "VariableDeclaration");
      return this.parseForAfterInit(node, init$1, awaitAt);
    }
    var startsWithLet = this.isContextual("let"), isForOf = false;
    var usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null;
    if (usingKind) {
      var init$2 = this.startNode();
      this.next();
      if (usingKind === "await using") {
        if (!this.canAwait) {
          this.raise(this.start, "Await using cannot appear outside of async function");
        }
        this.next();
      }
      this.parseVar(init$2, true, usingKind);
      this.finishNode(init$2, "VariableDeclaration");
      return this.parseForAfterInit(node, init$2, awaitAt);
    }
    var containsEsc = this.containsEsc;
    var refDestructuringErrors = new DestructuringErrors();
    var initPos = this.start;
    var init = awaitAt > -1 ? this.parseExprSubscripts(refDestructuringErrors, "await") : this.parseExpression(true, refDestructuringErrors);
    if (this.type === types$1._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
      if (awaitAt > -1) {
        if (this.type === types$1._in) {
          this.unexpected(awaitAt);
        }
        node.await = true;
      } else if (isForOf && this.options.ecmaVersion >= 8) {
        if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") {
          this.unexpected();
        } else if (this.options.ecmaVersion >= 9) {
          node.await = false;
        }
      }
      if (startsWithLet && isForOf) {
        this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'.");
      }
      this.toAssignable(init, false, refDestructuringErrors);
      this.checkLValPattern(init);
      return this.parseForIn(node, init);
    } else {
      this.checkExpressionErrors(refDestructuringErrors, true);
    }
    if (awaitAt > -1) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node, init);
  };
  pp$8.parseForAfterInit = function(node, init, awaitAt) {
    if ((this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init.declarations.length === 1) {
      if (this.options.ecmaVersion >= 9) {
        if (this.type === types$1._in) {
          if (awaitAt > -1) {
            this.unexpected(awaitAt);
          }
        } else {
          node.await = awaitAt > -1;
        }
      }
      return this.parseForIn(node, init);
    }
    if (awaitAt > -1) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node, init);
  };
  pp$8.parseFunctionStatement = function(node, isAsync, declarationPosition) {
    this.next();
    return this.parseFunction(node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync);
  };
  pp$8.parseIfStatement = function(node) {
    this.next();
    node.test = this.parseParenExpression();
    node.consequent = this.parseStatement("if");
    node.alternate = this.eat(types$1._else) ? this.parseStatement("if") : null;
    return this.finishNode(node, "IfStatement");
  };
  pp$8.parseReturnStatement = function(node) {
    if (!this.allowReturn) {
      this.raise(this.start, "'return' outside of function");
    }
    this.next();
    if (this.eat(types$1.semi) || this.insertSemicolon()) {
      node.argument = null;
    } else {
      node.argument = this.parseExpression();
      this.semicolon();
    }
    return this.finishNode(node, "ReturnStatement");
  };
  pp$8.parseSwitchStatement = function(node) {
    this.next();
    node.discriminant = this.parseParenExpression();
    node.cases = [];
    this.expect(types$1.braceL);
    this.labels.push(switchLabel);
    this.enterScope(SCOPE_SWITCH);
    var cur;
    for (var sawDefault = false; this.type !== types$1.braceR; ) {
      if (this.type === types$1._case || this.type === types$1._default) {
        var isCase = this.type === types$1._case;
        if (cur) {
          this.finishNode(cur, "SwitchCase");
        }
        node.cases.push(cur = this.startNode());
        cur.consequent = [];
        this.next();
        if (isCase) {
          cur.test = this.parseExpression();
        } else {
          if (sawDefault) {
            this.raiseRecoverable(this.lastTokStart, "Multiple default clauses");
          }
          sawDefault = true;
          cur.test = null;
        }
        this.expect(types$1.colon);
      } else {
        if (!cur) {
          this.unexpected();
        }
        cur.consequent.push(this.parseStatement(null));
      }
    }
    this.exitScope();
    if (cur) {
      this.finishNode(cur, "SwitchCase");
    }
    this.next();
    this.labels.pop();
    return this.finishNode(node, "SwitchStatement");
  };
  pp$8.parseThrowStatement = function(node) {
    this.next();
    if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) {
      this.raise(this.lastTokEnd, "Illegal newline after throw");
    }
    node.argument = this.parseExpression();
    this.semicolon();
    return this.finishNode(node, "ThrowStatement");
  };
  var empty$1 = [];
  pp$8.parseCatchClauseParam = function() {
    var param = this.parseBindingAtom();
    var simple = param.type === "Identifier";
    this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0);
    this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL);
    this.expect(types$1.parenR);
    return param;
  };
  pp$8.parseTryStatement = function(node) {
    this.next();
    node.block = this.parseBlock();
    node.handler = null;
    if (this.type === types$1._catch) {
      var clause = this.startNode();
      this.next();
      if (this.eat(types$1.parenL)) {
        clause.param = this.parseCatchClauseParam();
      } else {
        if (this.options.ecmaVersion < 10) {
          this.unexpected();
        }
        clause.param = null;
        this.enterScope(0);
      }
      clause.body = this.parseBlock(false);
      this.exitScope();
      node.handler = this.finishNode(clause, "CatchClause");
    }
    node.finalizer = this.eat(types$1._finally) ? this.parseBlock() : null;
    if (!node.handler && !node.finalizer) {
      this.raise(node.start, "Missing catch or finally clause");
    }
    return this.finishNode(node, "TryStatement");
  };
  pp$8.parseVarStatement = function(node, kind, allowMissingInitializer) {
    this.next();
    this.parseVar(node, false, kind, allowMissingInitializer);
    this.semicolon();
    return this.finishNode(node, "VariableDeclaration");
  };
  pp$8.parseWhileStatement = function(node) {
    this.next();
    node.test = this.parseParenExpression();
    this.labels.push(loopLabel);
    node.body = this.parseStatement("while");
    this.labels.pop();
    return this.finishNode(node, "WhileStatement");
  };
  pp$8.parseWithStatement = function(node) {
    if (this.strict) {
      this.raise(this.start, "'with' in strict mode");
    }
    this.next();
    node.object = this.parseParenExpression();
    node.body = this.parseStatement("with");
    return this.finishNode(node, "WithStatement");
  };
  pp$8.parseEmptyStatement = function(node) {
    this.next();
    return this.finishNode(node, "EmptyStatement");
  };
  pp$8.parseLabeledStatement = function(node, maybeName, expr, context) {
    for (var i$1 = 0, list = this.labels; i$1 < list.length; i$1 += 1) {
      var label = list[i$1];
      if (label.name === maybeName) {
        this.raise(expr.start, "Label '" + maybeName + "' is already declared");
      }
    }
    var kind = this.type.isLoop ? "loop" : this.type === types$1._switch ? "switch" : null;
    for (var i2 = this.labels.length - 1; i2 >= 0; i2--) {
      var label$1 = this.labels[i2];
      if (label$1.statementStart === node.start) {
        label$1.statementStart = this.start;
        label$1.kind = kind;
      } else {
        break;
      }
    }
    this.labels.push({ name: maybeName, kind, statementStart: this.start });
    node.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label");
    this.labels.pop();
    node.label = expr;
    return this.finishNode(node, "LabeledStatement");
  };
  pp$8.parseExpressionStatement = function(node, expr) {
    node.expression = expr;
    this.semicolon();
    return this.finishNode(node, "ExpressionStatement");
  };
  pp$8.parseBlock = function(createNewLexicalScope, node, exitStrict) {
    if (createNewLexicalScope === void 0) createNewLexicalScope = true;
    if (node === void 0) node = this.startNode();
    node.body = [];
    this.expect(types$1.braceL);
    if (createNewLexicalScope) {
      this.enterScope(0);
    }
    while (this.type !== types$1.braceR) {
      var stmt = this.parseStatement(null);
      node.body.push(stmt);
    }
    if (exitStrict) {
      this.strict = false;
    }
    this.next();
    if (createNewLexicalScope) {
      this.exitScope();
    }
    return this.finishNode(node, "BlockStatement");
  };
  pp$8.parseFor = function(node, init) {
    node.init = init;
    this.expect(types$1.semi);
    node.test = this.type === types$1.semi ? null : this.parseExpression();
    this.expect(types$1.semi);
    node.update = this.type === types$1.parenR ? null : this.parseExpression();
    this.expect(types$1.parenR);
    node.body = this.parseStatement("for");
    this.exitScope();
    this.labels.pop();
    return this.finishNode(node, "ForStatement");
  };
  pp$8.parseForIn = function(node, init) {
    var isForIn = this.type === types$1._in;
    this.next();
    if (init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || this.options.ecmaVersion < 8 || this.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier")) {
      this.raise(
        init.start,
        (isForIn ? "for-in" : "for-of") + " loop variable declaration may not have an initializer"
      );
    }
    node.left = init;
    node.right = isForIn ? this.parseExpression() : this.parseMaybeAssign();
    this.expect(types$1.parenR);
    node.body = this.parseStatement("for");
    this.exitScope();
    this.labels.pop();
    return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
  };
  pp$8.parseVar = function(node, isFor, kind, allowMissingInitializer) {
    node.declarations = [];
    node.kind = kind;
    for (; ; ) {
      var decl = this.startNode();
      this.parseVarId(decl, kind);
      if (this.eat(types$1.eq)) {
        decl.init = this.parseMaybeAssign(isFor);
      } else if (!allowMissingInitializer && kind === "const" && !(this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
        this.unexpected();
      } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== types$1._in && !this.isContextual("of")) {
        this.raise(this.lastTokEnd, "Missing initializer in " + kind + " declaration");
      } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === types$1._in || this.isContextual("of")))) {
        this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
      } else {
        decl.init = null;
      }
      node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
      if (!this.eat(types$1.comma)) {
        break;
      }
    }
    return node;
  };
  pp$8.parseVarId = function(decl, kind) {
    decl.id = kind === "using" || kind === "await using" ? this.parseIdent() : this.parseBindingAtom();
    this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false);
  };
  var FUNC_STATEMENT = 1;
  var FUNC_HANGING_STATEMENT = 2;
  var FUNC_NULLABLE_ID = 4;
  pp$8.parseFunction = function(node, statement, allowExpressionBody, isAsync, forInit) {
    this.initFunction(node);
    if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
      if (this.type === types$1.star && statement & FUNC_HANGING_STATEMENT) {
        this.unexpected();
      }
      node.generator = this.eat(types$1.star);
    }
    if (this.options.ecmaVersion >= 8) {
      node.async = !!isAsync;
    }
    if (statement & FUNC_STATEMENT) {
      node.id = statement & FUNC_NULLABLE_ID && this.type !== types$1.name ? null : this.parseIdent();
      if (node.id && !(statement & FUNC_HANGING_STATEMENT)) {
        this.checkLValSimple(node.id, this.strict || node.generator || node.async ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION);
      }
    }
    var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    this.enterScope(functionFlags(node.async, node.generator));
    if (!(statement & FUNC_STATEMENT)) {
      node.id = this.type === types$1.name ? this.parseIdent() : null;
    }
    this.parseFunctionParams(node);
    this.parseFunctionBody(node, allowExpressionBody, false, forInit);
    this.yieldPos = oldYieldPos;
    this.awaitPos = oldAwaitPos;
    this.awaitIdentPos = oldAwaitIdentPos;
    return this.finishNode(node, statement & FUNC_STATEMENT ? "FunctionDeclaration" : "FunctionExpression");
  };
  pp$8.parseFunctionParams = function(node) {
    this.expect(types$1.parenL);
    node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
    this.checkYieldAwaitInDefaultParams();
  };
  pp$8.parseClass = function(node, isStatement) {
    this.next();
    var oldStrict = this.strict;
    this.strict = true;
    this.parseClassId(node, isStatement);
    this.parseClassSuper(node);
    var privateNameMap = this.enterClassBody();
    var classBody = this.startNode();
    var hadConstructor = false;
    classBody.body = [];
    this.expect(types$1.braceL);
    while (this.type !== types$1.braceR) {
      var element = this.parseClassElement(node.superClass !== null);
      if (element) {
        classBody.body.push(element);
        if (element.type === "MethodDefinition" && element.kind === "constructor") {
          if (hadConstructor) {
            this.raiseRecoverable(element.start, "Duplicate constructor in the same class");
          }
          hadConstructor = true;
        } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
          this.raiseRecoverable(element.key.start, "Identifier '#" + element.key.name + "' has already been declared");
        }
      }
    }
    this.strict = oldStrict;
    this.next();
    node.body = this.finishNode(classBody, "ClassBody");
    this.exitClassBody();
    return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
  };
  pp$8.parseClassElement = function(constructorAllowsSuper) {
    if (this.eat(types$1.semi)) {
      return null;
    }
    var ecmaVersion = this.options.ecmaVersion;
    var node = this.startNode();
    var keyName = "";
    var isGenerator = false;
    var isAsync = false;
    var kind = "method";
    var isStatic = false;
    if (this.eatContextual("static")) {
      if (ecmaVersion >= 13 && this.eat(types$1.braceL)) {
        this.parseClassStaticBlock(node);
        return node;
      }
      if (this.isClassElementNameStart() || this.type === types$1.star) {
        isStatic = true;
      } else {
        keyName = "static";
      }
    }
    node.static = isStatic;
    if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
      if ((this.isClassElementNameStart() || this.type === types$1.star) && !this.canInsertSemicolon()) {
        isAsync = true;
      } else {
        keyName = "async";
      }
    }
    if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(types$1.star)) {
      isGenerator = true;
    }
    if (!keyName && !isAsync && !isGenerator) {
      var lastValue = this.value;
      if (this.eatContextual("get") || this.eatContextual("set")) {
        if (this.isClassElementNameStart()) {
          kind = lastValue;
        } else {
          keyName = lastValue;
        }
      }
    }
    if (keyName) {
      node.computed = false;
      node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc);
      node.key.name = keyName;
      this.finishNode(node.key, "Identifier");
    } else {
      this.parseClassElementName(node);
    }
    if (ecmaVersion < 13 || this.type === types$1.parenL || kind !== "method" || isGenerator || isAsync) {
      var isConstructor = !node.static && checkKeyName(node, "constructor");
      var allowsDirectSuper = isConstructor && constructorAllowsSuper;
      if (isConstructor && kind !== "method") {
        this.raise(node.key.start, "Constructor can't have get/set modifier");
      }
      node.kind = isConstructor ? "constructor" : kind;
      this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper);
    } else {
      this.parseClassField(node);
    }
    return node;
  };
  pp$8.isClassElementNameStart = function() {
    return this.type === types$1.name || this.type === types$1.privateId || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword;
  };
  pp$8.parseClassElementName = function(element) {
    if (this.type === types$1.privateId) {
      if (this.value === "constructor") {
        this.raise(this.start, "Classes can't have an element named '#constructor'");
      }
      element.computed = false;
      element.key = this.parsePrivateIdent();
    } else {
      this.parsePropertyName(element);
    }
  };
  pp$8.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
    var key = method.key;
    if (method.kind === "constructor") {
      if (isGenerator) {
        this.raise(key.start, "Constructor can't be a generator");
      }
      if (isAsync) {
        this.raise(key.start, "Constructor can't be an async method");
      }
    } else if (method.static && checkKeyName(method, "prototype")) {
      this.raise(key.start, "Classes may not have a static property named prototype");
    }
    var value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper);
    if (method.kind === "get" && value.params.length !== 0) {
      this.raiseRecoverable(value.start, "getter should have no params");
    }
    if (method.kind === "set" && value.params.length !== 1) {
      this.raiseRecoverable(value.start, "setter should have exactly one param");
    }
    if (method.kind === "set" && value.params[0].type === "RestElement") {
      this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params");
    }
    return this.finishNode(method, "MethodDefinition");
  };
  pp$8.parseClassField = function(field) {
    if (checkKeyName(field, "constructor")) {
      this.raise(field.key.start, "Classes can't have a field named 'constructor'");
    } else if (field.static && checkKeyName(field, "prototype")) {
      this.raise(field.key.start, "Classes can't have a static field named 'prototype'");
    }
    if (this.eat(types$1.eq)) {
      this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER);
      field.value = this.parseMaybeAssign();
      this.exitScope();
    } else {
      field.value = null;
    }
    this.semicolon();
    return this.finishNode(field, "PropertyDefinition");
  };
  pp$8.parseClassStaticBlock = function(node) {
    node.body = [];
    var oldLabels = this.labels;
    this.labels = [];
    this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER);
    while (this.type !== types$1.braceR) {
      var stmt = this.parseStatement(null);
      node.body.push(stmt);
    }
    this.next();
    this.exitScope();
    this.labels = oldLabels;
    return this.finishNode(node, "StaticBlock");
  };
  pp$8.parseClassId = function(node, isStatement) {
    if (this.type === types$1.name) {
      node.id = this.parseIdent();
      if (isStatement) {
        this.checkLValSimple(node.id, BIND_LEXICAL, false);
      }
    } else {
      if (isStatement === true) {
        this.unexpected();
      }
      node.id = null;
    }
  };
  pp$8.parseClassSuper = function(node) {
    node.superClass = this.eat(types$1._extends) ? this.parseExprSubscripts(null, false) : null;
  };
  pp$8.enterClassBody = function() {
    var element = { declared:   Object.create(null), used: [] };
    this.privateNameStack.push(element);
    return element.declared;
  };
  pp$8.exitClassBody = function() {
    var ref2 = this.privateNameStack.pop();
    var declared = ref2.declared;
    var used = ref2.used;
    if (!this.options.checkPrivateFields) {
      return;
    }
    var len = this.privateNameStack.length;
    var parent = len === 0 ? null : this.privateNameStack[len - 1];
    for (var i2 = 0; i2 < used.length; ++i2) {
      var id = used[i2];
      if (!hasOwn(declared, id.name)) {
        if (parent) {
          parent.used.push(id);
        } else {
          this.raiseRecoverable(id.start, "Private field '#" + id.name + "' must be declared in an enclosing class");
        }
      }
    }
  };
  function isPrivateNameConflicted(privateNameMap, element) {
    var name = element.key.name;
    var curr = privateNameMap[name];
    var next = "true";
    if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
      next = (element.static ? "s" : "i") + element.kind;
    }
    if (curr === "iget" && next === "iset" || curr === "iset" && next === "iget" || curr === "sget" && next === "sset" || curr === "sset" && next === "sget") {
      privateNameMap[name] = "true";
      return false;
    } else if (!curr) {
      privateNameMap[name] = next;
      return false;
    } else {
      return true;
    }
  }
  function checkKeyName(node, name) {
    var computed = node.computed;
    var key = node.key;
    return !computed && (key.type === "Identifier" && key.name === name || key.type === "Literal" && key.value === name);
  }
  pp$8.parseExportAllDeclaration = function(node, exports) {
    if (this.options.ecmaVersion >= 11) {
      if (this.eatContextual("as")) {
        node.exported = this.parseModuleExportName();
        this.checkExport(exports, node.exported, this.lastTokStart);
      } else {
        node.exported = null;
      }
    }
    this.expectContextual("from");
    if (this.type !== types$1.string) {
      this.unexpected();
    }
    node.source = this.parseExprAtom();
    if (this.options.ecmaVersion >= 16) {
      node.attributes = this.parseWithClause();
    }
    this.semicolon();
    return this.finishNode(node, "ExportAllDeclaration");
  };
  pp$8.parseExport = function(node, exports) {
    this.next();
    if (this.eat(types$1.star)) {
      return this.parseExportAllDeclaration(node, exports);
    }
    if (this.eat(types$1._default)) {
      this.checkExport(exports, "default", this.lastTokStart);
      node.declaration = this.parseExportDefaultDeclaration();
      return this.finishNode(node, "ExportDefaultDeclaration");
    }
    if (this.shouldParseExportStatement()) {
      node.declaration = this.parseExportDeclaration(node);
      if (node.declaration.type === "VariableDeclaration") {
        this.checkVariableExport(exports, node.declaration.declarations);
      } else {
        this.checkExport(exports, node.declaration.id, node.declaration.id.start);
      }
      node.specifiers = [];
      node.source = null;
      if (this.options.ecmaVersion >= 16) {
        node.attributes = [];
      }
    } else {
      node.declaration = null;
      node.specifiers = this.parseExportSpecifiers(exports);
      if (this.eatContextual("from")) {
        if (this.type !== types$1.string) {
          this.unexpected();
        }
        node.source = this.parseExprAtom();
        if (this.options.ecmaVersion >= 16) {
          node.attributes = this.parseWithClause();
        }
      } else {
        for (var i2 = 0, list = node.specifiers; i2 < list.length; i2 += 1) {
          var spec = list[i2];
          this.checkUnreserved(spec.local);
          this.checkLocalExport(spec.local);
          if (spec.local.type === "Literal") {
            this.raise(spec.local.start, "A string literal cannot be used as an exported binding without `from`.");
          }
        }
        node.source = null;
        if (this.options.ecmaVersion >= 16) {
          node.attributes = [];
        }
      }
      this.semicolon();
    }
    return this.finishNode(node, "ExportNamedDeclaration");
  };
  pp$8.parseExportDeclaration = function(node) {
    return this.parseStatement(null);
  };
  pp$8.parseExportDefaultDeclaration = function() {
    var isAsync;
    if (this.type === types$1._function || (isAsync = this.isAsyncFunction())) {
      var fNode = this.startNode();
      this.next();
      if (isAsync) {
        this.next();
      }
      return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync);
    } else if (this.type === types$1._class) {
      var cNode = this.startNode();
      return this.parseClass(cNode, "nullableID");
    } else {
      var declaration = this.parseMaybeAssign();
      this.semicolon();
      return declaration;
    }
  };
  pp$8.checkExport = function(exports, name, pos) {
    if (!exports) {
      return;
    }
    if (typeof name !== "string") {
      name = name.type === "Identifier" ? name.name : name.value;
    }
    if (hasOwn(exports, name)) {
      this.raiseRecoverable(pos, "Duplicate export '" + name + "'");
    }
    exports[name] = true;
  };
  pp$8.checkPatternExport = function(exports, pat) {
    var type = pat.type;
    if (type === "Identifier") {
      this.checkExport(exports, pat, pat.start);
    } else if (type === "ObjectPattern") {
      for (var i2 = 0, list = pat.properties; i2 < list.length; i2 += 1) {
        var prop = list[i2];
        this.checkPatternExport(exports, prop);
      }
    } else if (type === "ArrayPattern") {
      for (var i$1 = 0, list$1 = pat.elements; i$1 < list$1.length; i$1 += 1) {
        var elt = list$1[i$1];
        if (elt) {
          this.checkPatternExport(exports, elt);
        }
      }
    } else if (type === "Property") {
      this.checkPatternExport(exports, pat.value);
    } else if (type === "AssignmentPattern") {
      this.checkPatternExport(exports, pat.left);
    } else if (type === "RestElement") {
      this.checkPatternExport(exports, pat.argument);
    }
  };
  pp$8.checkVariableExport = function(exports, decls) {
    if (!exports) {
      return;
    }
    for (var i2 = 0, list = decls; i2 < list.length; i2 += 1) {
      var decl = list[i2];
      this.checkPatternExport(exports, decl.id);
    }
  };
  pp$8.shouldParseExportStatement = function() {
    return this.type.keyword === "var" || this.type.keyword === "const" || this.type.keyword === "class" || this.type.keyword === "function" || this.isLet() || this.isAsyncFunction();
  };
  pp$8.parseExportSpecifier = function(exports) {
    var node = this.startNode();
    node.local = this.parseModuleExportName();
    node.exported = this.eatContextual("as") ? this.parseModuleExportName() : node.local;
    this.checkExport(
      exports,
      node.exported,
      node.exported.start
    );
    return this.finishNode(node, "ExportSpecifier");
  };
  pp$8.parseExportSpecifiers = function(exports) {
    var nodes = [], first = true;
    this.expect(types$1.braceL);
    while (!this.eat(types$1.braceR)) {
      if (!first) {
        this.expect(types$1.comma);
        if (this.afterTrailingComma(types$1.braceR)) {
          break;
        }
      } else {
        first = false;
      }
      nodes.push(this.parseExportSpecifier(exports));
    }
    return nodes;
  };
  pp$8.parseImport = function(node) {
    this.next();
    if (this.type === types$1.string) {
      node.specifiers = empty$1;
      node.source = this.parseExprAtom();
    } else {
      node.specifiers = this.parseImportSpecifiers();
      this.expectContextual("from");
      node.source = this.type === types$1.string ? this.parseExprAtom() : this.unexpected();
    }
    if (this.options.ecmaVersion >= 16) {
      node.attributes = this.parseWithClause();
    }
    this.semicolon();
    return this.finishNode(node, "ImportDeclaration");
  };
  pp$8.parseImportSpecifier = function() {
    var node = this.startNode();
    node.imported = this.parseModuleExportName();
    if (this.eatContextual("as")) {
      node.local = this.parseIdent();
    } else {
      this.checkUnreserved(node.imported);
      node.local = node.imported;
    }
    this.checkLValSimple(node.local, BIND_LEXICAL);
    return this.finishNode(node, "ImportSpecifier");
  };
  pp$8.parseImportDefaultSpecifier = function() {
    var node = this.startNode();
    node.local = this.parseIdent();
    this.checkLValSimple(node.local, BIND_LEXICAL);
    return this.finishNode(node, "ImportDefaultSpecifier");
  };
  pp$8.parseImportNamespaceSpecifier = function() {
    var node = this.startNode();
    this.next();
    this.expectContextual("as");
    node.local = this.parseIdent();
    this.checkLValSimple(node.local, BIND_LEXICAL);
    return this.finishNode(node, "ImportNamespaceSpecifier");
  };
  pp$8.parseImportSpecifiers = function() {
    var nodes = [], first = true;
    if (this.type === types$1.name) {
      nodes.push(this.parseImportDefaultSpecifier());
      if (!this.eat(types$1.comma)) {
        return nodes;
      }
    }
    if (this.type === types$1.star) {
      nodes.push(this.parseImportNamespaceSpecifier());
      return nodes;
    }
    this.expect(types$1.braceL);
    while (!this.eat(types$1.braceR)) {
      if (!first) {
        this.expect(types$1.comma);
        if (this.afterTrailingComma(types$1.braceR)) {
          break;
        }
      } else {
        first = false;
      }
      nodes.push(this.parseImportSpecifier());
    }
    return nodes;
  };
  pp$8.parseWithClause = function() {
    var nodes = [];
    if (!this.eat(types$1._with)) {
      return nodes;
    }
    this.expect(types$1.braceL);
    var attributeKeys = {};
    var first = true;
    while (!this.eat(types$1.braceR)) {
      if (!first) {
        this.expect(types$1.comma);
        if (this.afterTrailingComma(types$1.braceR)) {
          break;
        }
      } else {
        first = false;
      }
      var attr = this.parseImportAttribute();
      var keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value;
      if (hasOwn(attributeKeys, keyName)) {
        this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'");
      }
      attributeKeys[keyName] = true;
      nodes.push(attr);
    }
    return nodes;
  };
  pp$8.parseImportAttribute = function() {
    var node = this.startNode();
    node.key = this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
    this.expect(types$1.colon);
    if (this.type !== types$1.string) {
      this.unexpected();
    }
    node.value = this.parseExprAtom();
    return this.finishNode(node, "ImportAttribute");
  };
  pp$8.parseModuleExportName = function() {
    if (this.options.ecmaVersion >= 13 && this.type === types$1.string) {
      var stringLiteral = this.parseLiteral(this.value);
      if (loneSurrogate.test(stringLiteral.value)) {
        this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.");
      }
      return stringLiteral;
    }
    return this.parseIdent(true);
  };
  pp$8.adaptDirectivePrologue = function(statements) {
    for (var i2 = 0; i2 < statements.length && this.isDirectiveCandidate(statements[i2]); ++i2) {
      statements[i2].directive = statements[i2].expression.raw.slice(1, -1);
    }
  };
  pp$8.isDirectiveCandidate = function(statement) {
    return this.options.ecmaVersion >= 5 && statement.type === "ExpressionStatement" && statement.expression.type === "Literal" && typeof statement.expression.value === "string" &&
    (this.input[statement.start] === '"' || this.input[statement.start] === "'");
  };
  var pp$7 = Parser.prototype;
  pp$7.toAssignable = function(node, isBinding, refDestructuringErrors) {
    if (this.options.ecmaVersion >= 6 && node) {
      switch (node.type) {
        case "Identifier":
          if (this.inAsync && node.name === "await") {
            this.raise(node.start, "Cannot use 'await' as identifier inside an async function");
          }
          break;
        case "ObjectPattern":
        case "ArrayPattern":
        case "AssignmentPattern":
        case "RestElement":
          break;
        case "ObjectExpression":
          node.type = "ObjectPattern";
          if (refDestructuringErrors) {
            this.checkPatternErrors(refDestructuringErrors, true);
          }
          for (var i2 = 0, list = node.properties; i2 < list.length; i2 += 1) {
            var prop = list[i2];
            this.toAssignable(prop, isBinding);
            if (prop.type === "RestElement" && (prop.argument.type === "ArrayPattern" || prop.argument.type === "ObjectPattern")) {
              this.raise(prop.argument.start, "Unexpected token");
            }
          }
          break;
        case "Property":
          if (node.kind !== "init") {
            this.raise(node.key.start, "Object pattern can't contain getter or setter");
          }
          this.toAssignable(node.value, isBinding);
          break;
        case "ArrayExpression":
          node.type = "ArrayPattern";
          if (refDestructuringErrors) {
            this.checkPatternErrors(refDestructuringErrors, true);
          }
          this.toAssignableList(node.elements, isBinding);
          break;
        case "SpreadElement":
          node.type = "RestElement";
          this.toAssignable(node.argument, isBinding);
          if (node.argument.type === "AssignmentPattern") {
            this.raise(node.argument.start, "Rest elements cannot have a default value");
          }
          break;
        case "AssignmentExpression":
          if (node.operator !== "=") {
            this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
          }
          node.type = "AssignmentPattern";
          delete node.operator;
          this.toAssignable(node.left, isBinding);
          break;
        case "ParenthesizedExpression":
          this.toAssignable(node.expression, isBinding, refDestructuringErrors);
          break;
        case "ChainExpression":
          this.raiseRecoverable(node.start, "Optional chaining cannot appear in left-hand side");
          break;
        case "MemberExpression":
          if (!isBinding) {
            break;
          }
        default:
          this.raise(node.start, "Assigning to rvalue");
      }
    } else if (refDestructuringErrors) {
      this.checkPatternErrors(refDestructuringErrors, true);
    }
    return node;
  };
  pp$7.toAssignableList = function(exprList, isBinding) {
    var end = exprList.length;
    for (var i2 = 0; i2 < end; i2++) {
      var elt = exprList[i2];
      if (elt) {
        this.toAssignable(elt, isBinding);
      }
    }
    if (end) {
      var last = exprList[end - 1];
      if (this.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier") {
        this.unexpected(last.argument.start);
      }
    }
    return exprList;
  };
  pp$7.parseSpread = function(refDestructuringErrors) {
    var node = this.startNode();
    this.next();
    node.argument = this.parseMaybeAssign(false, refDestructuringErrors);
    return this.finishNode(node, "SpreadElement");
  };
  pp$7.parseRestBinding = function() {
    var node = this.startNode();
    this.next();
    if (this.options.ecmaVersion === 6 && this.type !== types$1.name) {
      this.unexpected();
    }
    node.argument = this.parseBindingAtom();
    return this.finishNode(node, "RestElement");
  };
  pp$7.parseBindingAtom = function() {
    if (this.options.ecmaVersion >= 6) {
      switch (this.type) {
        case types$1.bracketL:
          var node = this.startNode();
          this.next();
          node.elements = this.parseBindingList(types$1.bracketR, true, true);
          return this.finishNode(node, "ArrayPattern");
        case types$1.braceL:
          return this.parseObj(true);
      }
    }
    return this.parseIdent();
  };
  pp$7.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowModifiers) {
    var elts = [], first = true;
    while (!this.eat(close)) {
      if (first) {
        first = false;
      } else {
        this.expect(types$1.comma);
      }
      if (allowEmpty && this.type === types$1.comma) {
        elts.push(null);
      } else if (allowTrailingComma && this.afterTrailingComma(close)) {
        break;
      } else if (this.type === types$1.ellipsis) {
        var rest = this.parseRestBinding();
        this.parseBindingListItem(rest);
        elts.push(rest);
        if (this.type === types$1.comma) {
          this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
        }
        this.expect(close);
        break;
      } else {
        elts.push(this.parseAssignableListItem(allowModifiers));
      }
    }
    return elts;
  };
  pp$7.parseAssignableListItem = function(allowModifiers) {
    var elem = this.parseMaybeDefault(this.start, this.startLoc);
    this.parseBindingListItem(elem);
    return elem;
  };
  pp$7.parseBindingListItem = function(param) {
    return param;
  };
  pp$7.parseMaybeDefault = function(startPos, startLoc, left) {
    left = left || this.parseBindingAtom();
    if (this.options.ecmaVersion < 6 || !this.eat(types$1.eq)) {
      return left;
    }
    var node = this.startNodeAt(startPos, startLoc);
    node.left = left;
    node.right = this.parseMaybeAssign();
    return this.finishNode(node, "AssignmentPattern");
  };
  pp$7.checkLValSimple = function(expr, bindingType, checkClashes) {
    if (bindingType === void 0) bindingType = BIND_NONE;
    var isBind = bindingType !== BIND_NONE;
    switch (expr.type) {
      case "Identifier":
        if (this.strict && this.reservedWordsStrictBind.test(expr.name)) {
          this.raiseRecoverable(expr.start, (isBind ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
        }
        if (isBind) {
          if (bindingType === BIND_LEXICAL && expr.name === "let") {
            this.raiseRecoverable(expr.start, "let is disallowed as a lexically bound name");
          }
          if (checkClashes) {
            if (hasOwn(checkClashes, expr.name)) {
              this.raiseRecoverable(expr.start, "Argument name clash");
            }
            checkClashes[expr.name] = true;
          }
          if (bindingType !== BIND_OUTSIDE) {
            this.declareName(expr.name, bindingType, expr.start);
          }
        }
        break;
      case "ChainExpression":
        this.raiseRecoverable(expr.start, "Optional chaining cannot appear in left-hand side");
        break;
      case "MemberExpression":
        if (isBind) {
          this.raiseRecoverable(expr.start, "Binding member expression");
        }
        break;
      case "ParenthesizedExpression":
        if (isBind) {
          this.raiseRecoverable(expr.start, "Binding parenthesized expression");
        }
        return this.checkLValSimple(expr.expression, bindingType, checkClashes);
      default:
        this.raise(expr.start, (isBind ? "Binding" : "Assigning to") + " rvalue");
    }
  };
  pp$7.checkLValPattern = function(expr, bindingType, checkClashes) {
    if (bindingType === void 0) bindingType = BIND_NONE;
    switch (expr.type) {
      case "ObjectPattern":
        for (var i2 = 0, list = expr.properties; i2 < list.length; i2 += 1) {
          var prop = list[i2];
          this.checkLValInnerPattern(prop, bindingType, checkClashes);
        }
        break;
      case "ArrayPattern":
        for (var i$1 = 0, list$1 = expr.elements; i$1 < list$1.length; i$1 += 1) {
          var elem = list$1[i$1];
          if (elem) {
            this.checkLValInnerPattern(elem, bindingType, checkClashes);
          }
        }
        break;
      default:
        this.checkLValSimple(expr, bindingType, checkClashes);
    }
  };
  pp$7.checkLValInnerPattern = function(expr, bindingType, checkClashes) {
    if (bindingType === void 0) bindingType = BIND_NONE;
    switch (expr.type) {
      case "Property":
        this.checkLValInnerPattern(expr.value, bindingType, checkClashes);
        break;
      case "AssignmentPattern":
        this.checkLValPattern(expr.left, bindingType, checkClashes);
        break;
      case "RestElement":
        this.checkLValPattern(expr.argument, bindingType, checkClashes);
        break;
      default:
        this.checkLValPattern(expr, bindingType, checkClashes);
    }
  };
  var TokContext = function TokContext2(token, isExpr, preserveSpace, override, generator) {
    this.token = token;
    this.isExpr = !!isExpr;
    this.preserveSpace = !!preserveSpace;
    this.override = override;
    this.generator = !!generator;
  };
  var types = {
    b_stat: new TokContext("{", false),
    b_expr: new TokContext("{", true),
    b_tmpl: new TokContext("${", false),
    p_stat: new TokContext("(", false),
    p_expr: new TokContext("(", true),
    q_tmpl: new TokContext("`", true, true, function(p) {
      return p.tryReadTemplateToken();
    }),
    f_stat: new TokContext("function", false),
    f_expr: new TokContext("function", true),
    f_expr_gen: new TokContext("function", true, false, null, true),
    f_gen: new TokContext("function", false, false, null, true)
  };
  var pp$6 = Parser.prototype;
  pp$6.initialContext = function() {
    return [types.b_stat];
  };
  pp$6.curContext = function() {
    return this.context[this.context.length - 1];
  };
  pp$6.braceIsBlock = function(prevType) {
    var parent = this.curContext();
    if (parent === types.f_expr || parent === types.f_stat) {
      return true;
    }
    if (prevType === types$1.colon && (parent === types.b_stat || parent === types.b_expr)) {
      return !parent.isExpr;
    }
    if (prevType === types$1._return || prevType === types$1.name && this.exprAllowed) {
      return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
    }
    if (prevType === types$1._else || prevType === types$1.semi || prevType === types$1.eof || prevType === types$1.parenR || prevType === types$1.arrow) {
      return true;
    }
    if (prevType === types$1.braceL) {
      return parent === types.b_stat;
    }
    if (prevType === types$1._var || prevType === types$1._const || prevType === types$1.name) {
      return false;
    }
    return !this.exprAllowed;
  };
  pp$6.inGeneratorContext = function() {
    for (var i2 = this.context.length - 1; i2 >= 1; i2--) {
      var context = this.context[i2];
      if (context.token === "function") {
        return context.generator;
      }
    }
    return false;
  };
  pp$6.updateContext = function(prevType) {
    var update, type = this.type;
    if (type.keyword && prevType === types$1.dot) {
      this.exprAllowed = false;
    } else if (update = type.updateContext) {
      update.call(this, prevType);
    } else {
      this.exprAllowed = type.beforeExpr;
    }
  };
  pp$6.overrideContext = function(tokenCtx) {
    if (this.curContext() !== tokenCtx) {
      this.context[this.context.length - 1] = tokenCtx;
    }
  };
  types$1.parenR.updateContext = types$1.braceR.updateContext = function() {
    if (this.context.length === 1) {
      this.exprAllowed = true;
      return;
    }
    var out = this.context.pop();
    if (out === types.b_stat && this.curContext().token === "function") {
      out = this.context.pop();
    }
    this.exprAllowed = !out.isExpr;
  };
  types$1.braceL.updateContext = function(prevType) {
    this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
    this.exprAllowed = true;
  };
  types$1.dollarBraceL.updateContext = function() {
    this.context.push(types.b_tmpl);
    this.exprAllowed = true;
  };
  types$1.parenL.updateContext = function(prevType) {
    var statementParens = prevType === types$1._if || prevType === types$1._for || prevType === types$1._with || prevType === types$1._while;
    this.context.push(statementParens ? types.p_stat : types.p_expr);
    this.exprAllowed = true;
  };
  types$1.incDec.updateContext = function() {
  };
  types$1._function.updateContext = types$1._class.updateContext = function(prevType) {
    if (prevType.beforeExpr && prevType !== types$1._else && !(prevType === types$1.semi && this.curContext() !== types.p_stat) && !(prevType === types$1._return && lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) && !((prevType === types$1.colon || prevType === types$1.braceL) && this.curContext() === types.b_stat)) {
      this.context.push(types.f_expr);
    } else {
      this.context.push(types.f_stat);
    }
    this.exprAllowed = false;
  };
  types$1.colon.updateContext = function() {
    if (this.curContext().token === "function") {
      this.context.pop();
    }
    this.exprAllowed = true;
  };
  types$1.backQuote.updateContext = function() {
    if (this.curContext() === types.q_tmpl) {
      this.context.pop();
    } else {
      this.context.push(types.q_tmpl);
    }
    this.exprAllowed = false;
  };
  types$1.star.updateContext = function(prevType) {
    if (prevType === types$1._function) {
      var index = this.context.length - 1;
      if (this.context[index] === types.f_expr) {
        this.context[index] = types.f_expr_gen;
      } else {
        this.context[index] = types.f_gen;
      }
    }
    this.exprAllowed = true;
  };
  types$1.name.updateContext = function(prevType) {
    var allowed = false;
    if (this.options.ecmaVersion >= 6 && prevType !== types$1.dot) {
      if (this.value === "of" && !this.exprAllowed || this.value === "yield" && this.inGeneratorContext()) {
        allowed = true;
      }
    }
    this.exprAllowed = allowed;
  };
  var pp$5 = Parser.prototype;
  pp$5.checkPropClash = function(prop, propHash, refDestructuringErrors) {
    if (this.options.ecmaVersion >= 9 && prop.type === "SpreadElement") {
      return;
    }
    if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) {
      return;
    }
    var key = prop.key;
    var name;
    switch (key.type) {
      case "Identifier":
        name = key.name;
        break;
      case "Literal":
        name = String(key.value);
        break;
      default:
        return;
    }
    var kind = prop.kind;
    if (this.options.ecmaVersion >= 6) {
      if (name === "__proto__" && kind === "init") {
        if (propHash.proto) {
          if (refDestructuringErrors) {
            if (refDestructuringErrors.doubleProto < 0) {
              refDestructuringErrors.doubleProto = key.start;
            }
          } else {
            this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
          }
        }
        propHash.proto = true;
      }
      return;
    }
    name = "$" + name;
    var other = propHash[name];
    if (other) {
      var redefinition;
      if (kind === "init") {
        redefinition = this.strict && other.init || other.get || other.set;
      } else {
        redefinition = other.init || other[kind];
      }
      if (redefinition) {
        this.raiseRecoverable(key.start, "Redefinition of property");
      }
    } else {
      other = propHash[name] = {
        init: false,
        get: false,
        set: false
      };
    }
    other[kind] = true;
  };
  pp$5.parseExpression = function(forInit, refDestructuringErrors) {
    var startPos = this.start, startLoc = this.startLoc;
    var expr = this.parseMaybeAssign(forInit, refDestructuringErrors);
    if (this.type === types$1.comma) {
      var node = this.startNodeAt(startPos, startLoc);
      node.expressions = [expr];
      while (this.eat(types$1.comma)) {
        node.expressions.push(this.parseMaybeAssign(forInit, refDestructuringErrors));
      }
      return this.finishNode(node, "SequenceExpression");
    }
    return expr;
  };
  pp$5.parseMaybeAssign = function(forInit, refDestructuringErrors, afterLeftParse) {
    if (this.isContextual("yield")) {
      if (this.inGenerator) {
        return this.parseYield(forInit);
      } else {
        this.exprAllowed = false;
      }
    }
    var ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1;
    if (refDestructuringErrors) {
      oldParenAssign = refDestructuringErrors.parenthesizedAssign;
      oldTrailingComma = refDestructuringErrors.trailingComma;
      oldDoubleProto = refDestructuringErrors.doubleProto;
      refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1;
    } else {
      refDestructuringErrors = new DestructuringErrors();
      ownDestructuringErrors = true;
    }
    var startPos = this.start, startLoc = this.startLoc;
    if (this.type === types$1.parenL || this.type === types$1.name) {
      this.potentialArrowAt = this.start;
      this.potentialArrowInForAwait = forInit === "await";
    }
    var left = this.parseMaybeConditional(forInit, refDestructuringErrors);
    if (afterLeftParse) {
      left = afterLeftParse.call(this, left, startPos, startLoc);
    }
    if (this.type.isAssign) {
      var node = this.startNodeAt(startPos, startLoc);
      node.operator = this.value;
      if (this.type === types$1.eq) {
        left = this.toAssignable(left, false, refDestructuringErrors);
      }
      if (!ownDestructuringErrors) {
        refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = refDestructuringErrors.doubleProto = -1;
      }
      if (refDestructuringErrors.shorthandAssign >= left.start) {
        refDestructuringErrors.shorthandAssign = -1;
      }
      if (this.type === types$1.eq) {
        this.checkLValPattern(left);
      } else {
        this.checkLValSimple(left);
      }
      node.left = left;
      this.next();
      node.right = this.parseMaybeAssign(forInit);
      if (oldDoubleProto > -1) {
        refDestructuringErrors.doubleProto = oldDoubleProto;
      }
      return this.finishNode(node, "AssignmentExpression");
    } else {
      if (ownDestructuringErrors) {
        this.checkExpressionErrors(refDestructuringErrors, true);
      }
    }
    if (oldParenAssign > -1) {
      refDestructuringErrors.parenthesizedAssign = oldParenAssign;
    }
    if (oldTrailingComma > -1) {
      refDestructuringErrors.trailingComma = oldTrailingComma;
    }
    return left;
  };
  pp$5.parseMaybeConditional = function(forInit, refDestructuringErrors) {
    var startPos = this.start, startLoc = this.startLoc;
    var expr = this.parseExprOps(forInit, refDestructuringErrors);
    if (this.checkExpressionErrors(refDestructuringErrors)) {
      return expr;
    }
    if (this.eat(types$1.question)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.test = expr;
      node.consequent = this.parseMaybeAssign();
      this.expect(types$1.colon);
      node.alternate = this.parseMaybeAssign(forInit);
      return this.finishNode(node, "ConditionalExpression");
    }
    return expr;
  };
  pp$5.parseExprOps = function(forInit, refDestructuringErrors) {
    var startPos = this.start, startLoc = this.startLoc;
    var expr = this.parseMaybeUnary(refDestructuringErrors, false, false, forInit);
    if (this.checkExpressionErrors(refDestructuringErrors)) {
      return expr;
    }
    return expr.start === startPos && expr.type === "ArrowFunctionExpression" ? expr : this.parseExprOp(expr, startPos, startLoc, -1, forInit);
  };
  pp$5.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, forInit) {
    var prec = this.type.binop;
    if (prec != null && (!forInit || this.type !== types$1._in)) {
      if (prec > minPrec) {
        var logical = this.type === types$1.logicalOR || this.type === types$1.logicalAND;
        var coalesce = this.type === types$1.coalesce;
        if (coalesce) {
          prec = types$1.logicalAND.binop;
        }
        var op = this.value;
        this.next();
        var startPos = this.start, startLoc = this.startLoc;
        var right = this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), startPos, startLoc, prec, forInit);
        var node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical || coalesce);
        if (logical && this.type === types$1.coalesce || coalesce && (this.type === types$1.logicalOR || this.type === types$1.logicalAND)) {
          this.raiseRecoverable(this.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
        }
        return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, forInit);
      }
    }
    return left;
  };
  pp$5.buildBinary = function(startPos, startLoc, left, right, op, logical) {
    if (right.type === "PrivateIdentifier") {
      this.raise(right.start, "Private identifier can only be left side of binary expression");
    }
    var node = this.startNodeAt(startPos, startLoc);
    node.left = left;
    node.operator = op;
    node.right = right;
    return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression");
  };
  pp$5.parseMaybeUnary = function(refDestructuringErrors, sawUnary, incDec, forInit) {
    var startPos = this.start, startLoc = this.startLoc, expr;
    if (this.isContextual("await") && this.canAwait) {
      expr = this.parseAwait(forInit);
      sawUnary = true;
    } else if (this.type.prefix) {
      var node = this.startNode(), update = this.type === types$1.incDec;
      node.operator = this.value;
      node.prefix = true;
      this.next();
      node.argument = this.parseMaybeUnary(null, true, update, forInit);
      this.checkExpressionErrors(refDestructuringErrors, true);
      if (update) {
        this.checkLValSimple(node.argument);
      } else if (this.strict && node.operator === "delete" && isLocalVariableAccess(node.argument)) {
        this.raiseRecoverable(node.start, "Deleting local variable in strict mode");
      } else if (node.operator === "delete" && isPrivateFieldAccess(node.argument)) {
        this.raiseRecoverable(node.start, "Private fields can not be deleted");
      } else {
        sawUnary = true;
      }
      expr = this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
    } else if (!sawUnary && this.type === types$1.privateId) {
      if ((forInit || this.privateNameStack.length === 0) && this.options.checkPrivateFields) {
        this.unexpected();
      }
      expr = this.parsePrivateIdent();
      if (this.type !== types$1._in) {
        this.unexpected();
      }
    } else {
      expr = this.parseExprSubscripts(refDestructuringErrors, forInit);
      if (this.checkExpressionErrors(refDestructuringErrors)) {
        return expr;
      }
      while (this.type.postfix && !this.canInsertSemicolon()) {
        var node$1 = this.startNodeAt(startPos, startLoc);
        node$1.operator = this.value;
        node$1.prefix = false;
        node$1.argument = expr;
        this.checkLValSimple(expr);
        this.next();
        expr = this.finishNode(node$1, "UpdateExpression");
      }
    }
    if (!incDec && this.eat(types$1.starstar)) {
      if (sawUnary) {
        this.unexpected(this.lastTokStart);
      } else {
        return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false, false, forInit), "**", false);
      }
    } else {
      return expr;
    }
  };
  function isLocalVariableAccess(node) {
    return node.type === "Identifier" || node.type === "ParenthesizedExpression" && isLocalVariableAccess(node.expression);
  }
  function isPrivateFieldAccess(node) {
    return node.type === "MemberExpression" && node.property.type === "PrivateIdentifier" || node.type === "ChainExpression" && isPrivateFieldAccess(node.expression) || node.type === "ParenthesizedExpression" && isPrivateFieldAccess(node.expression);
  }
  pp$5.parseExprSubscripts = function(refDestructuringErrors, forInit) {
    var startPos = this.start, startLoc = this.startLoc;
    var expr = this.parseExprAtom(refDestructuringErrors, forInit);
    if (expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")") {
      return expr;
    }
    var result = this.parseSubscripts(expr, startPos, startLoc, false, forInit);
    if (refDestructuringErrors && result.type === "MemberExpression") {
      if (refDestructuringErrors.parenthesizedAssign >= result.start) {
        refDestructuringErrors.parenthesizedAssign = -1;
      }
      if (refDestructuringErrors.parenthesizedBind >= result.start) {
        refDestructuringErrors.parenthesizedBind = -1;
      }
      if (refDestructuringErrors.trailingComma >= result.start) {
        refDestructuringErrors.trailingComma = -1;
      }
    }
    return result;
  };
  pp$5.parseSubscripts = function(base2, startPos, startLoc, noCalls, forInit) {
    var maybeAsyncArrow = this.options.ecmaVersion >= 8 && base2.type === "Identifier" && base2.name === "async" && this.lastTokEnd === base2.end && !this.canInsertSemicolon() && base2.end - base2.start === 5 && this.potentialArrowAt === base2.start;
    var optionalChained = false;
    while (true) {
      var element = this.parseSubscript(base2, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit);
      if (element.optional) {
        optionalChained = true;
      }
      if (element === base2 || element.type === "ArrowFunctionExpression") {
        if (optionalChained) {
          var chainNode = this.startNodeAt(startPos, startLoc);
          chainNode.expression = element;
          element = this.finishNode(chainNode, "ChainExpression");
        }
        return element;
      }
      base2 = element;
    }
  };
  pp$5.shouldParseAsyncArrow = function() {
    return !this.canInsertSemicolon() && this.eat(types$1.arrow);
  };
  pp$5.parseSubscriptAsyncArrow = function(startPos, startLoc, exprList, forInit) {
    return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit);
  };
  pp$5.parseSubscript = function(base2, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
    var optionalSupported = this.options.ecmaVersion >= 11;
    var optional = optionalSupported && this.eat(types$1.questionDot);
    if (noCalls && optional) {
      this.raise(this.lastTokStart, "Optional chaining cannot appear in the callee of new expressions");
    }
    var computed = this.eat(types$1.bracketL);
    if (computed || optional && this.type !== types$1.parenL && this.type !== types$1.backQuote || this.eat(types$1.dot)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.object = base2;
      if (computed) {
        node.property = this.parseExpression();
        this.expect(types$1.bracketR);
      } else if (this.type === types$1.privateId && base2.type !== "Super") {
        node.property = this.parsePrivateIdent();
      } else {
        node.property = this.parseIdent(this.options.allowReserved !== "never");
      }
      node.computed = !!computed;
      if (optionalSupported) {
        node.optional = optional;
      }
      base2 = this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.eat(types$1.parenL)) {
      var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
      this.yieldPos = 0;
      this.awaitPos = 0;
      this.awaitIdentPos = 0;
      var exprList = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors);
      if (maybeAsyncArrow && !optional && this.shouldParseAsyncArrow()) {
        this.checkPatternErrors(refDestructuringErrors, false);
        this.checkYieldAwaitInDefaultParams();
        if (this.awaitIdentPos > 0) {
          this.raise(this.awaitIdentPos, "Cannot use 'await' as identifier inside an async function");
        }
        this.yieldPos = oldYieldPos;
        this.awaitPos = oldAwaitPos;
        this.awaitIdentPos = oldAwaitIdentPos;
        return this.parseSubscriptAsyncArrow(startPos, startLoc, exprList, forInit);
      }
      this.checkExpressionErrors(refDestructuringErrors, true);
      this.yieldPos = oldYieldPos || this.yieldPos;
      this.awaitPos = oldAwaitPos || this.awaitPos;
      this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos;
      var node$1 = this.startNodeAt(startPos, startLoc);
      node$1.callee = base2;
      node$1.arguments = exprList;
      if (optionalSupported) {
        node$1.optional = optional;
      }
      base2 = this.finishNode(node$1, "CallExpression");
    } else if (this.type === types$1.backQuote) {
      if (optional || optionalChained) {
        this.raise(this.start, "Optional chaining cannot appear in the tag of tagged template expressions");
      }
      var node$2 = this.startNodeAt(startPos, startLoc);
      node$2.tag = base2;
      node$2.quasi = this.parseTemplate({ isTagged: true });
      base2 = this.finishNode(node$2, "TaggedTemplateExpression");
    }
    return base2;
  };
  pp$5.parseExprAtom = function(refDestructuringErrors, forInit, forNew) {
    if (this.type === types$1.slash) {
      this.readRegexp();
    }
    var node, canBeArrow = this.potentialArrowAt === this.start;
    switch (this.type) {
      case types$1._super:
        if (!this.allowSuper) {
          this.raise(this.start, "'super' keyword outside a method");
        }
        node = this.startNode();
        this.next();
        if (this.type === types$1.parenL && !this.allowDirectSuper) {
          this.raise(node.start, "super() call outside constructor of a subclass");
        }
        if (this.type !== types$1.dot && this.type !== types$1.bracketL && this.type !== types$1.parenL) {
          this.unexpected();
        }
        return this.finishNode(node, "Super");
      case types$1._this:
        node = this.startNode();
        this.next();
        return this.finishNode(node, "ThisExpression");
      case types$1.name:
        var startPos = this.start, startLoc = this.startLoc, containsEsc = this.containsEsc;
        var id = this.parseIdent(false);
        if (this.options.ecmaVersion >= 8 && !containsEsc && id.name === "async" && !this.canInsertSemicolon() && this.eat(types$1._function)) {
          this.overrideContext(types.f_expr);
          return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit);
        }
        if (canBeArrow && !this.canInsertSemicolon()) {
          if (this.eat(types$1.arrow)) {
            return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], false, forInit);
          }
          if (this.options.ecmaVersion >= 8 && id.name === "async" && this.type === types$1.name && !containsEsc && (!this.potentialArrowInForAwait || this.value !== "of" || this.containsEsc)) {
            id = this.parseIdent(false);
            if (this.canInsertSemicolon() || !this.eat(types$1.arrow)) {
              this.unexpected();
            }
            return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], true, forInit);
          }
        }
        return id;
      case types$1.regexp:
        var value = this.value;
        node = this.parseLiteral(value.value);
        node.regex = { pattern: value.pattern, flags: value.flags };
        return node;
      case types$1.num:
      case types$1.string:
        return this.parseLiteral(this.value);
      case types$1._null:
      case types$1._true:
      case types$1._false:
        node = this.startNode();
        node.value = this.type === types$1._null ? null : this.type === types$1._true;
        node.raw = this.type.keyword;
        this.next();
        return this.finishNode(node, "Literal");
      case types$1.parenL:
        var start = this.start, expr = this.parseParenAndDistinguishExpression(canBeArrow, forInit);
        if (refDestructuringErrors) {
          if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr)) {
            refDestructuringErrors.parenthesizedAssign = start;
          }
          if (refDestructuringErrors.parenthesizedBind < 0) {
            refDestructuringErrors.parenthesizedBind = start;
          }
        }
        return expr;
      case types$1.bracketL:
        node = this.startNode();
        this.next();
        node.elements = this.parseExprList(types$1.bracketR, true, true, refDestructuringErrors);
        return this.finishNode(node, "ArrayExpression");
      case types$1.braceL:
        this.overrideContext(types.b_expr);
        return this.parseObj(false, refDestructuringErrors);
      case types$1._function:
        node = this.startNode();
        this.next();
        return this.parseFunction(node, 0);
      case types$1._class:
        return this.parseClass(this.startNode(), false);
      case types$1._new:
        return this.parseNew();
      case types$1.backQuote:
        return this.parseTemplate();
      case types$1._import:
        if (this.options.ecmaVersion >= 11) {
          return this.parseExprImport(forNew);
        } else {
          return this.unexpected();
        }
      default:
        return this.parseExprAtomDefault();
    }
  };
  pp$5.parseExprAtomDefault = function() {
    this.unexpected();
  };
  pp$5.parseExprImport = function(forNew) {
    var node = this.startNode();
    if (this.containsEsc) {
      this.raiseRecoverable(this.start, "Escape sequence in keyword import");
    }
    this.next();
    if (this.type === types$1.parenL && !forNew) {
      return this.parseDynamicImport(node);
    } else if (this.type === types$1.dot) {
      var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
      meta.name = "import";
      node.meta = this.finishNode(meta, "Identifier");
      return this.parseImportMeta(node);
    } else {
      this.unexpected();
    }
  };
  pp$5.parseDynamicImport = function(node) {
    this.next();
    node.source = this.parseMaybeAssign();
    if (this.options.ecmaVersion >= 16) {
      if (!this.eat(types$1.parenR)) {
        this.expect(types$1.comma);
        if (!this.afterTrailingComma(types$1.parenR)) {
          node.options = this.parseMaybeAssign();
          if (!this.eat(types$1.parenR)) {
            this.expect(types$1.comma);
            if (!this.afterTrailingComma(types$1.parenR)) {
              this.unexpected();
            }
          }
        } else {
          node.options = null;
        }
      } else {
        node.options = null;
      }
    } else {
      if (!this.eat(types$1.parenR)) {
        var errorPos = this.start;
        if (this.eat(types$1.comma) && this.eat(types$1.parenR)) {
          this.raiseRecoverable(errorPos, "Trailing comma is not allowed in import()");
        } else {
          this.unexpected(errorPos);
        }
      }
    }
    return this.finishNode(node, "ImportExpression");
  };
  pp$5.parseImportMeta = function(node) {
    this.next();
    var containsEsc = this.containsEsc;
    node.property = this.parseIdent(true);
    if (node.property.name !== "meta") {
      this.raiseRecoverable(node.property.start, "The only valid meta property for import is 'import.meta'");
    }
    if (containsEsc) {
      this.raiseRecoverable(node.start, "'import.meta' must not contain escaped characters");
    }
    if (this.options.sourceType !== "module" && !this.options.allowImportExportEverywhere) {
      this.raiseRecoverable(node.start, "Cannot use 'import.meta' outside a module");
    }
    return this.finishNode(node, "MetaProperty");
  };
  pp$5.parseLiteral = function(value) {
    var node = this.startNode();
    node.value = value;
    node.raw = this.input.slice(this.start, this.end);
    if (node.raw.charCodeAt(node.raw.length - 1) === 110) {
      node.bigint = node.value != null ? node.value.toString() : node.raw.slice(0, -1).replace(/_/g, "");
    }
    this.next();
    return this.finishNode(node, "Literal");
  };
  pp$5.parseParenExpression = function() {
    this.expect(types$1.parenL);
    var val = this.parseExpression();
    this.expect(types$1.parenR);
    return val;
  };
  pp$5.shouldParseArrow = function(exprList) {
    return !this.canInsertSemicolon();
  };
  pp$5.parseParenAndDistinguishExpression = function(canBeArrow, forInit) {
    var startPos = this.start, startLoc = this.startLoc, val, allowTrailingComma = this.options.ecmaVersion >= 8;
    if (this.options.ecmaVersion >= 6) {
      this.next();
      var innerStartPos = this.start, innerStartLoc = this.startLoc;
      var exprList = [], first = true, lastIsComma = false;
      var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, spreadStart;
      this.yieldPos = 0;
      this.awaitPos = 0;
      while (this.type !== types$1.parenR) {
        first ? first = false : this.expect(types$1.comma);
        if (allowTrailingComma && this.afterTrailingComma(types$1.parenR, true)) {
          lastIsComma = true;
          break;
        } else if (this.type === types$1.ellipsis) {
          spreadStart = this.start;
          exprList.push(this.parseParenItem(this.parseRestBinding()));
          if (this.type === types$1.comma) {
            this.raiseRecoverable(
              this.start,
              "Comma is not permitted after the rest element"
            );
          }
          break;
        } else {
          exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
        }
      }
      var innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc;
      this.expect(types$1.parenR);
      if (canBeArrow && this.shouldParseArrow(exprList) && this.eat(types$1.arrow)) {
        this.checkPatternErrors(refDestructuringErrors, false);
        this.checkYieldAwaitInDefaultParams();
        this.yieldPos = oldYieldPos;
        this.awaitPos = oldAwaitPos;
        return this.parseParenArrowList(startPos, startLoc, exprList, forInit);
      }
      if (!exprList.length || lastIsComma) {
        this.unexpected(this.lastTokStart);
      }
      if (spreadStart) {
        this.unexpected(spreadStart);
      }
      this.checkExpressionErrors(refDestructuringErrors, true);
      this.yieldPos = oldYieldPos || this.yieldPos;
      this.awaitPos = oldAwaitPos || this.awaitPos;
      if (exprList.length > 1) {
        val = this.startNodeAt(innerStartPos, innerStartLoc);
        val.expressions = exprList;
        this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
      } else {
        val = exprList[0];
      }
    } else {
      val = this.parseParenExpression();
    }
    if (this.options.preserveParens) {
      var par = this.startNodeAt(startPos, startLoc);
      par.expression = val;
      return this.finishNode(par, "ParenthesizedExpression");
    } else {
      return val;
    }
  };
  pp$5.parseParenItem = function(item) {
    return item;
  };
  pp$5.parseParenArrowList = function(startPos, startLoc, exprList, forInit) {
    return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, false, forInit);
  };
  var empty = [];
  pp$5.parseNew = function() {
    if (this.containsEsc) {
      this.raiseRecoverable(this.start, "Escape sequence in keyword new");
    }
    var node = this.startNode();
    this.next();
    if (this.options.ecmaVersion >= 6 && this.type === types$1.dot) {
      var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
      meta.name = "new";
      node.meta = this.finishNode(meta, "Identifier");
      this.next();
      var containsEsc = this.containsEsc;
      node.property = this.parseIdent(true);
      if (node.property.name !== "target") {
        this.raiseRecoverable(node.property.start, "The only valid meta property for new is 'new.target'");
      }
      if (containsEsc) {
        this.raiseRecoverable(node.start, "'new.target' must not contain escaped characters");
      }
      if (!this.allowNewDotTarget) {
        this.raiseRecoverable(node.start, "'new.target' can only be used in functions and class static block");
      }
      return this.finishNode(node, "MetaProperty");
    }
    var startPos = this.start, startLoc = this.startLoc;
    node.callee = this.parseSubscripts(this.parseExprAtom(null, false, true), startPos, startLoc, true, false);
    if (this.eat(types$1.parenL)) {
      node.arguments = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false);
    } else {
      node.arguments = empty;
    }
    return this.finishNode(node, "NewExpression");
  };
  pp$5.parseTemplateElement = function(ref2) {
    var isTagged = ref2.isTagged;
    var elem = this.startNode();
    if (this.type === types$1.invalidTemplate) {
      if (!isTagged) {
        this.raiseRecoverable(this.start, "Bad escape sequence in untagged template literal");
      }
      elem.value = {
        raw: this.value.replace(/\r\n?/g, "\n"),
        cooked: null
      };
    } else {
      elem.value = {
        raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
        cooked: this.value
      };
    }
    this.next();
    elem.tail = this.type === types$1.backQuote;
    return this.finishNode(elem, "TemplateElement");
  };
  pp$5.parseTemplate = function(ref2) {
    if (ref2 === void 0) ref2 = {};
    var isTagged = ref2.isTagged;
    if (isTagged === void 0) isTagged = false;
    var node = this.startNode();
    this.next();
    node.expressions = [];
    var curElt = this.parseTemplateElement({ isTagged });
    node.quasis = [curElt];
    while (!curElt.tail) {
      if (this.type === types$1.eof) {
        this.raise(this.pos, "Unterminated template literal");
      }
      this.expect(types$1.dollarBraceL);
      node.expressions.push(this.parseExpression());
      this.expect(types$1.braceR);
      node.quasis.push(curElt = this.parseTemplateElement({ isTagged }));
    }
    this.next();
    return this.finishNode(node, "TemplateLiteral");
  };
  pp$5.isAsyncProp = function(prop) {
    return !prop.computed && prop.key.type === "Identifier" && prop.key.name === "async" && (this.type === types$1.name || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword || this.options.ecmaVersion >= 9 && this.type === types$1.star) && !lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  };
  pp$5.parseObj = function(isPattern, refDestructuringErrors) {
    var node = this.startNode(), first = true, propHash = {};
    node.properties = [];
    this.next();
    while (!this.eat(types$1.braceR)) {
      if (!first) {
        this.expect(types$1.comma);
        if (this.options.ecmaVersion >= 5 && this.afterTrailingComma(types$1.braceR)) {
          break;
        }
      } else {
        first = false;
      }
      var prop = this.parseProperty(isPattern, refDestructuringErrors);
      if (!isPattern) {
        this.checkPropClash(prop, propHash, refDestructuringErrors);
      }
      node.properties.push(prop);
    }
    return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
  };
  pp$5.parseProperty = function(isPattern, refDestructuringErrors) {
    var prop = this.startNode(), isGenerator, isAsync, startPos, startLoc;
    if (this.options.ecmaVersion >= 9 && this.eat(types$1.ellipsis)) {
      if (isPattern) {
        prop.argument = this.parseIdent(false);
        if (this.type === types$1.comma) {
          this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
        }
        return this.finishNode(prop, "RestElement");
      }
      prop.argument = this.parseMaybeAssign(false, refDestructuringErrors);
      if (this.type === types$1.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
        refDestructuringErrors.trailingComma = this.start;
      }
      return this.finishNode(prop, "SpreadElement");
    }
    if (this.options.ecmaVersion >= 6) {
      prop.method = false;
      prop.shorthand = false;
      if (isPattern || refDestructuringErrors) {
        startPos = this.start;
        startLoc = this.startLoc;
      }
      if (!isPattern) {
        isGenerator = this.eat(types$1.star);
      }
    }
    var containsEsc = this.containsEsc;
    this.parsePropertyName(prop);
    if (!isPattern && !containsEsc && this.options.ecmaVersion >= 8 && !isGenerator && this.isAsyncProp(prop)) {
      isAsync = true;
      isGenerator = this.options.ecmaVersion >= 9 && this.eat(types$1.star);
      this.parsePropertyName(prop);
    } else {
      isAsync = false;
    }
    this.parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc);
    return this.finishNode(prop, "Property");
  };
  pp$5.parseGetterSetter = function(prop) {
    var kind = prop.key.name;
    this.parsePropertyName(prop);
    prop.value = this.parseMethod(false);
    prop.kind = kind;
    var paramCount = prop.kind === "get" ? 0 : 1;
    if (prop.value.params.length !== paramCount) {
      var start = prop.value.start;
      if (prop.kind === "get") {
        this.raiseRecoverable(start, "getter should have no params");
      } else {
        this.raiseRecoverable(start, "setter should have exactly one param");
      }
    } else {
      if (prop.kind === "set" && prop.value.params[0].type === "RestElement") {
        this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
      }
    }
  };
  pp$5.parsePropertyValue = function(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
    if ((isGenerator || isAsync) && this.type === types$1.colon) {
      this.unexpected();
    }
    if (this.eat(types$1.colon)) {
      prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
      prop.kind = "init";
    } else if (this.options.ecmaVersion >= 6 && this.type === types$1.parenL) {
      if (isPattern) {
        this.unexpected();
      }
      prop.method = true;
      prop.value = this.parseMethod(isGenerator, isAsync);
      prop.kind = "init";
    } else if (!isPattern && !containsEsc && this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type !== types$1.comma && this.type !== types$1.braceR && this.type !== types$1.eq)) {
      if (isGenerator || isAsync) {
        this.unexpected();
      }
      this.parseGetterSetter(prop);
    } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
      if (isGenerator || isAsync) {
        this.unexpected();
      }
      this.checkUnreserved(prop.key);
      if (prop.key.name === "await" && !this.awaitIdentPos) {
        this.awaitIdentPos = startPos;
      }
      if (isPattern) {
        prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
      } else if (this.type === types$1.eq && refDestructuringErrors) {
        if (refDestructuringErrors.shorthandAssign < 0) {
          refDestructuringErrors.shorthandAssign = this.start;
        }
        prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
      } else {
        prop.value = this.copyNode(prop.key);
      }
      prop.kind = "init";
      prop.shorthand = true;
    } else {
      this.unexpected();
    }
  };
  pp$5.parsePropertyName = function(prop) {
    if (this.options.ecmaVersion >= 6) {
      if (this.eat(types$1.bracketL)) {
        prop.computed = true;
        prop.key = this.parseMaybeAssign();
        this.expect(types$1.bracketR);
        return prop.key;
      } else {
        prop.computed = false;
      }
    }
    return prop.key = this.type === types$1.num || this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
  };
  pp$5.initFunction = function(node) {
    node.id = null;
    if (this.options.ecmaVersion >= 6) {
      node.generator = node.expression = false;
    }
    if (this.options.ecmaVersion >= 8) {
      node.async = false;
    }
  };
  pp$5.parseMethod = function(isGenerator, isAsync, allowDirectSuper) {
    var node = this.startNode(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.initFunction(node);
    if (this.options.ecmaVersion >= 6) {
      node.generator = isGenerator;
    }
    if (this.options.ecmaVersion >= 8) {
      node.async = !!isAsync;
    }
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    this.enterScope(functionFlags(isAsync, node.generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0));
    this.expect(types$1.parenL);
    node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
    this.checkYieldAwaitInDefaultParams();
    this.parseFunctionBody(node, false, true, false);
    this.yieldPos = oldYieldPos;
    this.awaitPos = oldAwaitPos;
    this.awaitIdentPos = oldAwaitIdentPos;
    return this.finishNode(node, "FunctionExpression");
  };
  pp$5.parseArrowExpression = function(node, params, isAsync, forInit) {
    var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.enterScope(functionFlags(isAsync, false) | SCOPE_ARROW);
    this.initFunction(node);
    if (this.options.ecmaVersion >= 8) {
      node.async = !!isAsync;
    }
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    node.params = this.toAssignableList(params, true);
    this.parseFunctionBody(node, true, false, forInit);
    this.yieldPos = oldYieldPos;
    this.awaitPos = oldAwaitPos;
    this.awaitIdentPos = oldAwaitIdentPos;
    return this.finishNode(node, "ArrowFunctionExpression");
  };
  pp$5.parseFunctionBody = function(node, isArrowFunction, isMethod, forInit) {
    var isExpression = isArrowFunction && this.type !== types$1.braceL;
    var oldStrict = this.strict, useStrict = false;
    if (isExpression) {
      node.body = this.parseMaybeAssign(forInit);
      node.expression = true;
      this.checkParams(node, false);
    } else {
      var nonSimple = this.options.ecmaVersion >= 7 && !this.isSimpleParamList(node.params);
      if (!oldStrict || nonSimple) {
        useStrict = this.strictDirective(this.end);
        if (useStrict && nonSimple) {
          this.raiseRecoverable(node.start, "Illegal 'use strict' directive in function with non-simple parameter list");
        }
      }
      var oldLabels = this.labels;
      this.labels = [];
      if (useStrict) {
        this.strict = true;
      }
      this.checkParams(node, !oldStrict && !useStrict && !isArrowFunction && !isMethod && this.isSimpleParamList(node.params));
      if (this.strict && node.id) {
        this.checkLValSimple(node.id, BIND_OUTSIDE);
      }
      node.body = this.parseBlock(false, void 0, useStrict && !oldStrict);
      node.expression = false;
      this.adaptDirectivePrologue(node.body.body);
      this.labels = oldLabels;
    }
    this.exitScope();
  };
  pp$5.isSimpleParamList = function(params) {
    for (var i2 = 0, list = params; i2 < list.length; i2 += 1) {
      var param = list[i2];
      if (param.type !== "Identifier") {
        return false;
      }
    }
    return true;
  };
  pp$5.checkParams = function(node, allowDuplicates) {
    var nameHash =   Object.create(null);
    for (var i2 = 0, list = node.params; i2 < list.length; i2 += 1) {
      var param = list[i2];
      this.checkLValInnerPattern(param, BIND_VAR, allowDuplicates ? null : nameHash);
    }
  };
  pp$5.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
    var elts = [], first = true;
    while (!this.eat(close)) {
      if (!first) {
        this.expect(types$1.comma);
        if (allowTrailingComma && this.afterTrailingComma(close)) {
          break;
        }
      } else {
        first = false;
      }
      var elt = void 0;
      if (allowEmpty && this.type === types$1.comma) {
        elt = null;
      } else if (this.type === types$1.ellipsis) {
        elt = this.parseSpread(refDestructuringErrors);
        if (refDestructuringErrors && this.type === types$1.comma && refDestructuringErrors.trailingComma < 0) {
          refDestructuringErrors.trailingComma = this.start;
        }
      } else {
        elt = this.parseMaybeAssign(false, refDestructuringErrors);
      }
      elts.push(elt);
    }
    return elts;
  };
  pp$5.checkUnreserved = function(ref2) {
    var start = ref2.start;
    var end = ref2.end;
    var name = ref2.name;
    if (this.inGenerator && name === "yield") {
      this.raiseRecoverable(start, "Cannot use 'yield' as identifier inside a generator");
    }
    if (this.inAsync && name === "await") {
      this.raiseRecoverable(start, "Cannot use 'await' as identifier inside an async function");
    }
    if (!(this.currentThisScope().flags & SCOPE_VAR) && name === "arguments") {
      this.raiseRecoverable(start, "Cannot use 'arguments' in class field initializer");
    }
    if (this.inClassStaticBlock && (name === "arguments" || name === "await")) {
      this.raise(start, "Cannot use " + name + " in class static initialization block");
    }
    if (this.keywords.test(name)) {
      this.raise(start, "Unexpected keyword '" + name + "'");
    }
    if (this.options.ecmaVersion < 6 && this.input.slice(start, end).indexOf("\\") !== -1) {
      return;
    }
    var re = this.strict ? this.reservedWordsStrict : this.reservedWords;
    if (re.test(name)) {
      if (!this.inAsync && name === "await") {
        this.raiseRecoverable(start, "Cannot use keyword 'await' outside an async function");
      }
      this.raiseRecoverable(start, "The keyword '" + name + "' is reserved");
    }
  };
  pp$5.parseIdent = function(liberal) {
    var node = this.parseIdentNode();
    this.next(!!liberal);
    this.finishNode(node, "Identifier");
    if (!liberal) {
      this.checkUnreserved(node);
      if (node.name === "await" && !this.awaitIdentPos) {
        this.awaitIdentPos = node.start;
      }
    }
    return node;
  };
  pp$5.parseIdentNode = function() {
    var node = this.startNode();
    if (this.type === types$1.name) {
      node.name = this.value;
    } else if (this.type.keyword) {
      node.name = this.type.keyword;
      if ((node.name === "class" || node.name === "function") && (this.lastTokEnd !== this.lastTokStart + 1 || this.input.charCodeAt(this.lastTokStart) !== 46)) {
        this.context.pop();
      }
      this.type = types$1.name;
    } else {
      this.unexpected();
    }
    return node;
  };
  pp$5.parsePrivateIdent = function() {
    var node = this.startNode();
    if (this.type === types$1.privateId) {
      node.name = this.value;
    } else {
      this.unexpected();
    }
    this.next();
    this.finishNode(node, "PrivateIdentifier");
    if (this.options.checkPrivateFields) {
      if (this.privateNameStack.length === 0) {
        this.raise(node.start, "Private field '#" + node.name + "' must be declared in an enclosing class");
      } else {
        this.privateNameStack[this.privateNameStack.length - 1].used.push(node);
      }
    }
    return node;
  };
  pp$5.parseYield = function(forInit) {
    if (!this.yieldPos) {
      this.yieldPos = this.start;
    }
    var node = this.startNode();
    this.next();
    if (this.type === types$1.semi || this.canInsertSemicolon() || this.type !== types$1.star && !this.type.startsExpr) {
      node.delegate = false;
      node.argument = null;
    } else {
      node.delegate = this.eat(types$1.star);
      node.argument = this.parseMaybeAssign(forInit);
    }
    return this.finishNode(node, "YieldExpression");
  };
  pp$5.parseAwait = function(forInit) {
    if (!this.awaitPos) {
      this.awaitPos = this.start;
    }
    var node = this.startNode();
    this.next();
    node.argument = this.parseMaybeUnary(null, true, false, forInit);
    return this.finishNode(node, "AwaitExpression");
  };
  var pp$4 = Parser.prototype;
  pp$4.raise = function(pos, message) {
    var loc = getLineInfo(this.input, pos);
    message += " (" + loc.line + ":" + loc.column + ")";
    if (this.sourceFile) {
      message += " in " + this.sourceFile;
    }
    var err = new SyntaxError(message);
    err.pos = pos;
    err.loc = loc;
    err.raisedAt = this.pos;
    throw err;
  };
  pp$4.raiseRecoverable = pp$4.raise;
  pp$4.curPosition = function() {
    if (this.options.locations) {
      return new Position(this.curLine, this.pos - this.lineStart);
    }
  };
  var pp$3 = Parser.prototype;
  var Scope = function Scope2(flags) {
    this.flags = flags;
    this.var = [];
    this.lexical = [];
    this.functions = [];
  };
  pp$3.enterScope = function(flags) {
    this.scopeStack.push(new Scope(flags));
  };
  pp$3.exitScope = function() {
    this.scopeStack.pop();
  };
  pp$3.treatFunctionsAsVarInScope = function(scope) {
    return scope.flags & SCOPE_FUNCTION || !this.inModule && scope.flags & SCOPE_TOP;
  };
  pp$3.declareName = function(name, bindingType, pos) {
    var redeclared = false;
    if (bindingType === BIND_LEXICAL) {
      var scope = this.currentScope();
      redeclared = scope.lexical.indexOf(name) > -1 || scope.functions.indexOf(name) > -1 || scope.var.indexOf(name) > -1;
      scope.lexical.push(name);
      if (this.inModule && scope.flags & SCOPE_TOP) {
        delete this.undefinedExports[name];
      }
    } else if (bindingType === BIND_SIMPLE_CATCH) {
      var scope$1 = this.currentScope();
      scope$1.lexical.push(name);
    } else if (bindingType === BIND_FUNCTION) {
      var scope$2 = this.currentScope();
      if (this.treatFunctionsAsVar) {
        redeclared = scope$2.lexical.indexOf(name) > -1;
      } else {
        redeclared = scope$2.lexical.indexOf(name) > -1 || scope$2.var.indexOf(name) > -1;
      }
      scope$2.functions.push(name);
    } else {
      for (var i2 = this.scopeStack.length - 1; i2 >= 0; --i2) {
        var scope$3 = this.scopeStack[i2];
        if (scope$3.lexical.indexOf(name) > -1 && !(scope$3.flags & SCOPE_SIMPLE_CATCH && scope$3.lexical[0] === name) || !this.treatFunctionsAsVarInScope(scope$3) && scope$3.functions.indexOf(name) > -1) {
          redeclared = true;
          break;
        }
        scope$3.var.push(name);
        if (this.inModule && scope$3.flags & SCOPE_TOP) {
          delete this.undefinedExports[name];
        }
        if (scope$3.flags & SCOPE_VAR) {
          break;
        }
      }
    }
    if (redeclared) {
      this.raiseRecoverable(pos, "Identifier '" + name + "' has already been declared");
    }
  };
  pp$3.checkLocalExport = function(id) {
    if (this.scopeStack[0].lexical.indexOf(id.name) === -1 && this.scopeStack[0].var.indexOf(id.name) === -1) {
      this.undefinedExports[id.name] = id;
    }
  };
  pp$3.currentScope = function() {
    return this.scopeStack[this.scopeStack.length - 1];
  };
  pp$3.currentVarScope = function() {
    for (var i2 = this.scopeStack.length - 1; ; i2--) {
      var scope = this.scopeStack[i2];
      if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) {
        return scope;
      }
    }
  };
  pp$3.currentThisScope = function() {
    for (var i2 = this.scopeStack.length - 1; ; i2--) {
      var scope = this.scopeStack[i2];
      if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) && !(scope.flags & SCOPE_ARROW)) {
        return scope;
      }
    }
  };
  var Node = function Node2(parser, pos, loc) {
    this.type = "";
    this.start = pos;
    this.end = 0;
    if (parser.options.locations) {
      this.loc = new SourceLocation(parser, loc);
    }
    if (parser.options.directSourceFile) {
      this.sourceFile = parser.options.directSourceFile;
    }
    if (parser.options.ranges) {
      this.range = [pos, 0];
    }
  };
  var pp$2 = Parser.prototype;
  pp$2.startNode = function() {
    return new Node(this, this.start, this.startLoc);
  };
  pp$2.startNodeAt = function(pos, loc) {
    return new Node(this, pos, loc);
  };
  function finishNodeAt(node, type, pos, loc) {
    node.type = type;
    node.end = pos;
    if (this.options.locations) {
      node.loc.end = loc;
    }
    if (this.options.ranges) {
      node.range[1] = pos;
    }
    return node;
  }
  pp$2.finishNode = function(node, type) {
    return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
  };
  pp$2.finishNodeAt = function(node, type, pos, loc) {
    return finishNodeAt.call(this, node, type, pos, loc);
  };
  pp$2.copyNode = function(node) {
    var newNode = new Node(this, node.start, this.startLoc);
    for (var prop in node) {
      newNode[prop] = node[prop];
    }
    return newNode;
  };
  var scriptValuesAddedInUnicode = "Berf Beria_Erfe Gara Garay Gukh Gurung_Khema Hrkt Katakana_Or_Hiragana Kawi Kirat_Rai Krai Nag_Mundari Nagm Ol_Onal Onao Sidetic Sidt Sunu Sunuwar Tai_Yo Tayo Todhri Todr Tolong_Siki Tols Tulu_Tigalari Tutg Unknown Zzzz";
  var ecma9BinaryProperties = "ASCII ASCII_Hex_Digit AHex Alphabetic Alpha Any Assigned Bidi_Control Bidi_C Bidi_Mirrored Bidi_M Case_Ignorable CI Cased Changes_When_Casefolded CWCF Changes_When_Casemapped CWCM Changes_When_Lowercased CWL Changes_When_NFKC_Casefolded CWKCF Changes_When_Titlecased CWT Changes_When_Uppercased CWU Dash Default_Ignorable_Code_Point DI Deprecated Dep Diacritic Dia Emoji Emoji_Component Emoji_Modifier Emoji_Modifier_Base Emoji_Presentation Extender Ext Grapheme_Base Gr_Base Grapheme_Extend Gr_Ext Hex_Digit Hex IDS_Binary_Operator IDSB IDS_Trinary_Operator IDST ID_Continue IDC ID_Start IDS Ideographic Ideo Join_Control Join_C Logical_Order_Exception LOE Lowercase Lower Math Noncharacter_Code_Point NChar Pattern_Syntax Pat_Syn Pattern_White_Space Pat_WS Quotation_Mark QMark Radical Regional_Indicator RI Sentence_Terminal STerm Soft_Dotted SD Terminal_Punctuation Term Unified_Ideograph UIdeo Uppercase Upper Variation_Selector VS White_Space space XID_Continue XIDC XID_Start XIDS";
  var ecma10BinaryProperties = ecma9BinaryProperties + " Extended_Pictographic";
  var ecma11BinaryProperties = ecma10BinaryProperties;
  var ecma12BinaryProperties = ecma11BinaryProperties + " EBase EComp EMod EPres ExtPict";
  var ecma13BinaryProperties = ecma12BinaryProperties;
  var ecma14BinaryProperties = ecma13BinaryProperties;
  var unicodeBinaryProperties = {
    9: ecma9BinaryProperties,
    10: ecma10BinaryProperties,
    11: ecma11BinaryProperties,
    12: ecma12BinaryProperties,
    13: ecma13BinaryProperties,
    14: ecma14BinaryProperties
  };
  var ecma14BinaryPropertiesOfStrings = "Basic_Emoji Emoji_Keycap_Sequence RGI_Emoji_Modifier_Sequence RGI_Emoji_Flag_Sequence RGI_Emoji_Tag_Sequence RGI_Emoji_ZWJ_Sequence RGI_Emoji";
  var unicodeBinaryPropertiesOfStrings = {
    9: "",
    10: "",
    11: "",
    12: "",
    13: "",
    14: ecma14BinaryPropertiesOfStrings
  };
  var unicodeGeneralCategoryValues = "Cased_Letter LC Close_Punctuation Pe Connector_Punctuation Pc Control Cc cntrl Currency_Symbol Sc Dash_Punctuation Pd Decimal_Number Nd digit Enclosing_Mark Me Final_Punctuation Pf Format Cf Initial_Punctuation Pi Letter L Letter_Number Nl Line_Separator Zl Lowercase_Letter Ll Mark M Combining_Mark Math_Symbol Sm Modifier_Letter Lm Modifier_Symbol Sk Nonspacing_Mark Mn Number N Open_Punctuation Ps Other C Other_Letter Lo Other_Number No Other_Punctuation Po Other_Symbol So Paragraph_Separator Zp Private_Use Co Punctuation P punct Separator Z Space_Separator Zs Spacing_Mark Mc Surrogate Cs Symbol S Titlecase_Letter Lt Unassigned Cn Uppercase_Letter Lu";
  var ecma9ScriptValues = "Adlam Adlm Ahom Anatolian_Hieroglyphs Hluw Arabic Arab Armenian Armn Avestan Avst Balinese Bali Bamum Bamu Bassa_Vah Bass Batak Batk Bengali Beng Bhaiksuki Bhks Bopomofo Bopo Brahmi Brah Braille Brai Buginese Bugi Buhid Buhd Canadian_Aboriginal Cans Carian Cari Caucasian_Albanian Aghb Chakma Cakm Cham Cham Cherokee Cher Common Zyyy Coptic Copt Qaac Cuneiform Xsux Cypriot Cprt Cyrillic Cyrl Deseret Dsrt Devanagari Deva Duployan Dupl Egyptian_Hieroglyphs Egyp Elbasan Elba Ethiopic Ethi Georgian Geor Glagolitic Glag Gothic Goth Grantha Gran Greek Grek Gujarati Gujr Gurmukhi Guru Han Hani Hangul Hang Hanunoo Hano Hatran Hatr Hebrew Hebr Hiragana Hira Imperial_Aramaic Armi Inherited Zinh Qaai Inscriptional_Pahlavi Phli Inscriptional_Parthian Prti Javanese Java Kaithi Kthi Kannada Knda Katakana Kana Kayah_Li Kali Kharoshthi Khar Khmer Khmr Khojki Khoj Khudawadi Sind Lao Laoo Latin Latn Lepcha Lepc Limbu Limb Linear_A Lina Linear_B Linb Lisu Lisu Lycian Lyci Lydian Lydi Mahajani Mahj Malayalam Mlym Mandaic Mand Manichaean Mani Marchen Marc Masaram_Gondi Gonm Meetei_Mayek Mtei Mende_Kikakui Mend Meroitic_Cursive Merc Meroitic_Hieroglyphs Mero Miao Plrd Modi Mongolian Mong Mro Mroo Multani Mult Myanmar Mymr Nabataean Nbat New_Tai_Lue Talu Newa Newa Nko Nkoo Nushu Nshu Ogham Ogam Ol_Chiki Olck Old_Hungarian Hung Old_Italic Ital Old_North_Arabian Narb Old_Permic Perm Old_Persian Xpeo Old_South_Arabian Sarb Old_Turkic Orkh Oriya Orya Osage Osge Osmanya Osma Pahawh_Hmong Hmng Palmyrene Palm Pau_Cin_Hau Pauc Phags_Pa Phag Phoenician Phnx Psalter_Pahlavi Phlp Rejang Rjng Runic Runr Samaritan Samr Saurashtra Saur Sharada Shrd Shavian Shaw Siddham Sidd SignWriting Sgnw Sinhala Sinh Sora_Sompeng Sora Soyombo Soyo Sundanese Sund Syloti_Nagri Sylo Syriac Syrc Tagalog Tglg Tagbanwa Tagb Tai_Le Tale Tai_Tham Lana Tai_Viet Tavt Takri Takr Tamil Taml Tangut Tang Telugu Telu Thaana Thaa Thai Thai Tibetan Tibt Tifinagh Tfng Tirhuta Tirh Ugaritic Ugar Vai Vaii Warang_Citi Wara Yi Yiii Zanabazar_Square Zanb";
  var ecma10ScriptValues = ecma9ScriptValues + " Dogra Dogr Gunjala_Gondi Gong Hanifi_Rohingya Rohg Makasar Maka Medefaidrin Medf Old_Sogdian Sogo Sogdian Sogd";
  var ecma11ScriptValues = ecma10ScriptValues + " Elymaic Elym Nandinagari Nand Nyiakeng_Puachue_Hmong Hmnp Wancho Wcho";
  var ecma12ScriptValues = ecma11ScriptValues + " Chorasmian Chrs Diak Dives_Akuru Khitan_Small_Script Kits Yezi Yezidi";
  var ecma13ScriptValues = ecma12ScriptValues + " Cypro_Minoan Cpmn Old_Uyghur Ougr Tangsa Tnsa Toto Vithkuqi Vith";
  var ecma14ScriptValues = ecma13ScriptValues + " " + scriptValuesAddedInUnicode;
  var unicodeScriptValues = {
    9: ecma9ScriptValues,
    10: ecma10ScriptValues,
    11: ecma11ScriptValues,
    12: ecma12ScriptValues,
    13: ecma13ScriptValues,
    14: ecma14ScriptValues
  };
  var data = {};
  function buildUnicodeData(ecmaVersion) {
    var d = data[ecmaVersion] = {
      binary: wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
      binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
      nonBinary: {
        General_Category: wordsRegexp(unicodeGeneralCategoryValues),
        Script: wordsRegexp(unicodeScriptValues[ecmaVersion])
      }
    };
    d.nonBinary.Script_Extensions = d.nonBinary.Script;
    d.nonBinary.gc = d.nonBinary.General_Category;
    d.nonBinary.sc = d.nonBinary.Script;
    d.nonBinary.scx = d.nonBinary.Script_Extensions;
  }
  for (i2 = 0, list = [9, 10, 11, 12, 13, 14]; i2 < list.length; i2 += 1) {
    ecmaVersion = list[i2];
    buildUnicodeData(ecmaVersion);
  }
  var ecmaVersion;
  var i2;
  var list;
  var pp$1 = Parser.prototype;
  var BranchID = function BranchID2(parent, base2) {
    this.parent = parent;
    this.base = base2 || this;
  };
  BranchID.prototype.separatedFrom = function separatedFrom(alt) {
    for (var self2 = this; self2; self2 = self2.parent) {
      for (var other = alt; other; other = other.parent) {
        if (self2.base === other.base && self2 !== other) {
          return true;
        }
      }
    }
    return false;
  };
  BranchID.prototype.sibling = function sibling() {
    return new BranchID(this.parent, this.base);
  };
  var RegExpValidationState = function RegExpValidationState2(parser) {
    this.parser = parser;
    this.validFlags = "gim" + (parser.options.ecmaVersion >= 6 ? "uy" : "") + (parser.options.ecmaVersion >= 9 ? "s" : "") + (parser.options.ecmaVersion >= 13 ? "d" : "") + (parser.options.ecmaVersion >= 15 ? "v" : "");
    this.unicodeProperties = data[parser.options.ecmaVersion >= 14 ? 14 : parser.options.ecmaVersion];
    this.source = "";
    this.flags = "";
    this.start = 0;
    this.switchU = false;
    this.switchV = false;
    this.switchN = false;
    this.pos = 0;
    this.lastIntValue = 0;
    this.lastStringValue = "";
    this.lastAssertionIsQuantifiable = false;
    this.numCapturingParens = 0;
    this.maxBackReference = 0;
    this.groupNames =   Object.create(null);
    this.backReferenceNames = [];
    this.branchID = null;
  };
  RegExpValidationState.prototype.reset = function reset(start, pattern, flags) {
    var unicodeSets = flags.indexOf("v") !== -1;
    var unicode = flags.indexOf("u") !== -1;
    this.start = start | 0;
    this.source = pattern + "";
    this.flags = flags;
    if (unicodeSets && this.parser.options.ecmaVersion >= 15) {
      this.switchU = true;
      this.switchV = true;
      this.switchN = true;
    } else {
      this.switchU = unicode && this.parser.options.ecmaVersion >= 6;
      this.switchV = false;
      this.switchN = unicode && this.parser.options.ecmaVersion >= 9;
    }
  };
  RegExpValidationState.prototype.raise = function raise(message) {
    this.parser.raiseRecoverable(this.start, "Invalid regular expression: /" + this.source + "/: " + message);
  };
  RegExpValidationState.prototype.at = function at(i2, forceU) {
    if (forceU === void 0) forceU = false;
    var s2 = this.source;
    var l2 = s2.length;
    if (i2 >= l2) {
      return -1;
    }
    var c2 = s2.charCodeAt(i2);
    if (!(forceU || this.switchU) || c2 <= 55295 || c2 >= 57344 || i2 + 1 >= l2) {
      return c2;
    }
    var next = s2.charCodeAt(i2 + 1);
    return next >= 56320 && next <= 57343 ? (c2 << 10) + next - 56613888 : c2;
  };
  RegExpValidationState.prototype.nextIndex = function nextIndex(i2, forceU) {
    if (forceU === void 0) forceU = false;
    var s2 = this.source;
    var l2 = s2.length;
    if (i2 >= l2) {
      return l2;
    }
    var c2 = s2.charCodeAt(i2), next;
    if (!(forceU || this.switchU) || c2 <= 55295 || c2 >= 57344 || i2 + 1 >= l2 || (next = s2.charCodeAt(i2 + 1)) < 56320 || next > 57343) {
      return i2 + 1;
    }
    return i2 + 2;
  };
  RegExpValidationState.prototype.current = function current(forceU) {
    if (forceU === void 0) forceU = false;
    return this.at(this.pos, forceU);
  };
  RegExpValidationState.prototype.lookahead = function lookahead(forceU) {
    if (forceU === void 0) forceU = false;
    return this.at(this.nextIndex(this.pos, forceU), forceU);
  };
  RegExpValidationState.prototype.advance = function advance(forceU) {
    if (forceU === void 0) forceU = false;
    this.pos = this.nextIndex(this.pos, forceU);
  };
  RegExpValidationState.prototype.eat = function eat(ch, forceU) {
    if (forceU === void 0) forceU = false;
    if (this.current(forceU) === ch) {
      this.advance(forceU);
      return true;
    }
    return false;
  };
  RegExpValidationState.prototype.eatChars = function eatChars(chs, forceU) {
    if (forceU === void 0) forceU = false;
    var pos = this.pos;
    for (var i2 = 0, list = chs; i2 < list.length; i2 += 1) {
      var ch = list[i2];
      var current2 = this.at(pos, forceU);
      if (current2 === -1 || current2 !== ch) {
        return false;
      }
      pos = this.nextIndex(pos, forceU);
    }
    this.pos = pos;
    return true;
  };
  pp$1.validateRegExpFlags = function(state) {
    var validFlags = state.validFlags;
    var flags = state.flags;
    var u2 = false;
    var v = false;
    for (var i2 = 0; i2 < flags.length; i2++) {
      var flag = flags.charAt(i2);
      if (validFlags.indexOf(flag) === -1) {
        this.raise(state.start, "Invalid regular expression flag");
      }
      if (flags.indexOf(flag, i2 + 1) > -1) {
        this.raise(state.start, "Duplicate regular expression flag");
      }
      if (flag === "u") {
        u2 = true;
      }
      if (flag === "v") {
        v = true;
      }
    }
    if (this.options.ecmaVersion >= 15 && u2 && v) {
      this.raise(state.start, "Invalid regular expression flag");
    }
  };
  function hasProp(obj) {
    for (var _ in obj) {
      return true;
    }
    return false;
  }
  pp$1.validateRegExpPattern = function(state) {
    this.regexp_pattern(state);
    if (!state.switchN && this.options.ecmaVersion >= 9 && hasProp(state.groupNames)) {
      state.switchN = true;
      this.regexp_pattern(state);
    }
  };
  pp$1.regexp_pattern = function(state) {
    state.pos = 0;
    state.lastIntValue = 0;
    state.lastStringValue = "";
    state.lastAssertionIsQuantifiable = false;
    state.numCapturingParens = 0;
    state.maxBackReference = 0;
    state.groupNames =   Object.create(null);
    state.backReferenceNames.length = 0;
    state.branchID = null;
    this.regexp_disjunction(state);
    if (state.pos !== state.source.length) {
      if (state.eat(
        41
      )) {
        state.raise("Unmatched ')'");
      }
      if (state.eat(
        93
      ) || state.eat(
        125
      )) {
        state.raise("Lone quantifier brackets");
      }
    }
    if (state.maxBackReference > state.numCapturingParens) {
      state.raise("Invalid escape");
    }
    for (var i2 = 0, list = state.backReferenceNames; i2 < list.length; i2 += 1) {
      var name = list[i2];
      if (!state.groupNames[name]) {
        state.raise("Invalid named capture referenced");
      }
    }
  };
  pp$1.regexp_disjunction = function(state) {
    var trackDisjunction = this.options.ecmaVersion >= 16;
    if (trackDisjunction) {
      state.branchID = new BranchID(state.branchID, null);
    }
    this.regexp_alternative(state);
    while (state.eat(
      124
    )) {
      if (trackDisjunction) {
        state.branchID = state.branchID.sibling();
      }
      this.regexp_alternative(state);
    }
    if (trackDisjunction) {
      state.branchID = state.branchID.parent;
    }
    if (this.regexp_eatQuantifier(state, true)) {
      state.raise("Nothing to repeat");
    }
    if (state.eat(
      123
    )) {
      state.raise("Lone quantifier brackets");
    }
  };
  pp$1.regexp_alternative = function(state) {
    while (state.pos < state.source.length && this.regexp_eatTerm(state)) {
    }
  };
  pp$1.regexp_eatTerm = function(state) {
    if (this.regexp_eatAssertion(state)) {
      if (state.lastAssertionIsQuantifiable && this.regexp_eatQuantifier(state)) {
        if (state.switchU) {
          state.raise("Invalid quantifier");
        }
      }
      return true;
    }
    if (state.switchU ? this.regexp_eatAtom(state) : this.regexp_eatExtendedAtom(state)) {
      this.regexp_eatQuantifier(state);
      return true;
    }
    return false;
  };
  pp$1.regexp_eatAssertion = function(state) {
    var start = state.pos;
    state.lastAssertionIsQuantifiable = false;
    if (state.eat(
      94
    ) || state.eat(
      36
    )) {
      return true;
    }
    if (state.eat(
      92
    )) {
      if (state.eat(
        66
      ) || state.eat(
        98
      )) {
        return true;
      }
      state.pos = start;
    }
    if (state.eat(
      40
    ) && state.eat(
      63
    )) {
      var lookbehind = false;
      if (this.options.ecmaVersion >= 9) {
        lookbehind = state.eat(
          60
        );
      }
      if (state.eat(
        61
      ) || state.eat(
        33
      )) {
        this.regexp_disjunction(state);
        if (!state.eat(
          41
        )) {
          state.raise("Unterminated group");
        }
        state.lastAssertionIsQuantifiable = !lookbehind;
        return true;
      }
    }
    state.pos = start;
    return false;
  };
  pp$1.regexp_eatQuantifier = function(state, noError) {
    if (noError === void 0) noError = false;
    if (this.regexp_eatQuantifierPrefix(state, noError)) {
      state.eat(
        63
      );
      return true;
    }
    return false;
  };
  pp$1.regexp_eatQuantifierPrefix = function(state, noError) {
    return state.eat(
      42
    ) || state.eat(
      43
    ) || state.eat(
      63
    ) || this.regexp_eatBracedQuantifier(state, noError);
  };
  pp$1.regexp_eatBracedQuantifier = function(state, noError) {
    var start = state.pos;
    if (state.eat(
      123
    )) {
      var min = 0, max = -1;
      if (this.regexp_eatDecimalDigits(state)) {
        min = state.lastIntValue;
        if (state.eat(
          44
        ) && this.regexp_eatDecimalDigits(state)) {
          max = state.lastIntValue;
        }
        if (state.eat(
          125
        )) {
          if (max !== -1 && max < min && !noError) {
            state.raise("numbers out of order in {} quantifier");
          }
          return true;
        }
      }
      if (state.switchU && !noError) {
        state.raise("Incomplete quantifier");
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatAtom = function(state) {
    return this.regexp_eatPatternCharacters(state) || state.eat(
      46
    ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state);
  };
  pp$1.regexp_eatReverseSolidusAtomEscape = function(state) {
    var start = state.pos;
    if (state.eat(
      92
    )) {
      if (this.regexp_eatAtomEscape(state)) {
        return true;
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatUncapturingGroup = function(state) {
    var start = state.pos;
    if (state.eat(
      40
    )) {
      if (state.eat(
        63
      )) {
        if (this.options.ecmaVersion >= 16) {
          var addModifiers = this.regexp_eatModifiers(state);
          var hasHyphen = state.eat(
            45
          );
          if (addModifiers || hasHyphen) {
            for (var i2 = 0; i2 < addModifiers.length; i2++) {
              var modifier = addModifiers.charAt(i2);
              if (addModifiers.indexOf(modifier, i2 + 1) > -1) {
                state.raise("Duplicate regular expression modifiers");
              }
            }
            if (hasHyphen) {
              var removeModifiers = this.regexp_eatModifiers(state);
              if (!addModifiers && !removeModifiers && state.current() === 58) {
                state.raise("Invalid regular expression modifiers");
              }
              for (var i$1 = 0; i$1 < removeModifiers.length; i$1++) {
                var modifier$1 = removeModifiers.charAt(i$1);
                if (removeModifiers.indexOf(modifier$1, i$1 + 1) > -1 || addModifiers.indexOf(modifier$1) > -1) {
                  state.raise("Duplicate regular expression modifiers");
                }
              }
            }
          }
        }
        if (state.eat(
          58
        )) {
          this.regexp_disjunction(state);
          if (state.eat(
            41
          )) {
            return true;
          }
          state.raise("Unterminated group");
        }
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatCapturingGroup = function(state) {
    if (state.eat(
      40
    )) {
      if (this.options.ecmaVersion >= 9) {
        this.regexp_groupSpecifier(state);
      } else if (state.current() === 63) {
        state.raise("Invalid group");
      }
      this.regexp_disjunction(state);
      if (state.eat(
        41
      )) {
        state.numCapturingParens += 1;
        return true;
      }
      state.raise("Unterminated group");
    }
    return false;
  };
  pp$1.regexp_eatModifiers = function(state) {
    var modifiers = "";
    var ch = 0;
    while ((ch = state.current()) !== -1 && isRegularExpressionModifier(ch)) {
      modifiers += codePointToString(ch);
      state.advance();
    }
    return modifiers;
  };
  function isRegularExpressionModifier(ch) {
    return ch === 105 || ch === 109 || ch === 115;
  }
  pp$1.regexp_eatExtendedAtom = function(state) {
    return state.eat(
      46
    ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state) || this.regexp_eatInvalidBracedQuantifier(state) || this.regexp_eatExtendedPatternCharacter(state);
  };
  pp$1.regexp_eatInvalidBracedQuantifier = function(state) {
    if (this.regexp_eatBracedQuantifier(state, true)) {
      state.raise("Nothing to repeat");
    }
    return false;
  };
  pp$1.regexp_eatSyntaxCharacter = function(state) {
    var ch = state.current();
    if (isSyntaxCharacter(ch)) {
      state.lastIntValue = ch;
      state.advance();
      return true;
    }
    return false;
  };
  function isSyntaxCharacter(ch) {
    return ch === 36 || ch >= 40 && ch <= 43 || ch === 46 || ch === 63 || ch >= 91 && ch <= 94 || ch >= 123 && ch <= 125;
  }
  pp$1.regexp_eatPatternCharacters = function(state) {
    var start = state.pos;
    var ch = 0;
    while ((ch = state.current()) !== -1 && !isSyntaxCharacter(ch)) {
      state.advance();
    }
    return state.pos !== start;
  };
  pp$1.regexp_eatExtendedPatternCharacter = function(state) {
    var ch = state.current();
    if (ch !== -1 && ch !== 36 && !(ch >= 40 && ch <= 43) && ch !== 46 && ch !== 63 && ch !== 91 && ch !== 94 && ch !== 124) {
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_groupSpecifier = function(state) {
    if (state.eat(
      63
    )) {
      if (!this.regexp_eatGroupName(state)) {
        state.raise("Invalid group");
      }
      var trackDisjunction = this.options.ecmaVersion >= 16;
      var known = state.groupNames[state.lastStringValue];
      if (known) {
        if (trackDisjunction) {
          for (var i2 = 0, list = known; i2 < list.length; i2 += 1) {
            var altID = list[i2];
            if (!altID.separatedFrom(state.branchID)) {
              state.raise("Duplicate capture group name");
            }
          }
        } else {
          state.raise("Duplicate capture group name");
        }
      }
      if (trackDisjunction) {
        (known || (state.groupNames[state.lastStringValue] = [])).push(state.branchID);
      } else {
        state.groupNames[state.lastStringValue] = true;
      }
    }
  };
  pp$1.regexp_eatGroupName = function(state) {
    state.lastStringValue = "";
    if (state.eat(
      60
    )) {
      if (this.regexp_eatRegExpIdentifierName(state) && state.eat(
        62
      )) {
        return true;
      }
      state.raise("Invalid capture group name");
    }
    return false;
  };
  pp$1.regexp_eatRegExpIdentifierName = function(state) {
    state.lastStringValue = "";
    if (this.regexp_eatRegExpIdentifierStart(state)) {
      state.lastStringValue += codePointToString(state.lastIntValue);
      while (this.regexp_eatRegExpIdentifierPart(state)) {
        state.lastStringValue += codePointToString(state.lastIntValue);
      }
      return true;
    }
    return false;
  };
  pp$1.regexp_eatRegExpIdentifierStart = function(state) {
    var start = state.pos;
    var forceU = this.options.ecmaVersion >= 11;
    var ch = state.current(forceU);
    state.advance(forceU);
    if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
      ch = state.lastIntValue;
    }
    if (isRegExpIdentifierStart(ch)) {
      state.lastIntValue = ch;
      return true;
    }
    state.pos = start;
    return false;
  };
  function isRegExpIdentifierStart(ch) {
    return isIdentifierStart(ch, true) || ch === 36 || ch === 95;
  }
  pp$1.regexp_eatRegExpIdentifierPart = function(state) {
    var start = state.pos;
    var forceU = this.options.ecmaVersion >= 11;
    var ch = state.current(forceU);
    state.advance(forceU);
    if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
      ch = state.lastIntValue;
    }
    if (isRegExpIdentifierPart(ch)) {
      state.lastIntValue = ch;
      return true;
    }
    state.pos = start;
    return false;
  };
  function isRegExpIdentifierPart(ch) {
    return isIdentifierChar(ch, true) || ch === 36 || ch === 95 || ch === 8204 || ch === 8205;
  }
  pp$1.regexp_eatAtomEscape = function(state) {
    if (this.regexp_eatBackReference(state) || this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state) || state.switchN && this.regexp_eatKGroupName(state)) {
      return true;
    }
    if (state.switchU) {
      if (state.current() === 99) {
        state.raise("Invalid unicode escape");
      }
      state.raise("Invalid escape");
    }
    return false;
  };
  pp$1.regexp_eatBackReference = function(state) {
    var start = state.pos;
    if (this.regexp_eatDecimalEscape(state)) {
      var n2 = state.lastIntValue;
      if (state.switchU) {
        if (n2 > state.maxBackReference) {
          state.maxBackReference = n2;
        }
        return true;
      }
      if (n2 <= state.numCapturingParens) {
        return true;
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatKGroupName = function(state) {
    if (state.eat(
      107
    )) {
      if (this.regexp_eatGroupName(state)) {
        state.backReferenceNames.push(state.lastStringValue);
        return true;
      }
      state.raise("Invalid named reference");
    }
    return false;
  };
  pp$1.regexp_eatCharacterEscape = function(state) {
    return this.regexp_eatControlEscape(state) || this.regexp_eatCControlLetter(state) || this.regexp_eatZero(state) || this.regexp_eatHexEscapeSequence(state) || this.regexp_eatRegExpUnicodeEscapeSequence(state, false) || !state.switchU && this.regexp_eatLegacyOctalEscapeSequence(state) || this.regexp_eatIdentityEscape(state);
  };
  pp$1.regexp_eatCControlLetter = function(state) {
    var start = state.pos;
    if (state.eat(
      99
    )) {
      if (this.regexp_eatControlLetter(state)) {
        return true;
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatZero = function(state) {
    if (state.current() === 48 && !isDecimalDigit(state.lookahead())) {
      state.lastIntValue = 0;
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_eatControlEscape = function(state) {
    var ch = state.current();
    if (ch === 116) {
      state.lastIntValue = 9;
      state.advance();
      return true;
    }
    if (ch === 110) {
      state.lastIntValue = 10;
      state.advance();
      return true;
    }
    if (ch === 118) {
      state.lastIntValue = 11;
      state.advance();
      return true;
    }
    if (ch === 102) {
      state.lastIntValue = 12;
      state.advance();
      return true;
    }
    if (ch === 114) {
      state.lastIntValue = 13;
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_eatControlLetter = function(state) {
    var ch = state.current();
    if (isControlLetter(ch)) {
      state.lastIntValue = ch % 32;
      state.advance();
      return true;
    }
    return false;
  };
  function isControlLetter(ch) {
    return ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122;
  }
  pp$1.regexp_eatRegExpUnicodeEscapeSequence = function(state, forceU) {
    if (forceU === void 0) forceU = false;
    var start = state.pos;
    var switchU = forceU || state.switchU;
    if (state.eat(
      117
    )) {
      if (this.regexp_eatFixedHexDigits(state, 4)) {
        var lead = state.lastIntValue;
        if (switchU && lead >= 55296 && lead <= 56319) {
          var leadSurrogateEnd = state.pos;
          if (state.eat(
            92
          ) && state.eat(
            117
          ) && this.regexp_eatFixedHexDigits(state, 4)) {
            var trail = state.lastIntValue;
            if (trail >= 56320 && trail <= 57343) {
              state.lastIntValue = (lead - 55296) * 1024 + (trail - 56320) + 65536;
              return true;
            }
          }
          state.pos = leadSurrogateEnd;
          state.lastIntValue = lead;
        }
        return true;
      }
      if (switchU && state.eat(
        123
      ) && this.regexp_eatHexDigits(state) && state.eat(
        125
      ) && isValidUnicode(state.lastIntValue)) {
        return true;
      }
      if (switchU) {
        state.raise("Invalid unicode escape");
      }
      state.pos = start;
    }
    return false;
  };
  function isValidUnicode(ch) {
    return ch >= 0 && ch <= 1114111;
  }
  pp$1.regexp_eatIdentityEscape = function(state) {
    if (state.switchU) {
      if (this.regexp_eatSyntaxCharacter(state)) {
        return true;
      }
      if (state.eat(
        47
      )) {
        state.lastIntValue = 47;
        return true;
      }
      return false;
    }
    var ch = state.current();
    if (ch !== 99 && (!state.switchN || ch !== 107)) {
      state.lastIntValue = ch;
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_eatDecimalEscape = function(state) {
    state.lastIntValue = 0;
    var ch = state.current();
    if (ch >= 49 && ch <= 57) {
      do {
        state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
        state.advance();
      } while ((ch = state.current()) >= 48 && ch <= 57);
      return true;
    }
    return false;
  };
  var CharSetNone = 0;
  var CharSetOk = 1;
  var CharSetString = 2;
  pp$1.regexp_eatCharacterClassEscape = function(state) {
    var ch = state.current();
    if (isCharacterClassEscape(ch)) {
      state.lastIntValue = -1;
      state.advance();
      return CharSetOk;
    }
    var negate = false;
    if (state.switchU && this.options.ecmaVersion >= 9 && ((negate = ch === 80) || ch === 112)) {
      state.lastIntValue = -1;
      state.advance();
      var result;
      if (state.eat(
        123
      ) && (result = this.regexp_eatUnicodePropertyValueExpression(state)) && state.eat(
        125
      )) {
        if (negate && result === CharSetString) {
          state.raise("Invalid property name");
        }
        return result;
      }
      state.raise("Invalid property name");
    }
    return CharSetNone;
  };
  function isCharacterClassEscape(ch) {
    return ch === 100 || ch === 68 || ch === 115 || ch === 83 || ch === 119 || ch === 87;
  }
  pp$1.regexp_eatUnicodePropertyValueExpression = function(state) {
    var start = state.pos;
    if (this.regexp_eatUnicodePropertyName(state) && state.eat(
      61
    )) {
      var name = state.lastStringValue;
      if (this.regexp_eatUnicodePropertyValue(state)) {
        var value = state.lastStringValue;
        this.regexp_validateUnicodePropertyNameAndValue(state, name, value);
        return CharSetOk;
      }
    }
    state.pos = start;
    if (this.regexp_eatLoneUnicodePropertyNameOrValue(state)) {
      var nameOrValue = state.lastStringValue;
      return this.regexp_validateUnicodePropertyNameOrValue(state, nameOrValue);
    }
    return CharSetNone;
  };
  pp$1.regexp_validateUnicodePropertyNameAndValue = function(state, name, value) {
    if (!hasOwn(state.unicodeProperties.nonBinary, name)) {
      state.raise("Invalid property name");
    }
    if (!state.unicodeProperties.nonBinary[name].test(value)) {
      state.raise("Invalid property value");
    }
  };
  pp$1.regexp_validateUnicodePropertyNameOrValue = function(state, nameOrValue) {
    if (state.unicodeProperties.binary.test(nameOrValue)) {
      return CharSetOk;
    }
    if (state.switchV && state.unicodeProperties.binaryOfStrings.test(nameOrValue)) {
      return CharSetString;
    }
    state.raise("Invalid property name");
  };
  pp$1.regexp_eatUnicodePropertyName = function(state) {
    var ch = 0;
    state.lastStringValue = "";
    while (isUnicodePropertyNameCharacter(ch = state.current())) {
      state.lastStringValue += codePointToString(ch);
      state.advance();
    }
    return state.lastStringValue !== "";
  };
  function isUnicodePropertyNameCharacter(ch) {
    return isControlLetter(ch) || ch === 95;
  }
  pp$1.regexp_eatUnicodePropertyValue = function(state) {
    var ch = 0;
    state.lastStringValue = "";
    while (isUnicodePropertyValueCharacter(ch = state.current())) {
      state.lastStringValue += codePointToString(ch);
      state.advance();
    }
    return state.lastStringValue !== "";
  };
  function isUnicodePropertyValueCharacter(ch) {
    return isUnicodePropertyNameCharacter(ch) || isDecimalDigit(ch);
  }
  pp$1.regexp_eatLoneUnicodePropertyNameOrValue = function(state) {
    return this.regexp_eatUnicodePropertyValue(state);
  };
  pp$1.regexp_eatCharacterClass = function(state) {
    if (state.eat(
      91
    )) {
      var negate = state.eat(
        94
      );
      var result = this.regexp_classContents(state);
      if (!state.eat(
        93
      )) {
        state.raise("Unterminated character class");
      }
      if (negate && result === CharSetString) {
        state.raise("Negated character class may contain strings");
      }
      return true;
    }
    return false;
  };
  pp$1.regexp_classContents = function(state) {
    if (state.current() === 93) {
      return CharSetOk;
    }
    if (state.switchV) {
      return this.regexp_classSetExpression(state);
    }
    this.regexp_nonEmptyClassRanges(state);
    return CharSetOk;
  };
  pp$1.regexp_nonEmptyClassRanges = function(state) {
    while (this.regexp_eatClassAtom(state)) {
      var left = state.lastIntValue;
      if (state.eat(
        45
      ) && this.regexp_eatClassAtom(state)) {
        var right = state.lastIntValue;
        if (state.switchU && (left === -1 || right === -1)) {
          state.raise("Invalid character class");
        }
        if (left !== -1 && right !== -1 && left > right) {
          state.raise("Range out of order in character class");
        }
      }
    }
  };
  pp$1.regexp_eatClassAtom = function(state) {
    var start = state.pos;
    if (state.eat(
      92
    )) {
      if (this.regexp_eatClassEscape(state)) {
        return true;
      }
      if (state.switchU) {
        var ch$1 = state.current();
        if (ch$1 === 99 || isOctalDigit(ch$1)) {
          state.raise("Invalid class escape");
        }
        state.raise("Invalid escape");
      }
      state.pos = start;
    }
    var ch = state.current();
    if (ch !== 93) {
      state.lastIntValue = ch;
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_eatClassEscape = function(state) {
    var start = state.pos;
    if (state.eat(
      98
    )) {
      state.lastIntValue = 8;
      return true;
    }
    if (state.switchU && state.eat(
      45
    )) {
      state.lastIntValue = 45;
      return true;
    }
    if (!state.switchU && state.eat(
      99
    )) {
      if (this.regexp_eatClassControlLetter(state)) {
        return true;
      }
      state.pos = start;
    }
    return this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state);
  };
  pp$1.regexp_classSetExpression = function(state) {
    var result = CharSetOk, subResult;
    if (this.regexp_eatClassSetRange(state)) ;
    else if (subResult = this.regexp_eatClassSetOperand(state)) {
      if (subResult === CharSetString) {
        result = CharSetString;
      }
      var start = state.pos;
      while (state.eatChars(
        [38, 38]
      )) {
        if (state.current() !== 38 && (subResult = this.regexp_eatClassSetOperand(state))) {
          if (subResult !== CharSetString) {
            result = CharSetOk;
          }
          continue;
        }
        state.raise("Invalid character in character class");
      }
      if (start !== state.pos) {
        return result;
      }
      while (state.eatChars(
        [45, 45]
      )) {
        if (this.regexp_eatClassSetOperand(state)) {
          continue;
        }
        state.raise("Invalid character in character class");
      }
      if (start !== state.pos) {
        return result;
      }
    } else {
      state.raise("Invalid character in character class");
    }
    for (; ; ) {
      if (this.regexp_eatClassSetRange(state)) {
        continue;
      }
      subResult = this.regexp_eatClassSetOperand(state);
      if (!subResult) {
        return result;
      }
      if (subResult === CharSetString) {
        result = CharSetString;
      }
    }
  };
  pp$1.regexp_eatClassSetRange = function(state) {
    var start = state.pos;
    if (this.regexp_eatClassSetCharacter(state)) {
      var left = state.lastIntValue;
      if (state.eat(
        45
      ) && this.regexp_eatClassSetCharacter(state)) {
        var right = state.lastIntValue;
        if (left !== -1 && right !== -1 && left > right) {
          state.raise("Range out of order in character class");
        }
        return true;
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatClassSetOperand = function(state) {
    if (this.regexp_eatClassSetCharacter(state)) {
      return CharSetOk;
    }
    return this.regexp_eatClassStringDisjunction(state) || this.regexp_eatNestedClass(state);
  };
  pp$1.regexp_eatNestedClass = function(state) {
    var start = state.pos;
    if (state.eat(
      91
    )) {
      var negate = state.eat(
        94
      );
      var result = this.regexp_classContents(state);
      if (state.eat(
        93
      )) {
        if (negate && result === CharSetString) {
          state.raise("Negated character class may contain strings");
        }
        return result;
      }
      state.pos = start;
    }
    if (state.eat(
      92
    )) {
      var result$1 = this.regexp_eatCharacterClassEscape(state);
      if (result$1) {
        return result$1;
      }
      state.pos = start;
    }
    return null;
  };
  pp$1.regexp_eatClassStringDisjunction = function(state) {
    var start = state.pos;
    if (state.eatChars(
      [92, 113]
    )) {
      if (state.eat(
        123
      )) {
        var result = this.regexp_classStringDisjunctionContents(state);
        if (state.eat(
          125
        )) {
          return result;
        }
      } else {
        state.raise("Invalid escape");
      }
      state.pos = start;
    }
    return null;
  };
  pp$1.regexp_classStringDisjunctionContents = function(state) {
    var result = this.regexp_classString(state);
    while (state.eat(
      124
    )) {
      if (this.regexp_classString(state) === CharSetString) {
        result = CharSetString;
      }
    }
    return result;
  };
  pp$1.regexp_classString = function(state) {
    var count = 0;
    while (this.regexp_eatClassSetCharacter(state)) {
      count++;
    }
    return count === 1 ? CharSetOk : CharSetString;
  };
  pp$1.regexp_eatClassSetCharacter = function(state) {
    var start = state.pos;
    if (state.eat(
      92
    )) {
      if (this.regexp_eatCharacterEscape(state) || this.regexp_eatClassSetReservedPunctuator(state)) {
        return true;
      }
      if (state.eat(
        98
      )) {
        state.lastIntValue = 8;
        return true;
      }
      state.pos = start;
      return false;
    }
    var ch = state.current();
    if (ch < 0 || ch === state.lookahead() && isClassSetReservedDoublePunctuatorCharacter(ch)) {
      return false;
    }
    if (isClassSetSyntaxCharacter(ch)) {
      return false;
    }
    state.advance();
    state.lastIntValue = ch;
    return true;
  };
  function isClassSetReservedDoublePunctuatorCharacter(ch) {
    return ch === 33 || ch >= 35 && ch <= 38 || ch >= 42 && ch <= 44 || ch === 46 || ch >= 58 && ch <= 64 || ch === 94 || ch === 96 || ch === 126;
  }
  function isClassSetSyntaxCharacter(ch) {
    return ch === 40 || ch === 41 || ch === 45 || ch === 47 || ch >= 91 && ch <= 93 || ch >= 123 && ch <= 125;
  }
  pp$1.regexp_eatClassSetReservedPunctuator = function(state) {
    var ch = state.current();
    if (isClassSetReservedPunctuator(ch)) {
      state.lastIntValue = ch;
      state.advance();
      return true;
    }
    return false;
  };
  function isClassSetReservedPunctuator(ch) {
    return ch === 33 || ch === 35 || ch === 37 || ch === 38 || ch === 44 || ch === 45 || ch >= 58 && ch <= 62 || ch === 64 || ch === 96 || ch === 126;
  }
  pp$1.regexp_eatClassControlLetter = function(state) {
    var ch = state.current();
    if (isDecimalDigit(ch) || ch === 95) {
      state.lastIntValue = ch % 32;
      state.advance();
      return true;
    }
    return false;
  };
  pp$1.regexp_eatHexEscapeSequence = function(state) {
    var start = state.pos;
    if (state.eat(
      120
    )) {
      if (this.regexp_eatFixedHexDigits(state, 2)) {
        return true;
      }
      if (state.switchU) {
        state.raise("Invalid escape");
      }
      state.pos = start;
    }
    return false;
  };
  pp$1.regexp_eatDecimalDigits = function(state) {
    var start = state.pos;
    var ch = 0;
    state.lastIntValue = 0;
    while (isDecimalDigit(ch = state.current())) {
      state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
      state.advance();
    }
    return state.pos !== start;
  };
  function isDecimalDigit(ch) {
    return ch >= 48 && ch <= 57;
  }
  pp$1.regexp_eatHexDigits = function(state) {
    var start = state.pos;
    var ch = 0;
    state.lastIntValue = 0;
    while (isHexDigit(ch = state.current())) {
      state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
      state.advance();
    }
    return state.pos !== start;
  };
  function isHexDigit(ch) {
    return ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102;
  }
  function hexToInt(ch) {
    if (ch >= 65 && ch <= 70) {
      return 10 + (ch - 65);
    }
    if (ch >= 97 && ch <= 102) {
      return 10 + (ch - 97);
    }
    return ch - 48;
  }
  pp$1.regexp_eatLegacyOctalEscapeSequence = function(state) {
    if (this.regexp_eatOctalDigit(state)) {
      var n1 = state.lastIntValue;
      if (this.regexp_eatOctalDigit(state)) {
        var n2 = state.lastIntValue;
        if (n1 <= 3 && this.regexp_eatOctalDigit(state)) {
          state.lastIntValue = n1 * 64 + n2 * 8 + state.lastIntValue;
        } else {
          state.lastIntValue = n1 * 8 + n2;
        }
      } else {
        state.lastIntValue = n1;
      }
      return true;
    }
    return false;
  };
  pp$1.regexp_eatOctalDigit = function(state) {
    var ch = state.current();
    if (isOctalDigit(ch)) {
      state.lastIntValue = ch - 48;
      state.advance();
      return true;
    }
    state.lastIntValue = 0;
    return false;
  };
  function isOctalDigit(ch) {
    return ch >= 48 && ch <= 55;
  }
  pp$1.regexp_eatFixedHexDigits = function(state, length) {
    var start = state.pos;
    state.lastIntValue = 0;
    for (var i2 = 0; i2 < length; ++i2) {
      var ch = state.current();
      if (!isHexDigit(ch)) {
        state.pos = start;
        return false;
      }
      state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
      state.advance();
    }
    return true;
  };
  var Token = function Token2(p) {
    this.type = p.type;
    this.value = p.value;
    this.start = p.start;
    this.end = p.end;
    if (p.options.locations) {
      this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
    }
    if (p.options.ranges) {
      this.range = [p.start, p.end];
    }
  };
  var pp = Parser.prototype;
  pp.next = function(ignoreEscapeSequenceInKeyword) {
    if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc) {
      this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword);
    }
    if (this.options.onToken) {
      this.options.onToken(new Token(this));
    }
    this.lastTokEnd = this.end;
    this.lastTokStart = this.start;
    this.lastTokEndLoc = this.endLoc;
    this.lastTokStartLoc = this.startLoc;
    this.nextToken();
  };
  pp.getToken = function() {
    this.next();
    return new Token(this);
  };
  if (typeof Symbol !== "undefined") {
    pp[Symbol.iterator] = function() {
      var this$1$1 = this;
      return {
        next: function() {
          var token = this$1$1.getToken();
          return {
            done: token.type === types$1.eof,
            value: token
          };
        }
      };
    };
  }
  pp.nextToken = function() {
    var curContext = this.curContext();
    if (!curContext || !curContext.preserveSpace) {
      this.skipSpace();
    }
    this.start = this.pos;
    if (this.options.locations) {
      this.startLoc = this.curPosition();
    }
    if (this.pos >= this.input.length) {
      return this.finishToken(types$1.eof);
    }
    if (curContext.override) {
      return curContext.override(this);
    } else {
      this.readToken(this.fullCharCodeAtPos());
    }
  };
  pp.readToken = function(code) {
    if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92) {
      return this.readWord();
    }
    return this.getTokenFromCode(code);
  };
  pp.fullCharCodeAt = function(pos) {
    var code = this.input.charCodeAt(pos);
    if (code <= 55295 || code >= 56320) {
      return code;
    }
    var next = this.input.charCodeAt(pos + 1);
    return next <= 56319 || next >= 57344 ? code : (code << 10) + next - 56613888;
  };
  pp.fullCharCodeAtPos = function() {
    return this.fullCharCodeAt(this.pos);
  };
  pp.skipBlockComment = function() {
    var startLoc = this.options.onComment && this.curPosition();
    var start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
    if (end === -1) {
      this.raise(this.pos - 2, "Unterminated comment");
    }
    this.pos = end + 2;
    if (this.options.locations) {
      for (var nextBreak = void 0, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1; ) {
        ++this.curLine;
        pos = this.lineStart = nextBreak;
      }
    }
    if (this.options.onComment) {
      this.options.onComment(
        true,
        this.input.slice(start + 2, end),
        start,
        this.pos,
        startLoc,
        this.curPosition()
      );
    }
  };
  pp.skipLineComment = function(startSkip) {
    var start = this.pos;
    var startLoc = this.options.onComment && this.curPosition();
    var ch = this.input.charCodeAt(this.pos += startSkip);
    while (this.pos < this.input.length && !isNewLine(ch)) {
      ch = this.input.charCodeAt(++this.pos);
    }
    if (this.options.onComment) {
      this.options.onComment(
        false,
        this.input.slice(start + startSkip, this.pos),
        start,
        this.pos,
        startLoc,
        this.curPosition()
      );
    }
  };
  pp.skipSpace = function() {
    loop: while (this.pos < this.input.length) {
      var ch = this.input.charCodeAt(this.pos);
      switch (ch) {
        case 32:
        case 160:
          ++this.pos;
          break;
        case 13:
          if (this.input.charCodeAt(this.pos + 1) === 10) {
            ++this.pos;
          }
        case 10:
        case 8232:
        case 8233:
          ++this.pos;
          if (this.options.locations) {
            ++this.curLine;
            this.lineStart = this.pos;
          }
          break;
        case 47:
          switch (this.input.charCodeAt(this.pos + 1)) {
            case 42:
              this.skipBlockComment();
              break;
            case 47:
              this.skipLineComment(2);
              break;
            default:
              break loop;
          }
          break;
        default:
          if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
            ++this.pos;
          } else {
            break loop;
          }
      }
    }
  };
  pp.finishToken = function(type, val) {
    this.end = this.pos;
    if (this.options.locations) {
      this.endLoc = this.curPosition();
    }
    var prevType = this.type;
    this.type = type;
    this.value = val;
    this.updateContext(prevType);
  };
  pp.readToken_dot = function() {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next >= 48 && next <= 57) {
      return this.readNumber(true);
    }
    var next2 = this.input.charCodeAt(this.pos + 2);
    if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
      this.pos += 3;
      return this.finishToken(types$1.ellipsis);
    } else {
      ++this.pos;
      return this.finishToken(types$1.dot);
    }
  };
  pp.readToken_slash = function() {
    var next = this.input.charCodeAt(this.pos + 1);
    if (this.exprAllowed) {
      ++this.pos;
      return this.readRegexp();
    }
    if (next === 61) {
      return this.finishOp(types$1.assign, 2);
    }
    return this.finishOp(types$1.slash, 1);
  };
  pp.readToken_mult_modulo_exp = function(code) {
    var next = this.input.charCodeAt(this.pos + 1);
    var size = 1;
    var tokentype = code === 42 ? types$1.star : types$1.modulo;
    if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
      ++size;
      tokentype = types$1.starstar;
      next = this.input.charCodeAt(this.pos + 2);
    }
    if (next === 61) {
      return this.finishOp(types$1.assign, size + 1);
    }
    return this.finishOp(tokentype, size);
  };
  pp.readToken_pipe_amp = function(code) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === code) {
      if (this.options.ecmaVersion >= 12) {
        var next2 = this.input.charCodeAt(this.pos + 2);
        if (next2 === 61) {
          return this.finishOp(types$1.assign, 3);
        }
      }
      return this.finishOp(code === 124 ? types$1.logicalOR : types$1.logicalAND, 2);
    }
    if (next === 61) {
      return this.finishOp(types$1.assign, 2);
    }
    return this.finishOp(code === 124 ? types$1.bitwiseOR : types$1.bitwiseAND, 1);
  };
  pp.readToken_caret = function() {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 61) {
      return this.finishOp(types$1.assign, 2);
    }
    return this.finishOp(types$1.bitwiseXOR, 1);
  };
  pp.readToken_plus_min = function(code) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === code) {
      if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 && (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
        this.skipLineComment(3);
        this.skipSpace();
        return this.nextToken();
      }
      return this.finishOp(types$1.incDec, 2);
    }
    if (next === 61) {
      return this.finishOp(types$1.assign, 2);
    }
    return this.finishOp(types$1.plusMin, 1);
  };
  pp.readToken_lt_gt = function(code) {
    var next = this.input.charCodeAt(this.pos + 1);
    var size = 1;
    if (next === code) {
      size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
      if (this.input.charCodeAt(this.pos + size) === 61) {
        return this.finishOp(types$1.assign, size + 1);
      }
      return this.finishOp(types$1.bitShift, size);
    }
    if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 && this.input.charCodeAt(this.pos + 3) === 45) {
      this.skipLineComment(4);
      this.skipSpace();
      return this.nextToken();
    }
    if (next === 61) {
      size = 2;
    }
    return this.finishOp(types$1.relational, size);
  };
  pp.readToken_eq_excl = function(code) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 61) {
      return this.finishOp(types$1.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
    }
    if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
      this.pos += 2;
      return this.finishToken(types$1.arrow);
    }
    return this.finishOp(code === 61 ? types$1.eq : types$1.prefix, 1);
  };
  pp.readToken_question = function() {
    var ecmaVersion = this.options.ecmaVersion;
    if (ecmaVersion >= 11) {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 46) {
        var next2 = this.input.charCodeAt(this.pos + 2);
        if (next2 < 48 || next2 > 57) {
          return this.finishOp(types$1.questionDot, 2);
        }
      }
      if (next === 63) {
        if (ecmaVersion >= 12) {
          var next2$1 = this.input.charCodeAt(this.pos + 2);
          if (next2$1 === 61) {
            return this.finishOp(types$1.assign, 3);
          }
        }
        return this.finishOp(types$1.coalesce, 2);
      }
    }
    return this.finishOp(types$1.question, 1);
  };
  pp.readToken_numberSign = function() {
    var ecmaVersion = this.options.ecmaVersion;
    var code = 35;
    if (ecmaVersion >= 13) {
      ++this.pos;
      code = this.fullCharCodeAtPos();
      if (isIdentifierStart(code, true) || code === 92) {
        return this.finishToken(types$1.privateId, this.readWord1());
      }
    }
    this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
  };
  pp.getTokenFromCode = function(code) {
    switch (code) {
      case 46:
        return this.readToken_dot();
      case 40:
        ++this.pos;
        return this.finishToken(types$1.parenL);
      case 41:
        ++this.pos;
        return this.finishToken(types$1.parenR);
      case 59:
        ++this.pos;
        return this.finishToken(types$1.semi);
      case 44:
        ++this.pos;
        return this.finishToken(types$1.comma);
      case 91:
        ++this.pos;
        return this.finishToken(types$1.bracketL);
      case 93:
        ++this.pos;
        return this.finishToken(types$1.bracketR);
      case 123:
        ++this.pos;
        return this.finishToken(types$1.braceL);
      case 125:
        ++this.pos;
        return this.finishToken(types$1.braceR);
      case 58:
        ++this.pos;
        return this.finishToken(types$1.colon);
      case 96:
        if (this.options.ecmaVersion < 6) {
          break;
        }
        ++this.pos;
        return this.finishToken(types$1.backQuote);
      case 48:
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === 120 || next === 88) {
          return this.readRadixNumber(16);
        }
        if (this.options.ecmaVersion >= 6) {
          if (next === 111 || next === 79) {
            return this.readRadixNumber(8);
          }
          if (next === 98 || next === 66) {
            return this.readRadixNumber(2);
          }
        }
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        return this.readNumber(false);
      case 34:
      case 39:
        return this.readString(code);
      case 47:
        return this.readToken_slash();
      case 37:
      case 42:
        return this.readToken_mult_modulo_exp(code);
      case 124:
      case 38:
        return this.readToken_pipe_amp(code);
      case 94:
        return this.readToken_caret();
      case 43:
      case 45:
        return this.readToken_plus_min(code);
      case 60:
      case 62:
        return this.readToken_lt_gt(code);
      case 61:
      case 33:
        return this.readToken_eq_excl(code);
      case 63:
        return this.readToken_question();
      case 126:
        return this.finishOp(types$1.prefix, 1);
      case 35:
        return this.readToken_numberSign();
    }
    this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
  };
  pp.finishOp = function(type, size) {
    var str = this.input.slice(this.pos, this.pos + size);
    this.pos += size;
    return this.finishToken(type, str);
  };
  pp.readRegexp = function() {
    var escaped, inClass, start = this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) {
        this.raise(start, "Unterminated regular expression");
      }
      var ch = this.input.charAt(this.pos);
      if (lineBreak.test(ch)) {
        this.raise(start, "Unterminated regular expression");
      }
      if (!escaped) {
        if (ch === "[") {
          inClass = true;
        } else if (ch === "]" && inClass) {
          inClass = false;
        } else if (ch === "/" && !inClass) {
          break;
        }
        escaped = ch === "\\";
      } else {
        escaped = false;
      }
      ++this.pos;
    }
    var pattern = this.input.slice(start, this.pos);
    ++this.pos;
    var flagsStart = this.pos;
    var flags = this.readWord1();
    if (this.containsEsc) {
      this.unexpected(flagsStart);
    }
    var state = this.regexpState || (this.regexpState = new RegExpValidationState(this));
    state.reset(start, pattern, flags);
    this.validateRegExpFlags(state);
    this.validateRegExpPattern(state);
    var value = null;
    try {
      value = new RegExp(pattern, flags);
    } catch (e2) {
    }
    return this.finishToken(types$1.regexp, { pattern, flags, value });
  };
  pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
    var allowSeparators = this.options.ecmaVersion >= 12 && len === void 0;
    var isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48;
    var start = this.pos, total = 0, lastCode = 0;
    for (var i2 = 0, e2 = len == null ? Infinity : len; i2 < e2; ++i2, ++this.pos) {
      var code = this.input.charCodeAt(this.pos), val = void 0;
      if (allowSeparators && code === 95) {
        if (isLegacyOctalNumericLiteral) {
          this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals");
        }
        if (lastCode === 95) {
          this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore");
        }
        if (i2 === 0) {
          this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits");
        }
        lastCode = code;
        continue;
      }
      if (code >= 97) {
        val = code - 97 + 10;
      } else if (code >= 65) {
        val = code - 65 + 10;
      } else if (code >= 48 && code <= 57) {
        val = code - 48;
      } else {
        val = Infinity;
      }
      if (val >= radix) {
        break;
      }
      lastCode = code;
      total = total * radix + val;
    }
    if (allowSeparators && lastCode === 95) {
      this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits");
    }
    if (this.pos === start || len != null && this.pos - start !== len) {
      return null;
    }
    return total;
  };
  function stringToNumber(str, isLegacyOctalNumericLiteral) {
    if (isLegacyOctalNumericLiteral) {
      return parseInt(str, 8);
    }
    return parseFloat(str.replace(/_/g, ""));
  }
  function stringToBigInt(str) {
    if (typeof BigInt !== "function") {
      return null;
    }
    return BigInt(str.replace(/_/g, ""));
  }
  pp.readRadixNumber = function(radix) {
    var start = this.pos;
    this.pos += 2;
    var val = this.readInt(radix);
    if (val == null) {
      this.raise(this.start + 2, "Expected number in radix " + radix);
    }
    if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
      val = stringToBigInt(this.input.slice(start, this.pos));
      ++this.pos;
    } else if (isIdentifierStart(this.fullCharCodeAtPos())) {
      this.raise(this.pos, "Identifier directly after number");
    }
    return this.finishToken(types$1.num, val);
  };
  pp.readNumber = function(startsWithDot) {
    var start = this.pos;
    if (!startsWithDot && this.readInt(10, void 0, true) === null) {
      this.raise(start, "Invalid number");
    }
    var octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48;
    if (octal && this.strict) {
      this.raise(start, "Invalid number");
    }
    var next = this.input.charCodeAt(this.pos);
    if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
      var val$1 = stringToBigInt(this.input.slice(start, this.pos));
      ++this.pos;
      if (isIdentifierStart(this.fullCharCodeAtPos())) {
        this.raise(this.pos, "Identifier directly after number");
      }
      return this.finishToken(types$1.num, val$1);
    }
    if (octal && /[89]/.test(this.input.slice(start, this.pos))) {
      octal = false;
    }
    if (next === 46 && !octal) {
      ++this.pos;
      this.readInt(10);
      next = this.input.charCodeAt(this.pos);
    }
    if ((next === 69 || next === 101) && !octal) {
      next = this.input.charCodeAt(++this.pos);
      if (next === 43 || next === 45) {
        ++this.pos;
      }
      if (this.readInt(10) === null) {
        this.raise(start, "Invalid number");
      }
    }
    if (isIdentifierStart(this.fullCharCodeAtPos())) {
      this.raise(this.pos, "Identifier directly after number");
    }
    var val = stringToNumber(this.input.slice(start, this.pos), octal);
    return this.finishToken(types$1.num, val);
  };
  pp.readCodePoint = function() {
    var ch = this.input.charCodeAt(this.pos), code;
    if (ch === 123) {
      if (this.options.ecmaVersion < 6) {
        this.unexpected();
      }
      var codePos = ++this.pos;
      code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
      ++this.pos;
      if (code > 1114111) {
        this.invalidStringToken(codePos, "Code point out of bounds");
      }
    } else {
      code = this.readHexChar(4);
    }
    return code;
  };
  pp.readString = function(quote) {
    var out = "", chunkStart = ++this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) {
        this.raise(this.start, "Unterminated string constant");
      }
      var ch = this.input.charCodeAt(this.pos);
      if (ch === quote) {
        break;
      }
      if (ch === 92) {
        out += this.input.slice(chunkStart, this.pos);
        out += this.readEscapedChar(false);
        chunkStart = this.pos;
      } else if (ch === 8232 || ch === 8233) {
        if (this.options.ecmaVersion < 10) {
          this.raise(this.start, "Unterminated string constant");
        }
        ++this.pos;
        if (this.options.locations) {
          this.curLine++;
          this.lineStart = this.pos;
        }
      } else {
        if (isNewLine(ch)) {
          this.raise(this.start, "Unterminated string constant");
        }
        ++this.pos;
      }
    }
    out += this.input.slice(chunkStart, this.pos++);
    return this.finishToken(types$1.string, out);
  };
  var INVALID_TEMPLATE_ESCAPE_ERROR = {};
  pp.tryReadTemplateToken = function() {
    this.inTemplateElement = true;
    try {
      this.readTmplToken();
    } catch (err) {
      if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
        this.readInvalidTemplateToken();
      } else {
        throw err;
      }
    }
    this.inTemplateElement = false;
  };
  pp.invalidStringToken = function(position, message) {
    if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
      throw INVALID_TEMPLATE_ESCAPE_ERROR;
    } else {
      this.raise(position, message);
    }
  };
  pp.readTmplToken = function() {
    var out = "", chunkStart = this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) {
        this.raise(this.start, "Unterminated template");
      }
      var ch = this.input.charCodeAt(this.pos);
      if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
        if (this.pos === this.start && (this.type === types$1.template || this.type === types$1.invalidTemplate)) {
          if (ch === 36) {
            this.pos += 2;
            return this.finishToken(types$1.dollarBraceL);
          } else {
            ++this.pos;
            return this.finishToken(types$1.backQuote);
          }
        }
        out += this.input.slice(chunkStart, this.pos);
        return this.finishToken(types$1.template, out);
      }
      if (ch === 92) {
        out += this.input.slice(chunkStart, this.pos);
        out += this.readEscapedChar(true);
        chunkStart = this.pos;
      } else if (isNewLine(ch)) {
        out += this.input.slice(chunkStart, this.pos);
        ++this.pos;
        switch (ch) {
          case 13:
            if (this.input.charCodeAt(this.pos) === 10) {
              ++this.pos;
            }
          case 10:
            out += "\n";
            break;
          default:
            out += String.fromCharCode(ch);
            break;
        }
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        chunkStart = this.pos;
      } else {
        ++this.pos;
      }
    }
  };
  pp.readInvalidTemplateToken = function() {
    for (; this.pos < this.input.length; this.pos++) {
      switch (this.input[this.pos]) {
        case "\\":
          ++this.pos;
          break;
        case "$":
          if (this.input[this.pos + 1] !== "{") {
            break;
          }
        case "`":
          return this.finishToken(types$1.invalidTemplate, this.input.slice(this.start, this.pos));
        case "\r":
          if (this.input[this.pos + 1] === "\n") {
            ++this.pos;
          }
        case "\n":
        case "\u2028":
        case "\u2029":
          ++this.curLine;
          this.lineStart = this.pos + 1;
          break;
      }
    }
    this.raise(this.start, "Unterminated template");
  };
  pp.readEscapedChar = function(inTemplate) {
    var ch = this.input.charCodeAt(++this.pos);
    ++this.pos;
    switch (ch) {
      case 110:
        return "\n";
      case 114:
        return "\r";
      case 120:
        return String.fromCharCode(this.readHexChar(2));
      case 117:
        return codePointToString(this.readCodePoint());
      case 116:
        return "	";
      case 98:
        return "\b";
      case 118:
        return "\v";
      case 102:
        return "\f";
      case 13:
        if (this.input.charCodeAt(this.pos) === 10) {
          ++this.pos;
        }
      case 10:
        if (this.options.locations) {
          this.lineStart = this.pos;
          ++this.curLine;
        }
        return "";
      case 56:
      case 57:
        if (this.strict) {
          this.invalidStringToken(
            this.pos - 1,
            "Invalid escape sequence"
          );
        }
        if (inTemplate) {
          var codePos = this.pos - 1;
          this.invalidStringToken(
            codePos,
            "Invalid escape sequence in template string"
          );
        }
      default:
        if (ch >= 48 && ch <= 55) {
          var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
          var octal = parseInt(octalStr, 8);
          if (octal > 255) {
            octalStr = octalStr.slice(0, -1);
            octal = parseInt(octalStr, 8);
          }
          this.pos += octalStr.length - 1;
          ch = this.input.charCodeAt(this.pos);
          if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
            this.invalidStringToken(
              this.pos - 1 - octalStr.length,
              inTemplate ? "Octal literal in template string" : "Octal literal in strict mode"
            );
          }
          return String.fromCharCode(octal);
        }
        if (isNewLine(ch)) {
          if (this.options.locations) {
            this.lineStart = this.pos;
            ++this.curLine;
          }
          return "";
        }
        return String.fromCharCode(ch);
    }
  };
  pp.readHexChar = function(len) {
    var codePos = this.pos;
    var n2 = this.readInt(16, len);
    if (n2 === null) {
      this.invalidStringToken(codePos, "Bad character escape sequence");
    }
    return n2;
  };
  pp.readWord1 = function() {
    this.containsEsc = false;
    var word = "", first = true, chunkStart = this.pos;
    var astral = this.options.ecmaVersion >= 6;
    while (this.pos < this.input.length) {
      var ch = this.fullCharCodeAtPos();
      if (isIdentifierChar(ch, astral)) {
        this.pos += ch <= 65535 ? 1 : 2;
      } else if (ch === 92) {
        this.containsEsc = true;
        word += this.input.slice(chunkStart, this.pos);
        var escStart = this.pos;
        if (this.input.charCodeAt(++this.pos) !== 117) {
          this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX");
        }
        ++this.pos;
        var esc = this.readCodePoint();
        if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral)) {
          this.invalidStringToken(escStart, "Invalid Unicode escape");
        }
        word += codePointToString(esc);
        chunkStart = this.pos;
      } else {
        break;
      }
      first = false;
    }
    return word + this.input.slice(chunkStart, this.pos);
  };
  pp.readWord = function() {
    var word = this.readWord1();
    var type = types$1.name;
    if (this.keywords.test(word)) {
      type = keywords[word];
    }
    return this.finishToken(type, word);
  };
  var version = "8.16.0";
  Parser.acorn = {
    Parser,
    version,
    defaultOptions,
    Position,
    SourceLocation,
    getLineInfo,
    Node,
    TokenType,
    tokTypes: types$1,
    keywordTypes: keywords,
    TokContext,
    tokContexts: types,
    isIdentifierChar,
    isIdentifierStart,
    Token,
    isNewLine,
    lineBreak,
    lineBreakG,
    nonASCIIwhitespace
  };
  function parseExpressionAt2(input, pos, options) {
    return Parser.parseExpressionAt(input, pos, options);
  }
  function tokenizer2(input, options) {
    return Parser.tokenizer(input, options);
  }

  function full(node, callback, baseVisitor, state, override) {
    if (!baseVisitor) {
      baseVisitor = base;
    }
    var last;
    (function c2(node2, st, override2) {
      var type = override2 || node2.type;
      visitNode(baseVisitor, type, node2, st, c2);
      if (last !== node2) {
        callback(node2, st, type);
        last = node2;
      }
    })(node, state, override);
  }
  function skipThrough(node, st, c2) {
    c2(node, st);
  }
  function ignore(_node, _st, _c) {
  }
  function visitNode(baseVisitor, type, node, st, c2) {
    if (baseVisitor[type] == null) {
      throw new Error("No walker function defined for node type " + type);
    }
    baseVisitor[type](node, st, c2);
  }
  var base = {};
  base.Program = base.BlockStatement = base.StaticBlock = function(node, st, c2) {
    for (var i2 = 0, list = node.body; i2 < list.length; i2 += 1) {
      var stmt = list[i2];
      c2(stmt, st, "Statement");
    }
  };
  base.Statement = skipThrough;
  base.EmptyStatement = ignore;
  base.ExpressionStatement = base.ParenthesizedExpression = base.ChainExpression = function(node, st, c2) {
    return c2(node.expression, st, "Expression");
  };
  base.IfStatement = function(node, st, c2) {
    c2(node.test, st, "Expression");
    c2(node.consequent, st, "Statement");
    if (node.alternate) {
      c2(node.alternate, st, "Statement");
    }
  };
  base.LabeledStatement = function(node, st, c2) {
    return c2(node.body, st, "Statement");
  };
  base.BreakStatement = base.ContinueStatement = ignore;
  base.WithStatement = function(node, st, c2) {
    c2(node.object, st, "Expression");
    c2(node.body, st, "Statement");
  };
  base.SwitchStatement = function(node, st, c2) {
    c2(node.discriminant, st, "Expression");
    for (var i2 = 0, list = node.cases; i2 < list.length; i2 += 1) {
      var cs = list[i2];
      c2(cs, st);
    }
  };
  base.SwitchCase = function(node, st, c2) {
    if (node.test) {
      c2(node.test, st, "Expression");
    }
    for (var i2 = 0, list = node.consequent; i2 < list.length; i2 += 1) {
      var cons = list[i2];
      c2(cons, st, "Statement");
    }
  };
  base.ReturnStatement = base.YieldExpression = base.AwaitExpression = function(node, st, c2) {
    if (node.argument) {
      c2(node.argument, st, "Expression");
    }
  };
  base.ThrowStatement = base.SpreadElement = function(node, st, c2) {
    return c2(node.argument, st, "Expression");
  };
  base.TryStatement = function(node, st, c2) {
    c2(node.block, st, "Statement");
    if (node.handler) {
      c2(node.handler, st);
    }
    if (node.finalizer) {
      c2(node.finalizer, st, "Statement");
    }
  };
  base.CatchClause = function(node, st, c2) {
    if (node.param) {
      c2(node.param, st, "Pattern");
    }
    c2(node.body, st, "Statement");
  };
  base.WhileStatement = base.DoWhileStatement = function(node, st, c2) {
    c2(node.test, st, "Expression");
    c2(node.body, st, "Statement");
  };
  base.ForStatement = function(node, st, c2) {
    if (node.init) {
      c2(node.init, st, "ForInit");
    }
    if (node.test) {
      c2(node.test, st, "Expression");
    }
    if (node.update) {
      c2(node.update, st, "Expression");
    }
    c2(node.body, st, "Statement");
  };
  base.ForInStatement = base.ForOfStatement = function(node, st, c2) {
    c2(node.left, st, "ForInit");
    c2(node.right, st, "Expression");
    c2(node.body, st, "Statement");
  };
  base.ForInit = function(node, st, c2) {
    if (node.type === "VariableDeclaration") {
      c2(node, st);
    } else {
      c2(node, st, "Expression");
    }
  };
  base.DebuggerStatement = ignore;
  base.FunctionDeclaration = function(node, st, c2) {
    return c2(node, st, "Function");
  };
  base.VariableDeclaration = function(node, st, c2) {
    for (var i2 = 0, list = node.declarations; i2 < list.length; i2 += 1) {
      var decl = list[i2];
      c2(decl, st);
    }
  };
  base.VariableDeclarator = function(node, st, c2) {
    c2(node.id, st, "Pattern");
    if (node.init) {
      c2(node.init, st, "Expression");
    }
  };
  base.Function = function(node, st, c2) {
    if (node.id) {
      c2(node.id, st, "Pattern");
    }
    for (var i2 = 0, list = node.params; i2 < list.length; i2 += 1) {
      var param = list[i2];
      c2(param, st, "Pattern");
    }
    c2(node.body, st, node.expression ? "Expression" : "Statement");
  };
  base.Pattern = function(node, st, c2) {
    if (node.type === "Identifier") {
      c2(node, st, "VariablePattern");
    } else if (node.type === "MemberExpression") {
      c2(node, st, "MemberPattern");
    } else {
      c2(node, st);
    }
  };
  base.VariablePattern = ignore;
  base.MemberPattern = skipThrough;
  base.RestElement = function(node, st, c2) {
    return c2(node.argument, st, "Pattern");
  };
  base.ArrayPattern = function(node, st, c2) {
    for (var i2 = 0, list = node.elements; i2 < list.length; i2 += 1) {
      var elt = list[i2];
      if (elt) {
        c2(elt, st, "Pattern");
      }
    }
  };
  base.ObjectPattern = function(node, st, c2) {
    for (var i2 = 0, list = node.properties; i2 < list.length; i2 += 1) {
      var prop = list[i2];
      if (prop.type === "Property") {
        if (prop.computed) {
          c2(prop.key, st, "Expression");
        }
        c2(prop.value, st, "Pattern");
      } else if (prop.type === "RestElement") {
        c2(prop.argument, st, "Pattern");
      }
    }
  };
  base.Expression = skipThrough;
  base.ThisExpression = base.Super = base.MetaProperty = ignore;
  base.ArrayExpression = function(node, st, c2) {
    for (var i2 = 0, list = node.elements; i2 < list.length; i2 += 1) {
      var elt = list[i2];
      if (elt) {
        c2(elt, st, "Expression");
      }
    }
  };
  base.ObjectExpression = function(node, st, c2) {
    for (var i2 = 0, list = node.properties; i2 < list.length; i2 += 1) {
      var prop = list[i2];
      c2(prop, st);
    }
  };
  base.FunctionExpression = base.ArrowFunctionExpression = base.FunctionDeclaration;
  base.SequenceExpression = function(node, st, c2) {
    for (var i2 = 0, list = node.expressions; i2 < list.length; i2 += 1) {
      var expr = list[i2];
      c2(expr, st, "Expression");
    }
  };
  base.TemplateLiteral = function(node, st, c2) {
    for (var i2 = 0, list = node.quasis; i2 < list.length; i2 += 1) {
      var quasi = list[i2];
      c2(quasi, st);
    }
    for (var i$1 = 0, list$1 = node.expressions; i$1 < list$1.length; i$1 += 1) {
      var expr = list$1[i$1];
      c2(expr, st, "Expression");
    }
  };
  base.TemplateElement = ignore;
  base.UnaryExpression = base.UpdateExpression = function(node, st, c2) {
    c2(node.argument, st, "Expression");
  };
  base.BinaryExpression = base.LogicalExpression = function(node, st, c2) {
    c2(node.left, st, "Expression");
    c2(node.right, st, "Expression");
  };
  base.AssignmentExpression = base.AssignmentPattern = function(node, st, c2) {
    c2(node.left, st, "Pattern");
    c2(node.right, st, "Expression");
  };
  base.ConditionalExpression = function(node, st, c2) {
    c2(node.test, st, "Expression");
    c2(node.consequent, st, "Expression");
    c2(node.alternate, st, "Expression");
  };
  base.NewExpression = base.CallExpression = function(node, st, c2) {
    c2(node.callee, st, "Expression");
    if (node.arguments) {
      for (var i2 = 0, list = node.arguments; i2 < list.length; i2 += 1) {
        var arg = list[i2];
        c2(arg, st, "Expression");
      }
    }
  };
  base.MemberExpression = function(node, st, c2) {
    c2(node.object, st, "Expression");
    if (node.computed) {
      c2(node.property, st, "Expression");
    }
  };
  base.ExportNamedDeclaration = base.ExportDefaultDeclaration = function(node, st, c2) {
    if (node.declaration) {
      c2(node.declaration, st, node.type === "ExportNamedDeclaration" || node.declaration.id ? "Statement" : "Expression");
    }
    if (node.source) {
      c2(node.source, st, "Expression");
    }
    if (node.attributes) {
      for (var i2 = 0, list = node.attributes; i2 < list.length; i2 += 1) {
        var attr = list[i2];
        c2(attr, st);
      }
    }
  };
  base.ExportAllDeclaration = function(node, st, c2) {
    if (node.exported) {
      c2(node.exported, st);
    }
    c2(node.source, st, "Expression");
    if (node.attributes) {
      for (var i2 = 0, list = node.attributes; i2 < list.length; i2 += 1) {
        var attr = list[i2];
        c2(attr, st);
      }
    }
  };
  base.ImportAttribute = function(node, st, c2) {
    c2(node.value, st, "Expression");
  };
  base.ImportDeclaration = function(node, st, c2) {
    for (var i2 = 0, list = node.specifiers; i2 < list.length; i2 += 1) {
      var spec = list[i2];
      c2(spec, st);
    }
    c2(node.source, st, "Expression");
    if (node.attributes) {
      for (var i$1 = 0, list$1 = node.attributes; i$1 < list$1.length; i$1 += 1) {
        var attr = list$1[i$1];
        c2(attr, st);
      }
    }
  };
  base.ImportExpression = function(node, st, c2) {
    c2(node.source, st, "Expression");
    if (node.options) {
      c2(node.options, st, "Expression");
    }
  };
  base.ImportSpecifier = base.ImportDefaultSpecifier = base.ImportNamespaceSpecifier = base.Identifier = base.PrivateIdentifier = base.Literal = ignore;
  base.TaggedTemplateExpression = function(node, st, c2) {
    c2(node.tag, st, "Expression");
    c2(node.quasi, st, "Expression");
  };
  base.ClassDeclaration = base.ClassExpression = function(node, st, c2) {
    return c2(node, st, "Class");
  };
  base.Class = function(node, st, c2) {
    if (node.id) {
      c2(node.id, st, "Pattern");
    }
    if (node.superClass) {
      c2(node.superClass, st, "Expression");
    }
    c2(node.body, st);
  };
  base.ClassBody = function(node, st, c2) {
    for (var i2 = 0, list = node.body; i2 < list.length; i2 += 1) {
      var elt = list[i2];
      c2(elt, st);
    }
  };
  base.MethodDefinition = base.PropertyDefinition = base.Property = function(node, st, c2) {
    if (node.computed) {
      c2(node.key, st, "Expression");
    }
    if (node.value) {
      c2(node.value, st, "Expression");
    }
  };

  var e;
  var a;
  var r;
  var i = 2 << 19;
  var s = 1 === new Uint8Array(new Uint16Array([1]).buffer)[0] ? function(e2, a2) {
    const r2 = e2.length;
    let i2 = 0;
    for (; i2 < r2; ) a2[i2] = e2.charCodeAt(i2++);
  } : function(e2, a2) {
    const r2 = e2.length;
    let i2 = 0;
    for (; i2 < r2; ) {
      const r3 = e2.charCodeAt(i2);
      a2[i2++] = (255 & r3) << 8 | r3 >>> 8;
    }
  };
  var f = "xportportetaourceeferromsyncunctionlassvoyiedelecontininstantybreareturdebuggeawaithrwhileforifcatcfinallels";
  var c;
  var t;
  var n;
  function parse3(k2, l2 = "@") {
    c = k2, t = l2;
    const u2 = 2 * c.length + (2 << 18);
    if (u2 > i || !e) {
      for (; u2 > i; ) i *= 2;
      a = new ArrayBuffer(i), s(f, new Uint16Array(a, 16, 108)), e = (function(e2, a2, r2) {
        ;
        var i2 = new e2.Int8Array(r2), s2 = new e2.Int16Array(r2), f2 = new e2.Int32Array(r2), c2 = new e2.Uint8Array(r2), t2 = new e2.Uint16Array(r2), n2 = 1040;
        function b2() {
          var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, b3 = 0, k4 = 0, o3 = 0, h3 = 0;
          h3 = n2;
          n2 = n2 + 10240 | 0;
          i2[808] = 1;
          i2[807] = 0;
          s2[401] = 0;
          s2[402] = 0;
          f2[70] = f2[2];
          i2[809] = 0;
          f2[68] = 0;
          i2[806] = 0;
          f2[71] = h3 + 2048;
          f2[72] = h3;
          i2[810] = 0;
          e3 = (f2[3] | 0) + -2 | 0;
          f2[73] = e3;
          a3 = e3 + (f2[66] << 1) | 0;
          f2[74] = a3;
          e: while (1) {
            r3 = e3 + 2 | 0;
            f2[73] = r3;
            if (e3 >>> 0 >= a3 >>> 0) {
              c3 = 19;
              break;
            }
            a: do {
              switch (s2[r3 >> 1] | 0) {
                case 9:
                case 10:
                case 11:
                case 12:
                case 13:
                case 32:
                  break;
                case 101: {
                  if ((((s2[402] | 0) == 0 ? R(r3) | 0 : 0) ? (S(e3 + 4 | 0, 16, 10) | 0) == 0 : 0) ? (u3(), (i2[808] | 0) == 0) : 0) {
                    c3 = 9;
                    break e;
                  } else c3 = 18;
                  break;
                }
                case 105: {
                  if (((s2[e3 + 4 >> 1] | 0) == 109 ? R(r3) | 0 : 0) ? (S(e3 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                    l3();
                    c3 = 18;
                  } else c3 = 18;
                  break;
                }
                case 59: {
                  c3 = 18;
                  break;
                }
                case 47:
                  switch (s2[e3 + 4 >> 1] | 0) {
                    case 47: {
                      F();
                      break a;
                    }
                    case 42: {
                      x(1);
                      break a;
                    }
                    default: {
                      c3 = 17;
                      break e;
                    }
                  }
                default: {
                  c3 = 17;
                  break e;
                }
              }
            } while (0);
            if ((c3 | 0) == 18) {
              c3 = 0;
              f2[70] = f2[73];
            }
            e3 = f2[73] | 0;
            a3 = f2[74] | 0;
          }
          if ((c3 | 0) == 9) {
            e3 = f2[73] | 0;
            f2[70] = e3;
            c3 = 20;
          } else if ((c3 | 0) == 17) {
            i2[808] = 0;
            f2[73] = e3;
            c3 = 20;
          } else if ((c3 | 0) == 19) if (!(i2[806] | 0)) {
            e3 = r3;
            c3 = 20;
          } else e3 = 0;
          do {
            if ((c3 | 0) == 20) {
              e: while (1) {
                r3 = e3 + 2 | 0;
                f2[73] = r3;
                if (e3 >>> 0 >= (f2[74] | 0) >>> 0) {
                  c3 = 104;
                  break;
                }
                a3 = s2[r3 >> 1] | 0;
                a: do {
                  switch (a3 << 16 >> 16) {
                    case 9:
                    case 10:
                    case 11:
                    case 12:
                    case 13:
                    case 32:
                      break;
                    case 101: {
                      if (((s2[402] | 0) == 0 ? R(r3) | 0 : 0) ? (S(e3 + 4 | 0, 16, 10) | 0) == 0 : 0) {
                        u3();
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 105: {
                      if (((s2[e3 + 4 >> 1] | 0) == 109 ? R(r3) | 0 : 0) ? (S(e3 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                        l3();
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 99: {
                      if ((((s2[e3 + 4 >> 1] | 0) == 108 ? R(r3) | 0 : 0) ? (S(e3 + 6 | 0, 88, 6) | 0) == 0 : 0) ? L(s2[e3 + 12 >> 1] | 0) | 0 : 0) {
                        i2[810] = 1;
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 40: {
                      r3 = f2[71] | 0;
                      c3 = s2[402] | 0;
                      f2[r3 + ((c3 & 65535) << 3) >> 2] = 1;
                      a3 = f2[70] | 0;
                      s2[402] = c3 + 1 << 16 >> 16;
                      f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = a3;
                      c3 = 103;
                      break;
                    }
                    case 91: {
                      r3 = f2[71] | 0;
                      c3 = s2[402] | 0;
                      f2[r3 + ((c3 & 65535) << 3) >> 2] = 8;
                      a3 = f2[70] | 0;
                      s2[402] = c3 + 1 << 16 >> 16;
                      f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = a3;
                      c3 = 103;
                      break;
                    }
                    case 93: {
                      e3 = s2[402] | 0;
                      if (!(e3 << 16 >> 16)) {
                        c3 = 40;
                        break e;
                      }
                      s2[402] = e3 + -1 << 16 >> 16;
                      c3 = 103;
                      break;
                    }
                    case 44: {
                      a3 = s2[401] | 0;
                      if (((a3 << 16 >> 16 != 0 ? (t3 = s2[402] | 0, t3 << 16 >> 16 != 0) : 0) ? (f2[(f2[71] | 0) + ((t3 & 65535) + -1 << 3) >> 2] | 0) == 5 : 0) ? (b3 = f2[(f2[72] | 0) + ((a3 & 65535) + -1 << 2) >> 2] | 0, (f2[b3 + 4 >> 2] | 0) == 0) : 0) {
                        f2[b3 + 4 >> 2] = (f2[70] | 0) + 2;
                        f2[73] = e3 + 4;
                        v2(1) | 0;
                        c3 = f2[73] | 0;
                        f2[b3 + 16 >> 2] = c3;
                        f2[73] = c3 + -2;
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 41: {
                      a3 = s2[402] | 0;
                      if (!(a3 << 16 >> 16)) {
                        c3 = 48;
                        break e;
                      }
                      s2[402] = a3 + -1 << 16 >> 16;
                      r3 = s2[401] | 0;
                      if (r3 << 16 >> 16 != 0 ? (f2[(f2[71] | 0) + ((a3 + -1 & 65535) << 3) >> 2] | 0) == 5 : 0) {
                        a3 = f2[(f2[72] | 0) + ((r3 & 65535) + -1 << 2) >> 2] | 0;
                        if (!(f2[a3 + 4 >> 2] | 0)) f2[a3 + 4 >> 2] = (f2[70] | 0) + 2;
                        f2[a3 + 12 >> 2] = e3 + 4;
                        s2[401] = r3 + -1 << 16 >> 16;
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 123: {
                      e3 = f2[70] | 0;
                      c3 = f2[62] | 0;
                      do {
                        if ((s2[e3 >> 1] | 0) == 41 & (c3 | 0) != 0 ? (f2[c3 + 12 >> 2] | 0) == (e3 + 2 | 0) : 0) {
                          a3 = f2[63] | 0;
                          f2[62] = a3;
                          if (!a3) {
                            f2[58] = 0;
                            break;
                          } else {
                            f2[a3 + 36 >> 2] = 0;
                            break;
                          }
                        }
                      } while (0);
                      r3 = f2[71] | 0;
                      c3 = s2[402] | 0;
                      f2[r3 + ((c3 & 65535) << 3) >> 2] = (i2[810] | 0) == 0 ? 2 : 6;
                      s2[402] = c3 + 1 << 16 >> 16;
                      f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = e3;
                      i2[810] = 0;
                      c3 = 103;
                      break;
                    }
                    case 125: {
                      e3 = s2[402] | 0;
                      if (!(e3 << 16 >> 16)) {
                        c3 = 61;
                        break e;
                      }
                      c3 = f2[71] | 0;
                      s2[402] = e3 + -1 << 16 >> 16;
                      if ((f2[c3 + ((e3 + -1 & 65535) << 3) >> 2] | 0) == 4) {
                        d2();
                        c3 = 103;
                      } else c3 = 103;
                      break;
                    }
                    case 34:
                    case 39: {
                      C(a3);
                      c3 = 103;
                      break;
                    }
                    case 47:
                      switch (s2[e3 + 4 >> 1] | 0) {
                        case 47: {
                          F();
                          break a;
                        }
                        case 42: {
                          x(1);
                          break a;
                        }
                        default: {
                          e3 = f2[70] | 0;
                          a3 = s2[e3 >> 1] | 0;
                          r: do {
                            if (!($(a3) | 0)) if (a3 << 16 >> 16 == 41) {
                              r3 = s2[402] | 0;
                              if (!(K(f2[(f2[71] | 0) + ((r3 & 65535) << 3) + 4 >> 2] | 0) | 0)) c3 = 76;
                            } else c3 = 75;
                            else switch (a3 << 16 >> 16) {
                              case 46:
                                if (((s2[e3 + -2 >> 1] | 0) + -48 & 65535) < 10) {
                                  c3 = 75;
                                  break r;
                                } else break r;
                              case 43:
                                if ((s2[e3 + -2 >> 1] | 0) == 43) {
                                  c3 = 75;
                                  break r;
                                } else break r;
                              case 45:
                                if ((s2[e3 + -2 >> 1] | 0) == 45) {
                                  c3 = 75;
                                  break r;
                                } else break r;
                              default:
                                break r;
                            }
                          } while (0);
                          if ((c3 | 0) == 75) {
                            r3 = s2[402] | 0;
                            c3 = 76;
                          }
                          r: do {
                            if ((c3 | 0) == 76) {
                              c3 = 0;
                              if (r3 << 16 >> 16 != 0 ? (k4 = f2[71] | 0, o3 = (r3 & 65535) + -1 | 0, a3 << 16 >> 16 == 102 ? (f2[k4 + (o3 << 3) >> 2] | 0) == 1 : 0) : 0) {
                                if (((s2[e3 + -2 >> 1] | 0) == 111 ? g(e3 + -4 | 0) | 0 : 0) ? E(f2[k4 + (o3 << 3) + 4 >> 2] | 0, 196, 3) | 0 : 0) break;
                              } else c3 = 81;
                              if ((c3 | 0) == 81 ? (0, a3 << 16 >> 16 == 125) : 0) {
                                c3 = f2[71] | 0;
                                r3 = r3 & 65535;
                                if (U(f2[c3 + (r3 << 3) + 4 >> 2] | 0) | 0) break;
                                if ((f2[c3 + (r3 << 3) >> 2] | 0) == 6) break;
                              }
                              if (!(w2(e3) | 0)) {
                                switch (a3 << 16 >> 16) {
                                  case 0:
                                    break r;
                                  case 47: {
                                    if (i2[809] | 0) break r;
                                    break;
                                  }
                                  default: {
                                  }
                                }
                                c3 = f2[64] | 0;
                                if ((c3 | 0 ? e3 >>> 0 >= (f2[c3 >> 2] | 0) >>> 0 : 0) ? e3 >>> 0 <= (f2[c3 + 4 >> 2] | 0) >>> 0 : 0) {
                                  I();
                                  i2[809] = 0;
                                  c3 = 103;
                                  break a;
                                }
                                r3 = f2[3] | 0;
                                do {
                                  if (e3 >>> 0 <= r3 >>> 0) break;
                                  e3 = e3 + -2 | 0;
                                  f2[70] = e3;
                                  a3 = s2[e3 >> 1] | 0;
                                } while (!(D(a3) | 0));
                                if (M(a3) | 0) {
                                  do {
                                    if (e3 >>> 0 <= r3 >>> 0) break;
                                    e3 = e3 + -2 | 0;
                                    f2[70] = e3;
                                  } while (M(s2[e3 >> 1] | 0) | 0);
                                  if (q(e3) | 0) {
                                    I();
                                    i2[809] = 0;
                                    c3 = 103;
                                    break a;
                                  }
                                }
                                i2[809] = 1;
                                c3 = 103;
                                break a;
                              }
                            }
                          } while (0);
                          I();
                          i2[809] = 0;
                          c3 = 103;
                          break a;
                        }
                      }
                    case 96: {
                      r3 = f2[71] | 0;
                      c3 = s2[402] | 0;
                      f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = f2[70];
                      s2[402] = c3 + 1 << 16 >> 16;
                      f2[r3 + ((c3 & 65535) << 3) >> 2] = 3;
                      d2();
                      c3 = 103;
                      break;
                    }
                    default:
                      c3 = 103;
                  }
                } while (0);
                if ((c3 | 0) == 103) {
                  c3 = 0;
                  f2[70] = f2[73];
                }
                e3 = f2[73] | 0;
              }
              if ((c3 | 0) == 40) {
                ae();
                e3 = 0;
                break;
              } else if ((c3 | 0) == 48) {
                ae();
                e3 = 0;
                break;
              } else if ((c3 | 0) == 61) {
                ae();
                e3 = 0;
                break;
              } else if ((c3 | 0) == 104) {
                e3 = (i2[806] | 0) == 0 ? (s2[401] | s2[402]) << 16 >> 16 == 0 : 0;
                break;
              }
            }
          } while (0);
          n2 = h3;
          return e3 | 0;
        }
        function k3(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0, b3 = 0, k4 = 0, o3 = 0, h3 = 0, A2 = 0, p2 = 0, y2 = 0, m2 = 0, O2 = 0, T2 = 0;
          y2 = s2[402] | 0;
          a3 = f2[73] | 0;
          f2[70] = a3;
          k4 = a3;
          p2 = a3;
          o3 = y2;
          A2 = 0;
          e: while (1) {
            r3 = f2[74] | 0;
            t3 = o3 << 16 >> 16 == y2 << 16 >> 16;
            c3 = A2 & e3;
            b3 = a3;
            while (1) {
              n3 = b3 + 2 | 0;
              if (b3 >>> 0 >= r3 >>> 0) {
                a3 = 0;
                h3 = 100;
                break e;
              }
              a3 = s2[n3 >> 1] | 0;
              if (!(M(a3) | 0)) {
                if (t3) {
                  switch (a3 << 16 >> 16) {
                    case 125:
                    case 93:
                    case 41:
                    case 59:
                    case 44: {
                      h3 = 100;
                      break e;
                    }
                    default: {
                    }
                  }
                  if (c3 ? be(a3) | 0 : 0) {
                    h3 = 100;
                    break e;
                  }
                }
                if (!(be(a3) | 0)) break;
              }
              b3 = n3;
            }
            f2[73] = n3;
            a: do {
              switch (a3 << 16 >> 16) {
                case 101: {
                  if ((o3 << 16 >> 16 == 0 ? R(n3) | 0 : 0) ? (S(b3 + 4 | 0, 16, 10) | 0) == 0 : 0) {
                    u3();
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 105: {
                  if (((s2[b3 + 4 >> 1] | 0) == 109 ? R(n3) | 0 : 0) ? (S(b3 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                    l3();
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 99: {
                  if ((((s2[b3 + 4 >> 1] | 0) == 108 ? R(n3) | 0 : 0) ? (S(b3 + 6 | 0, 88, 6) | 0) == 0 : 0) ? L(s2[b3 + 12 >> 1] | 0) | 0 : 0) {
                    i2[810] = 1;
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 40: {
                  b3 = f2[71] | 0;
                  h3 = o3 & 65535;
                  f2[b3 + (h3 << 3) >> 2] = 1;
                  s2[402] = o3 + 1 << 16 >> 16;
                  f2[b3 + (h3 << 3) + 4 >> 2] = k4;
                  h3 = 89;
                  break;
                }
                case 91: {
                  b3 = f2[71] | 0;
                  h3 = o3 & 65535;
                  f2[b3 + (h3 << 3) >> 2] = 8;
                  s2[402] = o3 + 1 << 16 >> 16;
                  f2[b3 + (h3 << 3) + 4 >> 2] = k4;
                  h3 = 89;
                  break;
                }
                case 93:
                  if (!(o3 << 16 >> 16)) {
                    ae();
                    break a;
                  } else {
                    s2[402] = o3 + -1 << 16 >> 16;
                    h3 = 89;
                    break a;
                  }
                case 44: {
                  r3 = s2[401] | 0;
                  if ((!(o3 << 16 >> 16 == 0 | r3 << 16 >> 16 == 0) ? (f2[(f2[71] | 0) + ((o3 & 65535) + -1 << 3) >> 2] | 0) == 5 : 0) ? (m2 = f2[(f2[72] | 0) + ((r3 & 65535) + -1 << 2) >> 2] | 0, (f2[m2 + 4 >> 2] | 0) == 0) : 0) {
                    f2[m2 + 4 >> 2] = p2 + 2;
                    f2[73] = b3 + 4;
                    v2(1) | 0;
                    h3 = f2[73] | 0;
                    f2[m2 + 16 >> 2] = h3;
                    f2[73] = h3 + -2;
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 41: {
                  if (!(o3 << 16 >> 16)) {
                    ae();
                    break a;
                  }
                  h3 = o3 + -1 << 16 >> 16;
                  s2[402] = h3;
                  r3 = s2[401] | 0;
                  if (r3 << 16 >> 16 != 0 ? (f2[(f2[71] | 0) + ((h3 & 65535) << 3) >> 2] | 0) == 5 : 0) {
                    c3 = f2[(f2[72] | 0) + ((r3 & 65535) + -1 << 2) >> 2] | 0;
                    if (!(f2[c3 + 4 >> 2] | 0)) f2[c3 + 4 >> 2] = p2 + 2;
                    f2[c3 + 12 >> 2] = b3 + 4;
                    s2[401] = r3 + -1 << 16 >> 16;
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 123: {
                  h3 = f2[62] | 0;
                  do {
                    if ((s2[p2 >> 1] | 0) == 41 & (h3 | 0) != 0 ? (f2[h3 + 12 >> 2] | 0) == (p2 + 2 | 0) : 0) {
                      r3 = f2[63] | 0;
                      f2[62] = r3;
                      if (!r3) {
                        f2[58] = 0;
                        break;
                      } else {
                        f2[r3 + 36 >> 2] = 0;
                        break;
                      }
                    }
                  } while (0);
                  b3 = f2[71] | 0;
                  h3 = o3 & 65535;
                  f2[b3 + (h3 << 3) >> 2] = (i2[810] | 0) == 0 ? 2 : 6;
                  s2[402] = o3 + 1 << 16 >> 16;
                  f2[b3 + (h3 << 3) + 4 >> 2] = k4;
                  i2[810] = 0;
                  h3 = 89;
                  break;
                }
                case 125: {
                  if (!(o3 << 16 >> 16)) {
                    ae();
                    break a;
                  }
                  k4 = f2[71] | 0;
                  h3 = o3 + -1 << 16 >> 16;
                  s2[402] = h3;
                  if ((f2[k4 + ((h3 & 65535) << 3) >> 2] | 0) == 4) {
                    d2();
                    h3 = 89;
                  } else h3 = 89;
                  break;
                }
                case 34:
                case 39: {
                  C(a3);
                  h3 = 89;
                  break;
                }
                case 47:
                  switch (s2[b3 + 4 >> 1] | 0) {
                    case 47: {
                      F();
                      break a;
                    }
                    case 42: {
                      x(1);
                      break a;
                    }
                    default: {
                      c3 = s2[p2 >> 1] | 0;
                      r: do {
                        if (!($(c3) | 0)) {
                          if (!(c3 << 16 >> 16 == 41 ? K(f2[(f2[71] | 0) + ((o3 & 65535) << 3) + 4 >> 2] | 0) | 0 : 0)) h3 = 62;
                        } else switch (c3 << 16 >> 16) {
                          case 46:
                            if (((s2[p2 + -2 >> 1] | 0) + -48 & 65535) < 10) {
                              h3 = 62;
                              break r;
                            } else break r;
                          case 43:
                            if ((s2[p2 + -2 >> 1] | 0) == 43) {
                              h3 = 62;
                              break r;
                            } else break r;
                          case 45:
                            if ((s2[p2 + -2 >> 1] | 0) == 45) {
                              h3 = 62;
                              break r;
                            } else break r;
                          default:
                            break r;
                        }
                      } while (0);
                      r: do {
                        if ((h3 | 0) == 62) {
                          h3 = 0;
                          if (o3 << 16 >> 16 != 0 ? (O2 = f2[71] | 0, T2 = (o3 & 65535) + -1 | 0, c3 << 16 >> 16 == 102 ? (f2[O2 + (T2 << 3) >> 2] | 0) == 1 : 0) : 0) {
                            if (((s2[p2 + -2 >> 1] | 0) == 111 ? g(p2 + -4 | 0) | 0 : 0) ? E(f2[O2 + (T2 << 3) + 4 >> 2] | 0, 196, 3) | 0 : 0) break;
                          } else h3 = 67;
                          if ((h3 | 0) == 67 ? (0, c3 << 16 >> 16 == 125) : 0) {
                            t3 = f2[71] | 0;
                            r3 = o3 & 65535;
                            if (U(f2[t3 + (r3 << 3) + 4 >> 2] | 0) | 0) break;
                            if ((f2[t3 + (r3 << 3) >> 2] | 0) == 6) break;
                          }
                          if (!(w2(p2) | 0)) {
                            switch (c3 << 16 >> 16) {
                              case 0:
                                break r;
                              case 47: {
                                if (i2[809] | 0) break r;
                                break;
                              }
                              default: {
                              }
                            }
                            h3 = f2[64] | 0;
                            if ((h3 | 0 ? p2 >>> 0 >= (f2[h3 >> 2] | 0) >>> 0 : 0) ? p2 >>> 0 <= (f2[h3 + 4 >> 2] | 0) >>> 0 : 0) {
                              I();
                              i2[809] = 0;
                              h3 = 89;
                              break a;
                            }
                            t3 = f2[3] | 0;
                            r3 = p2;
                            do {
                              if (r3 >>> 0 <= t3 >>> 0) break;
                              r3 = r3 + -2 | 0;
                              f2[70] = r3;
                              c3 = s2[r3 >> 1] | 0;
                            } while (!(D(c3) | 0));
                            if (M(c3) | 0) {
                              do {
                                if (r3 >>> 0 <= t3 >>> 0) break;
                                r3 = r3 + -2 | 0;
                                f2[70] = r3;
                              } while (M(s2[r3 >> 1] | 0) | 0);
                              if (q(r3) | 0) {
                                I();
                                i2[809] = 0;
                                h3 = 89;
                                break a;
                              }
                            }
                            i2[809] = 1;
                            h3 = 89;
                            break a;
                          }
                        }
                      } while (0);
                      I();
                      i2[809] = 0;
                      h3 = 89;
                      break a;
                    }
                  }
                case 96: {
                  b3 = f2[71] | 0;
                  h3 = o3 & 65535;
                  f2[b3 + (h3 << 3) + 4 >> 2] = k4;
                  s2[402] = o3 + 1 << 16 >> 16;
                  f2[b3 + (h3 << 3) >> 2] = 3;
                  d2();
                  h3 = 89;
                  break;
                }
                default:
                  h3 = 89;
              }
            } while (0);
            if ((h3 | 0) == 89) {
              h3 = 0;
              f2[70] = f2[73];
            }
            if (i2[806] | 0) {
              a3 = 0;
              break;
            }
            r3 = f2[70] | 0;
            a: do {
              if ((r3 | 0) == (p2 | 0)) if (A2 & ((s2[402] | 0) == y2 << 16 >> 16 & e3)) {
                a3 = s2[f2[73] >> 1] | 0;
                if (be(a3) | 0) break e;
                else a3 = 1;
              } else a3 = A2;
              else {
                if (a3 << 16 >> 16 == 47) {
                  a3 = (i2[809] | 0) == 0;
                  break;
                }
                if (G(a3) | 0) a3 = 1;
                else {
                  switch (a3 << 16 >> 16) {
                    case 96:
                    case 34:
                    case 39:
                    case 41:
                    case 93:
                    case 125: {
                      a3 = 1;
                      break a;
                    }
                    default: {
                    }
                  }
                  a3 = 0;
                }
              }
            } while (0);
            k4 = r3;
            p2 = r3;
            o3 = s2[402] | 0;
            A2 = a3;
            a3 = f2[73] | 0;
          }
          if ((h3 | 0) == 100) f2[73] = n3;
          return a3 | 0;
        }
        function l3() {
          var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0;
          n3 = f2[73] | 0;
          f2[73] = n3 + 12;
          e3 = v2(1) | 0;
          r3 = f2[73] | 0;
          e: do {
            if (e3 << 16 >> 16 != 46) {
              if (!(e3 << 16 >> 16 == 115 & r3 >>> 0 > (n3 + 12 | 0) >>> 0)) {
                if (!(e3 << 16 >> 16 == 100 & r3 >>> 0 > (n3 + 10 | 0) >>> 0)) {
                  r3 = 0;
                  t3 = 28;
                  break;
                }
                if (S(r3 + 2 | 0, 50, 8) | 0) {
                  a3 = r3;
                  e3 = 100;
                  r3 = 0;
                  t3 = 60;
                  break;
                }
                if (!(L(s2[r3 + 10 >> 1] | 0) | 0)) {
                  a3 = r3;
                  e3 = 100;
                  r3 = 0;
                  t3 = 60;
                  break;
                }
                f2[73] = r3 + 10;
                e3 = v2(1) | 0;
                if (e3 << 16 >> 16 == 42) {
                  e3 = 42;
                  c3 = 2;
                  t3 = 62;
                  break;
                }
                f2[73] = r3;
                r3 = 0;
                t3 = 28;
                break;
              }
              if ((S(r3 + 2 | 0, 40, 10) | 0) == 0 ? L(s2[r3 + 12 >> 1] | 0) | 0 : 0) {
                f2[73] = r3 + 12;
                e3 = v2(1) | 0;
                a3 = f2[73] | 0;
                if ((a3 | 0) != (r3 + 12 | 0)) {
                  if (e3 << 16 >> 16 != 102) {
                    r3 = 1;
                    t3 = 28;
                    break;
                  }
                  if (S(a3 + 2 | 0, 58, 6) | 0) {
                    e3 = 102;
                    r3 = 1;
                    t3 = 60;
                    break;
                  }
                  if (!(D(s2[a3 + 8 >> 1] | 0) | 0)) {
                    e3 = 102;
                    r3 = 1;
                    t3 = 60;
                    break;
                  }
                }
                f2[73] = r3;
                r3 = 0;
                t3 = 28;
              } else {
                a3 = r3;
                e3 = 115;
                r3 = 0;
                t3 = 60;
              }
            } else {
              f2[73] = r3 + 2;
              switch ((v2(1) | 0) << 16 >> 16) {
                case 109: {
                  e3 = f2[73] | 0;
                  if (S(e3 + 2 | 0, 34, 6) | 0) break e;
                  a3 = f2[70] | 0;
                  if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                  A(n3, n3, e3 + 8 | 0, 2);
                  break e;
                }
                case 115: {
                  e3 = f2[73] | 0;
                  if (S(e3 + 2 | 0, 40, 10) | 0) break e;
                  a3 = f2[70] | 0;
                  if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                  f2[73] = e3 + 12;
                  e3 = v2(1) | 0;
                  r3 = 1;
                  t3 = 28;
                  break e;
                }
                case 100: {
                  e3 = f2[73] | 0;
                  if (S(e3 + 2 | 0, 50, 8) | 0) break e;
                  a3 = f2[70] | 0;
                  if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                  f2[73] = e3 + 10;
                  e3 = v2(1) | 0;
                  r3 = 2;
                  t3 = 28;
                  break e;
                }
                default:
                  break e;
              }
            }
          } while (0);
          e: do {
            if ((t3 | 0) == 28) {
              if (e3 << 16 >> 16 == 40) {
                a3 = f2[71] | 0;
                c3 = s2[402] | 0;
                f2[a3 + ((c3 & 65535) << 3) >> 2] = 5;
                e3 = f2[73] | 0;
                s2[402] = c3 + 1 << 16 >> 16;
                f2[a3 + ((c3 & 65535) << 3) + 4 >> 2] = e3;
                if ((s2[f2[70] >> 1] | 0) == 46) break;
                f2[73] = e3 + 2;
                a3 = v2(1) | 0;
                A(n3, f2[73] | 0, 0, e3);
                if (!r3) e3 = f2[62] | 0;
                else {
                  e3 = f2[62] | 0;
                  f2[e3 + 28 >> 2] = (r3 | 0) == 1 ? 5 : 7;
                }
                c3 = f2[72] | 0;
                n3 = s2[401] | 0;
                s2[401] = n3 + 1 << 16 >> 16;
                f2[c3 + ((n3 & 65535) << 2) >> 2] = e3;
                switch (a3 << 16 >> 16) {
                  case 39: {
                    C(39);
                    break;
                  }
                  case 34: {
                    C(34);
                    break;
                  }
                  case 96: {
                    if (!(y() | 0)) t3 = 37;
                    break;
                  }
                  default:
                    t3 = 37;
                }
                if ((t3 | 0) == 37) {
                  f2[73] = (f2[73] | 0) + -2;
                  break;
                }
                e3 = (f2[73] | 0) + 2 | 0;
                f2[73] = e3;
                switch ((v2(1) | 0) << 16 >> 16) {
                  case 44: {
                    f2[73] = (f2[73] | 0) + 2;
                    v2(1) | 0;
                    c3 = f2[62] | 0;
                    f2[c3 + 4 >> 2] = e3;
                    n3 = f2[73] | 0;
                    f2[c3 + 16 >> 2] = n3;
                    i2[c3 + 24 >> 0] = 1;
                    f2[73] = n3 + -2;
                    break e;
                  }
                  case 41: {
                    s2[402] = (s2[402] | 0) + -1 << 16 >> 16;
                    n3 = f2[62] | 0;
                    f2[n3 + 4 >> 2] = e3;
                    f2[n3 + 12 >> 2] = (f2[73] | 0) + 2;
                    i2[n3 + 24 >> 0] = 1;
                    s2[401] = (s2[401] | 0) + -1 << 16 >> 16;
                    break e;
                  }
                  default: {
                    f2[73] = (f2[73] | 0) + -2;
                    break e;
                  }
                }
              }
              if (!((r3 | 0) == 0 & e3 << 16 >> 16 == 123)) {
                switch (e3 << 16 >> 16) {
                  case 42:
                  case 39:
                  case 34: {
                    c3 = r3;
                    t3 = 62;
                    break e;
                  }
                  default: {
                  }
                }
                a3 = f2[73] | 0;
                t3 = 60;
                break;
              }
              e3 = f2[73] | 0;
              if (s2[402] | 0) {
                f2[73] = e3 + -2;
                break;
              }
              while (1) {
                if (e3 >>> 0 >= (f2[74] | 0) >>> 0) break;
                e3 = v2(1) | 0;
                if (!(re(e3) | 0)) {
                  if (e3 << 16 >> 16 == 125) {
                    t3 = 50;
                    break;
                  }
                } else C(e3);
                e3 = (f2[73] | 0) + 2 | 0;
                f2[73] = e3;
              }
              if ((t3 | 0) == 50) f2[73] = (f2[73] | 0) + 2;
              c3 = (v2(1) | 0) << 16 >> 16 == 102;
              e3 = f2[73] | 0;
              if (c3 ? S(e3 + 2 | 0, 58, 6) | 0 : 0) {
                ae();
                break;
              }
              f2[73] = e3 + 8;
              e3 = v2(1) | 0;
              if (re(e3) | 0) {
                o2(n3, e3, 0);
                break;
              } else {
                ae();
                break;
              }
            }
          } while (0);
          if ((t3 | 0) == 60) if ((a3 | 0) == (n3 + 12 | 0)) f2[73] = n3 + 10;
          else {
            c3 = r3;
            t3 = 62;
          }
          do {
            if ((t3 | 0) == 62) {
              if (!((e3 << 16 >> 16 == 42 | (c3 | 0) != 2) & (s2[402] | 0) == 0)) {
                f2[73] = (f2[73] | 0) + -2;
                break;
              }
              e3 = f2[74] | 0;
              a3 = f2[73] | 0;
              while (1) {
                if (a3 >>> 0 >= e3 >>> 0) {
                  t3 = 69;
                  break;
                }
                r3 = s2[a3 >> 1] | 0;
                if (re(r3) | 0) {
                  t3 = 67;
                  break;
                }
                t3 = a3 + 2 | 0;
                f2[73] = t3;
                a3 = t3;
              }
              if ((t3 | 0) == 67) {
                o2(n3, r3, c3);
                break;
              } else if ((t3 | 0) == 69) {
                ae();
                break;
              }
            }
          } while (0);
          return;
        }
        function u3() {
          var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0, b3 = 0, l4 = 0, u4 = 0, h3 = 0;
          l4 = f2[73] | 0;
          u4 = f2[64] | 0;
          f2[73] = l4 + 12;
          a3 = v2(1) | 0;
          e3 = f2[73] | 0;
          if (!((e3 | 0) == (l4 + 12 | 0) ? !(O(a3) | 0) : 0)) h3 = 3;
          e: do {
            if ((h3 | 0) == 3) {
              f2[65] = l4;
              a: do {
                switch (a3 << 16 >> 16) {
                  case 123: {
                    f2[73] = e3 + 2;
                    e3 = v2(1) | 0;
                    a3 = f2[73] | 0;
                    while (1) {
                      if (re(e3) | 0) {
                        C(e3);
                        e3 = (f2[73] | 0) + 2 | 0;
                        f2[73] = e3;
                      } else {
                        H(e3) | 0;
                        e3 = f2[73] | 0;
                      }
                      v2(1) | 0;
                      e3 = p(a3, e3) | 0;
                      if (e3 << 16 >> 16 == 44) {
                        f2[73] = (f2[73] | 0) + 2;
                        e3 = v2(1) | 0;
                      }
                      if (e3 << 16 >> 16 == 125) {
                        h3 = 15;
                        break;
                      }
                      h3 = a3;
                      a3 = f2[73] | 0;
                      if ((a3 | 0) == (h3 | 0)) {
                        h3 = 12;
                        break;
                      }
                      if (a3 >>> 0 > (f2[74] | 0) >>> 0) {
                        h3 = 14;
                        break;
                      }
                    }
                    if ((h3 | 0) == 12) {
                      ae();
                      break e;
                    } else if ((h3 | 0) == 14) {
                      ae();
                      break e;
                    } else if ((h3 | 0) == 15) {
                      i2[807] = 1;
                      f2[73] = (f2[73] | 0) + 2;
                      break a;
                    }
                    break;
                  }
                  case 42: {
                    f2[73] = e3 + 2;
                    v2(1) | 0;
                    h3 = f2[73] | 0;
                    p(h3, h3) | 0;
                    break;
                  }
                  default: {
                    i2[808] = 0;
                    switch (a3 << 16 >> 16) {
                      case 100: {
                        f2[73] = e3 + 14;
                        switch ((v2(1) | 0) << 16 >> 16) {
                          case 97: {
                            a3 = f2[73] | 0;
                            if ((S(a3 + 2 | 0, 64, 8) | 0) == 0 ? M(s2[a3 + 10 >> 1] | 0) | 0 : 0) {
                              f2[73] = a3 + 10;
                              v2(0) | 0;
                              h3 = 22;
                            }
                            break;
                          }
                          case 102: {
                            h3 = 22;
                            break;
                          }
                          case 99: {
                            a3 = f2[73] | 0;
                            if (((S(a3 + 2 | 0, 86, 8) | 0) == 0 ? (u4 = s2[a3 + 10 >> 1] | 0, L(u4) | 0 | u4 << 16 >> 16 == 123) : 0) ? (f2[73] = a3 + 10, r3 = v2(1) | 0, r3 << 16 >> 16 != 123) : 0) {
                              b3 = r3;
                              h3 = 31;
                            }
                            break;
                          }
                          default: {
                          }
                        }
                        r: do {
                          if ((h3 | 0) == 22 ? (c3 = f2[73] | 0, (S(c3 + 2 | 0, 72, 14) | 0) == 0) : 0) {
                            a3 = s2[c3 + 16 >> 1] | 0;
                            if (!(L(a3) | 0)) switch (a3 << 16 >> 16) {
                              case 40:
                              case 42:
                                break;
                              default:
                                break r;
                            }
                            f2[73] = c3 + 16;
                            a3 = v2(1) | 0;
                            if (a3 << 16 >> 16 == 42) {
                              f2[73] = (f2[73] | 0) + 2;
                              a3 = v2(1) | 0;
                            }
                            if (a3 << 16 >> 16 != 40) {
                              b3 = a3;
                              h3 = 31;
                            }
                          }
                        } while (0);
                        if ((h3 | 0) == 31 ? (t3 = f2[73] | 0, H(b3) | 0, n3 = f2[73] | 0, n3 >>> 0 > t3 >>> 0) : 0) {
                          T(e3, e3 + 14 | 0, t3, n3);
                          f2[73] = (f2[73] | 0) + -2;
                          break e;
                        }
                        T(e3, e3 + 14 | 0, 0, 0);
                        f2[73] = e3 + 12;
                        break e;
                      }
                      case 97: {
                        f2[73] = e3 + 10;
                        v2(0) | 0;
                        e3 = f2[73] | 0;
                        h3 = 35;
                        break;
                      }
                      case 102: {
                        h3 = 35;
                        break;
                      }
                      case 99: {
                        if ((S(e3 + 2 | 0, 86, 8) | 0) == 0 ? D(s2[e3 + 10 >> 1] | 0) | 0 : 0) {
                          f2[73] = e3 + 10;
                          h3 = v2(1) | 0;
                          u4 = f2[73] | 0;
                          H(h3) | 0;
                          h3 = f2[73] | 0;
                          T(u4, h3, u4, h3);
                          f2[73] = (f2[73] | 0) + -2;
                          break e;
                        }
                        f2[73] = e3 + 4;
                        e3 = e3 + 4 | 0;
                        break;
                      }
                      case 108:
                      case 118:
                        break;
                      default:
                        break e;
                    }
                    if ((h3 | 0) == 35) {
                      f2[73] = e3 + 16;
                      e3 = v2(1) | 0;
                      if (e3 << 16 >> 16 == 42) {
                        f2[73] = (f2[73] | 0) + 2;
                        e3 = v2(1) | 0;
                      }
                      u4 = f2[73] | 0;
                      H(e3) | 0;
                      h3 = f2[73] | 0;
                      T(u4, h3, u4, h3);
                      f2[73] = (f2[73] | 0) + -2;
                      break e;
                    }
                    f2[73] = e3 + 6;
                    i2[808] = 0;
                    while (1) {
                      a3 = v2(1) | 0;
                      e3 = f2[73] | 0;
                      if (e3 >>> 0 > (f2[74] | 0) >>> 0) break;
                      a3 = P(a3) | 0;
                      if ((f2[73] | 0) == (e3 | 0)) break;
                      if (a3 << 16 >> 16 == 61) a3 = k3(1) | 0;
                      e3 = f2[73] | 0;
                      if (a3 << 16 >> 16 != 44) break;
                      f2[73] = e3 + 2;
                    }
                    f2[73] = e3 + -2;
                    break e;
                  }
                }
              } while (0);
              h3 = (v2(1) | 0) << 16 >> 16 == 102;
              e3 = f2[73] | 0;
              if (h3 ? (S(e3 + 2 | 0, 58, 6) | 0) == 0 : 0) {
                f2[73] = e3 + 8;
                o2(l4, v2(1) | 0, 0);
                e3 = (u4 | 0) == 0 ? 236 : u4 + 20 | 0;
                while (1) {
                  e3 = f2[e3 >> 2] | 0;
                  if (!e3) break e;
                  f2[e3 + 12 >> 2] = 0;
                  f2[e3 + 8 >> 2] = 0;
                  e3 = e3 + 20 | 0;
                }
              }
              f2[73] = e3 + -2;
            }
          } while (0);
          return;
        }
        function o2(e3, a3, r3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          r3 = r3 | 0;
          var i3 = 0, c3 = 0, t3 = 0, n3 = 0, b3 = 0;
          i3 = (f2[73] | 0) + 2 | 0;
          switch (a3 << 16 >> 16) {
            case 39: {
              C(39);
              c3 = 5;
              break;
            }
            case 34: {
              C(34);
              c3 = 5;
              break;
            }
            default:
              ae();
          }
          do {
            if ((c3 | 0) == 5) {
              A(e3, i3, f2[73] | 0, 1);
              if ((r3 | 0) > 0) f2[(f2[62] | 0) + 28 >> 2] = (r3 | 0) == 1 ? 4 : 6;
              f2[73] = (f2[73] | 0) + 2;
              n3 = (v2(0) | 0) << 16 >> 16 == 119;
              t3 = f2[73] | 0;
              if (((n3 ? (s2[t3 + 2 >> 1] | 0) == 105 : 0) ? (s2[t3 + 4 >> 1] | 0) == 116 : 0) ? (s2[t3 + 6 >> 1] | 0) == 104 : 0) {
                f2[73] = t3 + 8;
                if ((v2(1) | 0) << 16 >> 16 != 123) {
                  f2[73] = t3;
                  break;
                }
                n3 = f2[73] | 0;
                i3 = n3;
                c3 = 0;
                e: while (1) {
                  f2[73] = i3 + 2;
                  i3 = v2(1) | 0;
                  do {
                    if (i3 << 16 >> 16 != 39) {
                      a3 = f2[73] | 0;
                      if (i3 << 16 >> 16 == 34) {
                        C(34);
                        e3 = (f2[73] | 0) + 2 | 0;
                        f2[73] = e3;
                        i3 = v2(1) | 0;
                        break;
                      } else {
                        i3 = H(i3) | 0;
                        e3 = f2[73] | 0;
                        break;
                      }
                    } else {
                      a3 = f2[73] | 0;
                      C(39);
                      e3 = (f2[73] | 0) + 2 | 0;
                      f2[73] = e3;
                      i3 = v2(1) | 0;
                    }
                  } while (0);
                  if (i3 << 16 >> 16 != 58) {
                    c3 = 21;
                    break;
                  }
                  f2[73] = (f2[73] | 0) + 2;
                  switch ((v2(1) | 0) << 16 >> 16) {
                    case 39: {
                      i3 = f2[73] | 0;
                      C(39);
                      break;
                    }
                    case 34: {
                      i3 = f2[73] | 0;
                      C(34);
                      break;
                    }
                    default: {
                      c3 = 25;
                      break e;
                    }
                  }
                  b3 = (f2[73] | 0) + 2 | 0;
                  r3 = f2[67] | 0;
                  f2[67] = r3 + 20;
                  f2[r3 >> 2] = a3;
                  f2[r3 + 4 >> 2] = e3;
                  f2[r3 + 8 >> 2] = i3;
                  f2[r3 + 12 >> 2] = b3;
                  f2[r3 + 16 >> 2] = 0;
                  f2[((c3 | 0) == 0 ? (f2[62] | 0) + 32 | 0 : c3 + 16 | 0) >> 2] = r3;
                  f2[73] = (f2[73] | 0) + 2;
                  switch ((v2(1) | 0) << 16 >> 16) {
                    case 125: {
                      c3 = 29;
                      break e;
                    }
                    case 44:
                      break;
                    default: {
                      c3 = 27;
                      break e;
                    }
                  }
                  i3 = (f2[73] | 0) + 2 | 0;
                  f2[73] = i3;
                  c3 = r3;
                }
                if ((c3 | 0) == 21) {
                  f2[73] = t3;
                  break;
                } else if ((c3 | 0) == 25) {
                  f2[73] = t3;
                  break;
                } else if ((c3 | 0) == 27) {
                  f2[73] = t3;
                  break;
                } else if ((c3 | 0) == 29) {
                  b3 = f2[62] | 0;
                  f2[b3 + 16 >> 2] = n3;
                  f2[b3 + 12 >> 2] = (f2[73] | 0) + 2;
                  break;
                }
              }
              f2[73] = t3 + -2;
            }
          } while (0);
          return;
        }
        function h2() {
          var e3 = 0, a3 = 0, r3 = 0, i3 = 0, c3 = 0, t3 = 0, n3 = 0;
          e3 = f2[73] | 0;
          c3 = (s2[e3 >> 1] | 0) == 123;
          f2[73] = e3 + 2;
          e3 = v2(1) | 0;
          t3 = c3 ? 125 : 93;
          e: while (1) {
            if ((t3 | 0) == (e3 & 65535 | 0)) break;
            i3 = f2[73] | 0;
            if (i3 >>> 0 > (f2[74] | 0) >>> 0) break;
            if ((e3 << 16 >> 16 == 46 ? (s2[i3 + 2 >> 1] | 0) == 46 : 0) ? (s2[i3 + 4 >> 1] | 0) == 46 : 0) {
              f2[73] = i3 + 6;
              e3 = P(v2(1) | 0) | 0;
            } else n3 = 9;
            a: do {
              if ((n3 | 0) == 9) {
                n3 = 0;
                do {
                  if (c3) {
                    do {
                      if (e3 << 16 >> 16 == 91) {
                        k3(0) | 0;
                        f2[73] = (f2[73] | 0) + 2;
                        a3 = i3;
                      } else {
                        if (re(e3) | 0) {
                          C(e3);
                          f2[73] = (f2[73] | 0) + 2;
                          a3 = i3;
                          break;
                        }
                        if ((e3 + -48 & 65535) >= 10) {
                          H(e3) | 0;
                          a3 = f2[73] | 0;
                          break;
                        }
                        e3 = i3;
                        r: while (1) {
                          r3 = e3 + 2 | 0;
                          a3 = s2[r3 >> 1] | 0;
                          i: do {
                            if ((a3 + -48 & 65535) >= 10) {
                              switch (a3 << 16 >> 16) {
                                case 67:
                                case 68:
                                case 70:
                                case 97:
                                case 65:
                                case 99:
                                case 100:
                                case 102:
                                case 46:
                                case 66:
                                case 69:
                                case 79:
                                case 88:
                                case 95:
                                case 98:
                                case 101:
                                case 110:
                                case 111:
                                case 120:
                                  break i;
                                case 43:
                                case 45:
                                  break;
                                default:
                                  break r;
                              }
                              switch (s2[e3 >> 1] | 0) {
                                case 69:
                                case 101:
                                  break;
                                default:
                                  break r;
                              }
                            }
                          } while (0);
                          e3 = r3;
                        }
                        f2[73] = r3;
                        a3 = i3;
                      }
                    } while (0);
                    e3 = v2(1) | 0;
                    if (e3 << 16 >> 16 == 58) {
                      f2[73] = (f2[73] | 0) + 2;
                      e3 = P(v2(1) | 0) | 0;
                      break;
                    }
                    if (a3 >>> 0 > i3 >>> 0) T(i3, a3, i3, a3);
                  } else if (e3 << 16 >> 16 == 44) {
                    f2[73] = i3 + 2;
                    e3 = v2(1) | 0;
                    break a;
                  } else {
                    e3 = P(e3) | 0;
                    break;
                  }
                } while (0);
                if (e3 << 16 >> 16 == 61) e3 = k3(0) | 0;
                if (e3 << 16 >> 16 != 44) break e;
                f2[73] = (f2[73] | 0) + 2;
                e3 = v2(1) | 0;
              }
            } while (0);
          }
          return;
        }
        function w2(e3) {
          e3 = e3 | 0;
          e: do {
            switch (s2[e3 >> 1] | 0) {
              case 100:
                switch (s2[e3 + -2 >> 1] | 0) {
                  case 105: {
                    e3 = E(e3 + -4 | 0, 94, 2) | 0;
                    break e;
                  }
                  case 108: {
                    e3 = E(e3 + -4 | 0, 98, 3) | 0;
                    break e;
                  }
                  default: {
                    e3 = 0;
                    break e;
                  }
                }
              case 101:
                switch (s2[e3 + -2 >> 1] | 0) {
                  case 115:
                    switch (s2[e3 + -4 >> 1] | 0) {
                      case 108: {
                        e3 = z(e3 + -6 | 0, 101) | 0;
                        break e;
                      }
                      case 97: {
                        e3 = z(e3 + -6 | 0, 99) | 0;
                        break e;
                      }
                      default: {
                        e3 = 0;
                        break e;
                      }
                    }
                  case 116: {
                    e3 = E(e3 + -4 | 0, 104, 4) | 0;
                    break e;
                  }
                  case 117: {
                    e3 = E(e3 + -4 | 0, 112, 6) | 0;
                    break e;
                  }
                  default: {
                    e3 = 0;
                    break e;
                  }
                }
              case 102: {
                if ((s2[e3 + -2 >> 1] | 0) == 111 ? (s2[e3 + -4 >> 1] | 0) == 101 : 0) switch (s2[e3 + -6 >> 1] | 0) {
                  case 99: {
                    e3 = E(e3 + -8 | 0, 124, 6) | 0;
                    break e;
                  }
                  case 112: {
                    e3 = E(e3 + -8 | 0, 136, 2) | 0;
                    break e;
                  }
                  default: {
                    e3 = 0;
                    break e;
                  }
                }
                else e3 = 0;
                break;
              }
              case 107: {
                e3 = E(e3 + -2 | 0, 140, 4) | 0;
                break;
              }
              case 110: {
                if (z(e3 + -2 | 0, 105) | 0) e3 = 1;
                else e3 = E(e3 + -2 | 0, 148, 5) | 0;
                break;
              }
              case 111: {
                e3 = z(e3 + -2 | 0, 100) | 0;
                break;
              }
              case 114: {
                e3 = E(e3 + -2 | 0, 158, 7) | 0;
                break;
              }
              case 116: {
                e3 = E(e3 + -2 | 0, 172, 4) | 0;
                break;
              }
              case 119:
                switch (s2[e3 + -2 >> 1] | 0) {
                  case 101: {
                    e3 = z(e3 + -4 | 0, 110) | 0;
                    break e;
                  }
                  case 111: {
                    e3 = E(e3 + -4 | 0, 180, 3) | 0;
                    break e;
                  }
                  default: {
                    e3 = 0;
                    break e;
                  }
                }
              default:
                e3 = 0;
            }
          } while (0);
          return e3 | 0;
        }
        function d2() {
          var e3 = 0, a3 = 0, r3 = 0;
          a3 = f2[74] | 0;
          r3 = f2[73] | 0;
          e: while (1) {
            e3 = r3 + 2 | 0;
            if (r3 >>> 0 >= a3 >>> 0) {
              a3 = 10;
              break;
            }
            switch (s2[e3 >> 1] | 0) {
              case 96: {
                a3 = 7;
                break e;
              }
              case 36: {
                if ((s2[r3 + 4 >> 1] | 0) == 123) {
                  a3 = 6;
                  break e;
                }
                break;
              }
              case 92: {
                e3 = r3 + 4 | 0;
                break;
              }
              default: {
              }
            }
            r3 = e3;
          }
          if ((a3 | 0) == 6) {
            e3 = r3 + 4 | 0;
            f2[73] = e3;
            a3 = f2[71] | 0;
            r3 = s2[402] | 0;
            f2[a3 + ((r3 & 65535) << 3) >> 2] = 4;
            s2[402] = r3 + 1 << 16 >> 16;
            f2[a3 + ((r3 & 65535) << 3) + 4 >> 2] = e3;
          } else if ((a3 | 0) == 7) {
            f2[73] = e3;
            a3 = f2[71] | 0;
            r3 = (s2[402] | 0) + -1 << 16 >> 16;
            s2[402] = r3;
            if ((f2[a3 + ((r3 & 65535) << 3) >> 2] | 0) != 3) ae();
          } else if ((a3 | 0) == 10) {
            f2[73] = e3;
            ae();
          }
          return;
        }
        function v2(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0, i3 = 0;
          r3 = f2[73] | 0;
          e: do {
            a3 = s2[r3 >> 1] | 0;
            a: do {
              if (a3 << 16 >> 16 != 47) if (e3) if (L(a3) | 0) break;
              else break e;
              else if (M(a3) | 0) break;
              else break e;
              else switch (s2[r3 + 2 >> 1] | 0) {
                case 47: {
                  F();
                  break a;
                }
                case 42: {
                  x(e3);
                  break a;
                }
                default: {
                  a3 = 47;
                  break e;
                }
              }
            } while (0);
            i3 = f2[73] | 0;
            r3 = i3 + 2 | 0;
            f2[73] = r3;
          } while (i3 >>> 0 < (f2[74] | 0) >>> 0);
          return a3 | 0;
        }
        function A(e3, a3, r3, s3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          r3 = r3 | 0;
          s3 = s3 | 0;
          var c3 = 0, t3 = 0;
          t3 = f2[67] | 0;
          f2[67] = t3 + 40;
          c3 = f2[62] | 0;
          f2[((c3 | 0) == 0 ? 232 : c3 + 36 | 0) >> 2] = t3;
          f2[63] = c3;
          f2[62] = t3;
          f2[t3 + 8 >> 2] = e3;
          if (2 == (s3 | 0)) {
            e3 = 3;
            c3 = r3;
          } else {
            e3 = 1 == (s3 | 0) ? 1 : 2;
            c3 = 1 == (s3 | 0) ? r3 + 2 | 0 : 0;
          }
          f2[t3 + 12 >> 2] = c3;
          f2[t3 + 28 >> 2] = e3;
          f2[t3 >> 2] = a3;
          f2[t3 + 4 >> 2] = r3;
          f2[t3 + 16 >> 2] = 0;
          f2[t3 + 20 >> 2] = s3;
          i2[t3 + 24 >> 0] = 1 == (s3 | 0) & 1;
          f2[t3 + 32 >> 2] = 0;
          f2[t3 + 36 >> 2] = 0;
          if (1 == (s3 | 0) | 2 == (s3 | 0)) i2[807] = 1;
          return;
        }
        function C(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0, i3 = 0, c3 = 0;
          c3 = f2[74] | 0;
          a3 = f2[73] | 0;
          while (1) {
            i3 = a3 + 2 | 0;
            if (a3 >>> 0 >= c3 >>> 0) {
              a3 = 9;
              break;
            }
            r3 = s2[i3 >> 1] | 0;
            if (r3 << 16 >> 16 == e3 << 16 >> 16) {
              a3 = 10;
              break;
            }
            if (r3 << 16 >> 16 == 92) {
              r3 = a3 + 4 | 0;
              if ((s2[r3 >> 1] | 0) == 13) {
                a3 = a3 + 6 | 0;
                a3 = (s2[a3 >> 1] | 0) == 10 ? a3 : r3;
              } else a3 = r3;
            } else if (be(r3) | 0) {
              a3 = 9;
              break;
            } else a3 = i3;
          }
          if ((a3 | 0) == 9) {
            f2[73] = i3;
            ae();
          } else if ((a3 | 0) == 10) f2[73] = i3;
          return;
        }
        function g(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0;
          a3 = s2[e3 >> 1] | 0;
          if (L(a3) | 0) r3 = 3;
          else switch (a3 << 16 >> 16) {
            case 41:
            case 125:
            case 93: {
              r3 = 3;
              break;
            }
            default:
              e3 = 0;
          }
          e: do {
            if ((r3 | 0) == 3) {
              r3 = f2[3] | 0;
              while (1) {
                if (e3 >>> 0 <= r3 >>> 0) break;
                e3 = e3 + -2 | 0;
                if (!(L(a3) | 0)) break;
                a3 = s2[e3 >> 1] | 0;
              }
              switch (a3 << 16 >> 16) {
                case 41:
                case 125:
                case 93: {
                  e3 = 1;
                  break e;
                }
                default: {
                }
              }
              e3 = (O(a3) | 0) ^ 1;
            }
          } while (0);
          return e3 | 0;
        }
        function p(e3, a3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          var r3 = 0, i3 = 0, c3 = 0, t3 = 0;
          r3 = f2[73] | 0;
          i3 = s2[r3 >> 1] | 0;
          c3 = (e3 | 0) == (a3 | 0) ? 0 : e3;
          t3 = (e3 | 0) == (a3 | 0) ? 0 : a3;
          if (i3 << 16 >> 16 == 97) {
            f2[73] = r3 + 4;
            r3 = v2(1) | 0;
            e3 = f2[73] | 0;
            if (re(r3) | 0) {
              C(r3);
              a3 = (f2[73] | 0) + 2 | 0;
              f2[73] = a3;
            } else {
              H(r3) | 0;
              a3 = f2[73] | 0;
            }
            i3 = v2(1) | 0;
            r3 = f2[73] | 0;
          }
          if ((r3 | 0) != (e3 | 0)) T(e3, a3, c3, t3);
          return i3 | 0;
        }
        function y() {
          var e3 = 0, a3 = 0, r3 = 0, i3 = 0;
          i3 = f2[73] | 0;
          r3 = f2[74] | 0;
          a3 = i3;
          e: while (1) {
            e3 = a3 + 2 | 0;
            if (a3 >>> 0 >= r3 >>> 0) {
              a3 = 7;
              break;
            }
            switch (s2[e3 >> 1] | 0) {
              case 96: {
                a3 = 8;
                break e;
              }
              case 92: {
                e3 = a3 + 4 | 0;
                break;
              }
              case 36: {
                if ((s2[a3 + 4 >> 1] | 0) == 123) {
                  a3 = 7;
                  break e;
                }
                break;
              }
              default: {
              }
            }
            a3 = e3;
          }
          if ((a3 | 0) == 7) {
            f2[73] = i3;
            e3 = 0;
          } else if ((a3 | 0) == 8) {
            f2[73] = e3;
            e3 = 1;
          }
          return e3 | 0;
        }
        function m() {
          var e3 = 0, a3 = 0, r3 = 0;
          r3 = f2[74] | 0;
          a3 = f2[73] | 0;
          e: while (1) {
            e3 = a3 + 2 | 0;
            if (a3 >>> 0 >= r3 >>> 0) {
              a3 = 6;
              break;
            }
            switch (s2[e3 >> 1] | 0) {
              case 13:
              case 10: {
                a3 = 6;
                break e;
              }
              case 93: {
                a3 = 7;
                break e;
              }
              case 92: {
                e3 = a3 + 4 | 0;
                break;
              }
              default: {
              }
            }
            a3 = e3;
          }
          if ((a3 | 0) == 6) {
            f2[73] = e3;
            ae();
            e3 = 0;
          } else if ((a3 | 0) == 7) {
            f2[73] = e3;
            e3 = 93;
          }
          return e3 | 0;
        }
        function I() {
          var e3 = 0, a3 = 0;
          e: while (1) {
            e3 = f2[73] | 0;
            f2[73] = e3 + 2;
            if (e3 >>> 0 >= (f2[74] | 0) >>> 0) {
              a3 = 7;
              break;
            }
            switch (s2[e3 + 2 >> 1] | 0) {
              case 13:
              case 10: {
                a3 = 7;
                break e;
              }
              case 47:
                break e;
              case 91: {
                m() | 0;
                break;
              }
              case 92: {
                f2[73] = e3 + 4;
                break;
              }
              default: {
              }
            }
          }
          if ((a3 | 0) == 7) ae();
          return;
        }
        function U(e3) {
          e3 = e3 | 0;
          switch (s2[e3 >> 1] | 0) {
            case 62: {
              e3 = (s2[e3 + -2 >> 1] | 0) == 61;
              break;
            }
            case 41:
            case 59: {
              e3 = 1;
              break;
            }
            case 104: {
              e3 = E(e3 + -2 | 0, 206, 4) | 0;
              break;
            }
            case 121: {
              e3 = E(e3 + -2 | 0, 214, 6) | 0;
              break;
            }
            case 101: {
              e3 = E(e3 + -2 | 0, 226, 3) | 0;
              break;
            }
            default:
              e3 = 0;
          }
          return e3 | 0;
        }
        function x(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0, i3 = 0, c3 = 0, t3 = 0;
          c3 = (f2[73] | 0) + 2 | 0;
          f2[73] = c3;
          r3 = f2[74] | 0;
          while (1) {
            a3 = c3 + 2 | 0;
            if (c3 >>> 0 >= r3 >>> 0) break;
            i3 = s2[a3 >> 1] | 0;
            if (!e3 ? be(i3) | 0 : 0) break;
            if (i3 << 16 >> 16 == 42 ? (s2[c3 + 4 >> 1] | 0) == 47 : 0) {
              t3 = 8;
              break;
            }
            c3 = a3;
          }
          if ((t3 | 0) == 8) {
            f2[73] = a3;
            a3 = c3 + 4 | 0;
          }
          f2[73] = a3;
          return;
        }
        function S(e3, a3, r3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          r3 = r3 | 0;
          var s3 = 0, f3 = 0;
          e: do {
            if (!r3) e3 = 0;
            else {
              while (1) {
                s3 = i2[e3 >> 0] | 0;
                f3 = i2[a3 >> 0] | 0;
                if (s3 << 24 >> 24 != f3 << 24 >> 24) break;
                r3 = r3 + -1 | 0;
                if (!r3) {
                  e3 = 0;
                  break e;
                } else {
                  e3 = e3 + 1 | 0;
                  a3 = a3 + 1 | 0;
                }
              }
              e3 = (s3 & 255) - (f3 & 255) | 0;
            }
          } while (0);
          return e3 | 0;
        }
        function O(e3) {
          e3 = e3 | 0;
          e: do {
            switch (e3 << 16 >> 16) {
              case 38:
              case 37:
              case 33: {
                e3 = 1;
                break;
              }
              default:
                if ((e3 & -8) << 16 >> 16 == 40 | (e3 + -58 & 65535) < 6) e3 = 1;
                else {
                  switch (e3 << 16 >> 16) {
                    case 91:
                    case 93:
                    case 94: {
                      e3 = 1;
                      break e;
                    }
                    default: {
                    }
                  }
                  e3 = (e3 + -123 & 65535) < 4;
                }
            }
          } while (0);
          return e3 | 0;
        }
        function $(e3) {
          e3 = e3 | 0;
          e: do {
            switch (e3 << 16 >> 16) {
              case 38:
              case 37:
              case 33:
                break;
              default:
                if (!((e3 + -58 & 65535) < 6 | (e3 + -40 & 65535) < 7 & e3 << 16 >> 16 != 41)) {
                  switch (e3 << 16 >> 16) {
                    case 91:
                    case 94:
                      break e;
                    default: {
                    }
                  }
                  return e3 << 16 >> 16 != 125 & (e3 + -123 & 65535) < 4 | 0;
                }
            }
          } while (0);
          return 1;
        }
        function T(e3, a3, r3, s3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          r3 = r3 | 0;
          s3 = s3 | 0;
          var c3 = 0, t3 = 0;
          c3 = f2[67] | 0;
          f2[67] = c3 + 24;
          t3 = f2[64] | 0;
          f2[((t3 | 0) == 0 ? 236 : t3 + 20 | 0) >> 2] = c3;
          f2[64] = c3;
          f2[c3 >> 2] = e3;
          f2[c3 + 4 >> 2] = a3;
          f2[c3 + 8 >> 2] = r3;
          f2[c3 + 12 >> 2] = s3;
          f2[c3 + 16 >> 2] = f2[65];
          f2[c3 + 20 >> 2] = 0;
          i2[807] = 1;
          return;
        }
        function j(e3) {
          e3 = e3 | 0;
          var a3 = 0;
          a3 = s2[e3 >> 1] | 0;
          e: do {
            if ((a3 + -9 & 65535) >= 5) {
              switch (a3 << 16 >> 16) {
                case 160:
                case 32: {
                  a3 = 1;
                  break e;
                }
                default: {
                }
              }
              if (O(a3) | 0) return a3 << 16 >> 16 != 46 | (N(e3) | 0) | 0;
              else a3 = 0;
            } else a3 = 1;
          } while (0);
          return a3 | 0;
        }
        function B(e3) {
          e3 = e3 | 0;
          var a3 = 0, r3 = 0;
          r3 = n2;
          n2 = n2 + 16 | 0;
          f2[r3 >> 2] = 0;
          f2[66] = e3;
          a3 = f2[3] | 0;
          s2[a3 + (e3 << 1) >> 1] = 0;
          f2[r3 >> 2] = a3 + (e3 << 1) + 2;
          f2[67] = a3 + (e3 << 1) + 2;
          f2[58] = 0;
          f2[62] = 0;
          f2[60] = 0;
          f2[59] = 0;
          f2[64] = 0;
          f2[61] = 0;
          n2 = r3;
          return a3 | 0;
        }
        function E(e3, a3, r3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          r3 = r3 | 0;
          var i3 = 0, s3 = 0;
          s3 = e3 + (0 - r3 << 1) + 2 | 0;
          i3 = f2[3] | 0;
          if (s3 >>> 0 >= i3 >>> 0 ? (S(s3, a3, r3 << 1) | 0) == 0 : 0) if ((s3 | 0) == (i3 | 0)) i3 = 1;
          else i3 = j(e3 + (0 - r3 << 1) | 0) | 0;
          else i3 = 0;
          return i3 | 0;
        }
        function P(e3) {
          e3 = e3 | 0;
          var a3 = 0;
          switch (e3 << 16 >> 16) {
            case 91:
            case 123: {
              h2();
              f2[73] = (f2[73] | 0) + 2;
              break;
            }
            default: {
              a3 = f2[73] | 0;
              H(e3) | 0;
              e3 = f2[73] | 0;
              if (e3 >>> 0 > a3 >>> 0) T(a3, e3, a3, e3);
            }
          }
          return v2(1) | 0;
        }
        function q(e3) {
          e3 = e3 | 0;
          switch (s2[e3 >> 1] | 0) {
            case 107: {
              e3 = E(e3 + -2 | 0, 140, 4) | 0;
              break;
            }
            case 101: {
              if ((s2[e3 + -2 >> 1] | 0) == 117) e3 = E(e3 + -4 | 0, 112, 6) | 0;
              else e3 = 0;
              break;
            }
            default:
              e3 = 0;
          }
          return e3 | 0;
        }
        function z(e3, a3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          var r3 = 0;
          r3 = f2[3] | 0;
          if (r3 >>> 0 <= e3 >>> 0 ? (s2[e3 >> 1] | 0) == a3 << 16 >> 16 : 0) if ((r3 | 0) == (e3 | 0)) r3 = 1;
          else r3 = D(s2[e3 + -2 >> 1] | 0) | 0;
          else r3 = 0;
          return r3 | 0;
        }
        function D(e3) {
          e3 = e3 | 0;
          e: do {
            if ((e3 + -9 & 65535) < 5) e3 = 1;
            else {
              switch (e3 << 16 >> 16) {
                case 32:
                case 160: {
                  e3 = 1;
                  break e;
                }
                default: {
                }
              }
              e3 = e3 << 16 >> 16 != 46 & (O(e3) | 0);
            }
          } while (0);
          return e3 | 0;
        }
        function F() {
          var e3 = 0, a3 = 0, r3 = 0;
          e3 = f2[74] | 0;
          r3 = f2[73] | 0;
          e: while (1) {
            a3 = r3 + 2 | 0;
            if (r3 >>> 0 >= e3 >>> 0) break;
            switch (s2[a3 >> 1] | 0) {
              case 13:
              case 10:
                break e;
              default:
                r3 = a3;
            }
          }
          f2[73] = a3;
          return;
        }
        function G(e3) {
          e3 = e3 | 0;
          e: do {
            if (((e3 & -33) + -65 & 65535) < 26 | (e3 + -48 & 65535) < 10) e3 = 1;
            else {
              switch (e3 << 16 >> 16) {
                case 36:
                case 95: {
                  e3 = 1;
                  break e;
                }
                default: {
                }
              }
              e3 = (e3 & 65535) > 127;
            }
          } while (0);
          return e3 | 0;
        }
        function H(e3) {
          e3 = e3 | 0;
          while (1) {
            if (L(e3) | 0) break;
            if (O(e3) | 0) break;
            e3 = (f2[73] | 0) + 2 | 0;
            f2[73] = e3;
            e3 = s2[e3 >> 1] | 0;
            if (!(e3 << 16 >> 16)) {
              e3 = 0;
              break;
            }
          }
          return e3 | 0;
        }
        function J() {
          var e3 = 0;
          e3 = f2[(f2[60] | 0) + 20 >> 2] | 0;
          switch (e3 | 0) {
            case 1: {
              e3 = -1;
              break;
            }
            case 2: {
              e3 = -2;
              break;
            }
            default:
              e3 = e3 - (f2[3] | 0) >> 1;
          }
          return e3 | 0;
        }
        function K(e3) {
          e3 = e3 | 0;
          if (!(E(e3, 186, 5) | 0) ? !(E(e3, 196, 3) | 0) : 0) e3 = E(e3, 202, 2) | 0;
          else e3 = 1;
          return e3 | 0;
        }
        function L(e3) {
          e3 = e3 | 0;
          switch (e3 << 16 >> 16) {
            case 160:
            case 9:
            case 10:
            case 11:
            case 12:
            case 13:
            case 32: {
              e3 = 1;
              break;
            }
            default:
              e3 = 0;
          }
          return e3 | 0;
        }
        function M(e3) {
          e3 = e3 | 0;
          switch (e3 << 16 >> 16) {
            case 160:
            case 32:
            case 12:
            case 11:
            case 9: {
              e3 = 1;
              break;
            }
            default:
              e3 = 0;
          }
          return e3 | 0;
        }
        function N(e3) {
          e3 = e3 | 0;
          if ((s2[e3 >> 1] | 0) == 46 ? (s2[e3 + -2 >> 1] | 0) == 46 : 0) e3 = (s2[e3 + -4 >> 1] | 0) == 46;
          else e3 = 0;
          return e3 | 0;
        }
        function Q() {
          var e3 = 0;
          e3 = f2[69] | 0;
          e3 = f2[((e3 | 0) == 0 ? (f2[60] | 0) + 32 | 0 : e3 + 16 | 0) >> 2] | 0;
          f2[69] = e3;
          return (e3 | 0) != 0 | 0;
        }
        function R(e3) {
          e3 = e3 | 0;
          if ((f2[3] | 0) == (e3 | 0)) e3 = 1;
          else e3 = j(e3 + -2 | 0) | 0;
          return e3 | 0;
        }
        function V() {
          var e3 = 0;
          e3 = f2[(f2[61] | 0) + 12 >> 2] | 0;
          if (!e3) e3 = -1;
          else e3 = e3 - (f2[3] | 0) >> 1;
          return e3 | 0;
        }
        function W() {
          var e3 = 0;
          e3 = f2[(f2[60] | 0) + 12 >> 2] | 0;
          if (!e3) e3 = -1;
          else e3 = e3 - (f2[3] | 0) >> 1;
          return e3 | 0;
        }
        function X() {
          var e3 = 0;
          e3 = f2[(f2[61] | 0) + 8 >> 2] | 0;
          if (!e3) e3 = -1;
          else e3 = e3 - (f2[3] | 0) >> 1;
          return e3 | 0;
        }
        function Y() {
          var e3 = 0;
          e3 = f2[(f2[60] | 0) + 16 >> 2] | 0;
          if (!e3) e3 = -1;
          else e3 = e3 - (f2[3] | 0) >> 1;
          return e3 | 0;
        }
        function Z() {
          var e3 = 0;
          e3 = f2[(f2[60] | 0) + 4 >> 2] | 0;
          if (!e3) e3 = -1;
          else e3 = e3 - (f2[3] | 0) >> 1;
          return e3 | 0;
        }
        function _() {
          var e3 = 0;
          e3 = f2[60] | 0;
          e3 = f2[((e3 | 0) == 0 ? 232 : e3 + 36 | 0) >> 2] | 0;
          f2[60] = e3;
          return (e3 | 0) != 0 | 0;
        }
        function ee() {
          var e3 = 0;
          e3 = f2[61] | 0;
          e3 = f2[((e3 | 0) == 0 ? 236 : e3 + 20 | 0) >> 2] | 0;
          f2[61] = e3;
          return (e3 | 0) != 0 | 0;
        }
        function ae() {
          i2[806] = 1;
          f2[68] = (f2[73] | 0) - (f2[3] | 0) >> 1;
          f2[73] = (f2[74] | 0) + 2;
          return;
        }
        function re(e3) {
          e3 = e3 | 0;
          return e3 << 16 >> 16 == 39 | e3 << 16 >> 16 == 34 | 0;
        }
        function ie() {
          return (f2[(f2[61] | 0) + 16 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function se() {
          return (f2[(f2[69] | 0) + 12 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function fe() {
          return (f2[(f2[69] | 0) + 8 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function ce() {
          return (f2[(f2[69] | 0) + 4 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function te() {
          return (f2[(f2[60] | 0) + 8 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function ne() {
          return (f2[(f2[61] | 0) + 4 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function be(e3) {
          e3 = e3 | 0;
          return e3 << 16 >> 16 == 13 | e3 << 16 >> 16 == 10 | 0;
        }
        function ke() {
          return (f2[f2[69] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function le() {
          return (f2[f2[60] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function ue() {
          return (f2[f2[61] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
        }
        function oe() {
          return c2[(f2[60] | 0) + 24 >> 0] | 0 | 0;
        }
        function he(e3) {
          e3 = e3 | 0;
          f2[3] = e3;
          return;
        }
        function we() {
          return f2[(f2[60] | 0) + 28 >> 2] | 0;
        }
        function de() {
          return (i2[807] | 0) != 0 | 0;
        }
        function ve() {
          return (i2[808] | 0) != 0 | 0;
        }
        function Ae() {
          f2[69] = 0;
          return;
        }
        function Ce() {
          return f2[68] | 0;
        }
        function ge(e3, a3) {
          e3 = e3 | 0;
          a3 = a3 | 0;
          n2 = e3 + a3 + 15 & -16;
          return a3;
        }
        return { su: ge, ai: Y, ake: ce, aks: ke, ave: se, avs: fe, e: Ce, ee: ne, ele: V, els: X, es: ue, ess: ie, f: ve, id: J, ie: Z, ip: oe, is: le, it: we, ms: de, p: b2, ra: Q, re: ee, ri: _, rsa: Ae, sa: B, se: W, ses: he, ss: te };
      })("undefined" != typeof globalThis ? globalThis : self, {}, a), r = e.su(i - (2 << 17), 1040);
    }
    const h = c.length + 1;
    e.ses(r), e.sa(h - 1), s(c, new Uint16Array(a, r, h)), e.p() || (n = e.e(), o());
    const w = [], d = [];
    for (; e.ri(); ) {
      const a2 = e.is(), r2 = e.ie(), i2 = e.ai(), s2 = e.id(), f2 = e.ss(), t2 = e.se(), n2 = e.it();
      let k3;
      e.ip() && (k3 = b(-1 === s2 ? a2 : a2 + 1, c.charCodeAt(-1 === s2 ? a2 - 1 : a2)));
      let l3 = null;
      for (l3 = [], e.rsa(); e.ra(); ) {
        const a3 = e.aks(), r3 = e.ake(), i3 = e.avs(), s3 = e.ave();
        l3.push([v(a3, r3), v(i3, s3)]);
      }
      l3 = l3.length > 0 ? l3 : null, w.push({ t: n2, n: k3, s: a2, e: r2, ss: f2, se: t2, d: s2, a: i2, at: l3 });
    }
    for (; e.re(); ) {
      const a2 = e.es(), r2 = e.ee(), i2 = e.els(), s2 = e.ele(), f2 = i2 < 0 ? void 0 : v(i2, s2), c2 = v(a2, r2);
      d.push({ s: a2, e: r2, ls: i2, le: s2, ss: e.ess(), n: c2, ln: f2 });
    }
    return [w, d, !!e.f(), !!e.ms()];
    function v(e2, a2) {
      const r2 = c.charCodeAt(e2);
      return 34 === r2 || 39 === r2 ? b(e2 + 1, r2) : c.slice(e2, a2);
    }
  }
  function b(e2, a2) {
    n = e2;
    let r2 = "", i2 = n;
    for (; ; ) {
      n >= c.length && o();
      const e3 = c.charCodeAt(n);
      if (e3 === a2) break;
      92 === e3 ? (r2 += c.slice(i2, n), r2 += k(), i2 = n) : (8232 === e3 || 8233 === e3 || u(e3) && 96 !== a2 && o(), ++n);
    }
    return r2 += c.slice(i2, n++), r2;
  }
  function k() {
    let e2 = c.charCodeAt(++n);
    switch (++n, e2) {
      case 110:
        return "\n";
      case 114:
        return "\r";
      case 120:
        return String.fromCharCode(l(2));
      case 117:
        return (function() {
          const e3 = c.charCodeAt(n);
          let a2;
          123 === e3 ? (++n, a2 = l(c.indexOf("}", n) - n), ++n, a2 > 1114111 && o()) : a2 = l(4);
          return a2 <= 65535 ? String.fromCharCode(a2) : (a2 -= 65536, String.fromCharCode(55296 + (a2 >> 10), 56320 + (1023 & a2)));
        })();
      case 116:
        return "	";
      case 98:
        return "\b";
      case 118:
        return "\v";
      case 102:
        return "\f";
      case 13:
        10 === c.charCodeAt(n) && ++n;
      case 10:
        return "";
      case 56:
      case 57:
        o();
      default:
        if (e2 >= 48 && e2 <= 55) {
          let a2 = c.substr(n - 1, 3).match(/^[0-7]+/)[0], r2 = parseInt(a2, 8);
          return r2 > 255 && (a2 = a2.slice(0, -1), r2 = parseInt(a2, 8)), n += a2.length - 1, e2 = c.charCodeAt(n), "0" === a2 && 56 !== e2 && 57 !== e2 || o(), String.fromCharCode(r2);
        }
        return u(e2) ? "" : String.fromCharCode(e2);
    }
  }
  function l(e2) {
    const a2 = n;
    let r2 = 0, i2 = 0;
    for (let a3 = 0; a3 < e2; ++a3, ++n) {
      let e3, s2 = c.charCodeAt(n);
      if (95 !== s2) {
        if (s2 >= 97) e3 = s2 - 97 + 10;
        else if (s2 >= 65) e3 = s2 - 65 + 10;
        else {
          if (!(s2 >= 48 && s2 <= 57)) break;
          e3 = s2 - 48;
        }
        if (e3 >= 16) break;
        i2 = s2, r2 = 16 * r2 + e3;
      } else 95 !== i2 && 0 !== a3 || o(), i2 = s2;
    }
    return 95 !== i2 && n - a2 === e2 || o(), r2;
  }
  function u(e2) {
    return 13 === e2 || 10 === e2;
  }
  function o() {
    throw Object.assign(Error(`Parse error ${t}:${c.slice(0, n).split("\n").length}:${n - c.lastIndexOf("\n", n - 1)}`), { idx: n });
  }

  var DYNAMIC_IMPORT_HELPER = "__nimbusDynamicImport";
  function mayHaveDynamicImport(code) {
    return /\bimport\s*(?:\(|\/[/*])/.test(code);
  }
  var DYNAMIC_IMPORT_TYPE = 2;
  var IMPORT_META_TYPE = 3;
  var OffsetTokens = class _OffsetTokens extends Parser {
    static at(code, start, expressionAllowed = true) {
      const tokens = new _OffsetTokens({ ecmaVersion: "latest", sourceType: "script", allowHashBang: true }, code);
      Reflect.set(tokens, "pos", start);
      Reflect.set(tokens, "start", start);
      Reflect.set(tokens, "end", start);
      Reflect.set(tokens, "exprAllowed", expressionAllowed);
      return tokens;
    }
    take() {
      return Reflect.apply(Reflect.get(Parser.prototype, "getToken"), this, []);
    }
    raise(_position, message) {
      throw new SyntaxError(message);
    }
  };
  function needsFullGrammar(code, imports) {
    for (const entry of imports) {
      if (entry.t === DYNAMIC_IMPORT_TYPE && OffsetTokens.at(code, entry.se, false).take().type === types$1.braceL) return true;
    }
    const recognized = new Set(imports.map((entry) => entry.ss));
    const missing = [];
    for (const match of code.matchAll(/\bimport\s*(?:\(|\/[/*])/g)) {
      if (!recognized.has(match.index)) missing.push(match.index);
    }
    if (!missing.length) return false;
    try {
      const tokens = tokenizer2(code, { ecmaVersion: "latest", allowHashBang: true });
      let previous = types$1.eof;
      let next = 0;
      for (; ; ) {
        const token = tokens.getToken();
        while (next < missing.length && missing[next] < token.start) next++;
        if (token.type === types$1.eof || next === missing.length) return false;
        if (token.type === types$1.regexp && missing[next] < token.end) return true;
        if (token.type === types$1._import && missing[next] === token.start && previous !== types$1.dot && previous !== types$1.questionDot) {
          if (tokens.getToken().type === types$1.parenL) return true;
        }
        previous = token.type;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return true;
    }
  }
  function rewriteWithFullGrammar(code, parentUrl, metadata) {
    for (const sourceType of metadata ? ["module", "script"] : ["script", "module"]) {
      try {
        const ast = Parser.parse(code, { ecmaVersion: "latest", sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
        const edits = [];
        const metas = [];
        const names =   new Set();
        const call = DYNAMIC_IMPORT_HELPER + "(" + JSON.stringify(parentUrl) + ", ";
        full(ast, (node) => {
          if (node.type === "ImportExpression") {
            const tokens = OffsetTokens.at(code, node.start);
            tokens.take();
            edits.push({ start: node.start, end: tokens.take().end, text: call });
          } else if (metadata && node.type === "MetaProperty" && Reflect.get(node, "meta").name === "import") {
            metas.push({ start: node.start, end: node.end });
          } else if (metadata && node.type === "Identifier") {
            const name = Reflect.get(node, "name");
            if (typeof name === "string" && name.startsWith(METADATA_BINDING)) names.add(name);
          }
        });
        if (!edits.length && !metas.length) return code;
        return applyEdits(code, edits, metas, names, metas.length ? afterDirectives(code) : 0);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return code;
  }
  var IDENTIFIER_PART = /[$_\p{ID_Continue}\u200c\u200d]/u;
  var METADATA_BINDING = "__nimbusMetadataModule";
  function escapedCaptureNames(code) {
    const names =   new Set();
    for (let at2 = code.indexOf("\\u"); at2 !== -1; at2 = code.indexOf("\\u", at2)) {
      let start = at2;
      while (start > 0 && IDENTIFIER_PART.test(code[start - 1])) start--;
      try {
        const token = OffsetTokens.at(code, start).take();
        const value = Reflect.get(token, "value");
        if (token.type === types$1.name && typeof value === "string" && value.startsWith(METADATA_BINDING)) names.add(value);
        at2 = Math.max(at2 + 2, token.end);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        at2 += 2;
      }
    }
    return names;
  }
  function afterDirectives(code) {
    const tokens = OffsetTokens.at(code, 0);
    let token = tokens.take();
    let insertion = token.start;
    while (token.type === types$1.string) {
      const expression = parseExpressionAt2(code, token.start, { ecmaVersion: "latest", sourceType: "script" });
      if (expression.type !== "Literal" || typeof Reflect.get(expression, "value") !== "string") break;
      do {
        token = tokens.take();
      } while (token.start < expression.end);
      if (token.type === types$1.semi) {
        insertion = token.end;
        token = tokens.take();
        continue;
      }
      if (token.type !== types$1.eof && !/[\n\r\u2028\u2029]/.test(code.slice(expression.end, token.start))) break;
      insertion = expression.end;
    }
    return insertion;
  }
  function validImportArguments(fragment) {
    for (const prefix of ["async function(){return ", "async function*(){return "]) {
      try {
        parseExpressionAt2(prefix + fragment + "\n}", 0, {
          ecmaVersion: "latest",
          sourceType: "script",
          allowImportExportEverywhere: true,
          allowSuperOutsideMethod: true,
          checkPrivateFields: false
        });
        return true;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return false;
  }
  function rewriteDynamicImports(code, parentUrl, moduleMetadata = false) {
    const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
    if (!mayHaveDynamicImport(code) && !metadata) return code;
    const call = DYNAMIC_IMPORT_HELPER + "(" + JSON.stringify(parentUrl) + ", ";
    const edits = [];
    const metas = [];
    let validatedEnd = -1;
    try {
      const [imports] = parse3(code);
      if (needsFullGrammar(code, imports)) return rewriteWithFullGrammar(code, parentUrl, metadata);
      for (const entry of imports) {
        if (entry.t === DYNAMIC_IMPORT_TYPE) {
          if (entry.ss >= validatedEnd) {
            if (!validImportArguments(code.slice(entry.ss, entry.se))) return code;
            validatedEnd = entry.se;
          }
          edits.push({ start: entry.ss, end: entry.d + 1, text: call });
        } else if (metadata && entry.t === IMPORT_META_TYPE) {
          metas.push({ start: entry.s, end: entry.e });
        }
      }
      if (!edits.length && !metas.length) return code;
      return applyEdits(code, edits, metas, metas.length ? escapedCaptureNames(code) : null, metas.length ? afterDirectives(code) : 0);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && typeof Reflect.get(error, "idx") === "number") return code;
      throw error;
    }
  }
  function applyEdits(code, edits, metas, names, insertion) {
    if (metas.length) {
      let binding = METADATA_BINDING;
      while (code.includes(binding) || names.has(binding)) binding += "_";
      for (const meta of metas) edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
      edits.push({ start: insertion, end: insertion, text: `
"use strict";
const ${binding} = arguments[2];
` });
    }
    edits.sort((a2, b2) => a2.start - b2.start || a2.end - b2.end);
    const parts = [];
    let at2 = 0;
    for (const { start, end, text } of edits) {
      parts.push(code.slice(at2, start), text);
      at2 = end;
    }
    parts.push(code.slice(at2));
    return parts.join("");
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
    read(buffer, offset2, length) {
      const input = this.stdin ?? new Uint8Array(0);
      const chunk = input.subarray(this.stdinOffset, this.stdinOffset + length);
      buffer.set(chunk, offset2);
      this.stdinOffset += chunk.length;
      return chunk.length;
    }
  };
  var isOutput = (fd) => fd === 1 || fd === 2;
  function goFilesystem(vfs, stdio, state, live, crash) {
    const files =   new Map();
    let nextFd = 3;
    const at2 = (path) => resolvePath(state.cwd, path);
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
      write(fd, buffer, offset2, length, position, callback) {
        settle(async () => {
          const data2 = buffer.subarray(offset2, offset2 + length);
          if (isOutput(fd)) {
            await stdio.write(fd, data2);
            return length;
          }
          const open = file(fd);
          if (open.kind !== "handle") throw errno("EBADF", `fd ${fd} is not open for writing`);
          for (let done = 0; done < length; ) {
            const slice = data2.slice(done, Math.min(length, done + WRITE_SLICE_BYTES));
            const written = await vfs.write(open.handle, position === null ? null : position + done, slice);
            if (written <= 0) throw errno("EIO", `short write to ${open.path}`);
            done += written;
          }
          return length;
        }, callback);
      },
      read(fd, buffer, offset2, length, position, callback) {
        settle(async () => {
          if (fd === 0) return stdio.read(buffer, offset2, length);
          const open = file(fd);
          if (open.kind === "directory") throw errno("EISDIR", open.path);
          if (open.kind === "bytes") {
            const start = position ?? open.position;
            const chunk = open.bytes.subarray(start, start + length);
            buffer.set(chunk, offset2);
            if (position === null) open.position += chunk.length;
            return chunk.length;
          }
          const bytes2 = await vfs.read(open.handle, position, length);
          buffer.set(bytes2, offset2);
          return bytes2.length;
        }, callback);
      },
      open(path, flags, mode, callback) {
        settle(async () => {
          const target = at2(path);
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
        settle(() => stat(at2(path), true), callback);
      },
      lstat(path, callback) {
        settle(() => stat(at2(path), false), callback);
      },
      readdir(path, callback) {
        settle(async () => (await vfs.readdir(at2(path))).map((entry) => entry.name), callback);
      },
      mkdir(path, perm, callback) {
        settle(() => vfs.mkdir(at2(path), { mode: perm }), callback);
      },
      rmdir(path, callback) {
        settle(() => vfs.rmdir(at2(path)), callback);
      },
      unlink(path, callback) {
        settle(() => vfs.unlink(at2(path)), callback);
      },
      rename(from, to, callback) {
        settle(() => vfs.rename(at2(from), at2(to)), callback);
      },
      readlink(path, callback) {
        settle(async () => {
          const target = await vfs.readlink(at2(path));
          if (target === null) throw errno("EINVAL", `${path} is not a symbolic link`);
          return target;
        }, callback);
      },
      symlink(target, path, callback) {
        settle(() => vfs.symlink(target, at2(path)), callback);
      },
      link(_existing, path, callback) {
        settle(() => {
          throw errno("ENOSYS", `hard links are not supported: ${path}`);
        }, callback);
      },
      chmod(path, mode, callback) {
        settle(() => vfs.chmod(at2(path), mode), callback);
      },
      fchmod(fd, mode, callback) {
        settle(() => {
          const open = file(fd);
          return open.kind === "handle" ? vfs.fchmod(open.handle, mode) : vfs.chmod(open.path, mode);
        }, callback);
      },
      chown(path, uid, gid, callback) {
        settle(() => vfs.chown(at2(path), uid, gid), callback);
      },
      lchown(path, uid, gid, callback) {
        settle(() => vfs.chown(at2(path), uid, gid, { followSymlinks: false }), callback);
      },
      fchown(fd, uid, gid, callback) {
        settle(() => {
          const open = file(fd);
          return open.kind === "handle" ? vfs.fchown(open.handle, uid, gid) : vfs.chown(open.path, uid, gid);
        }, callback);
      },
      utimes(path, atime, mtime, callback) {
        settle(() => vfs.utimes(at2(path), atime * 1e3, mtime * 1e3), callback);
      },
      truncate(path, length, callback) {
        settle(() => vfs.truncate(at2(path), length), callback);
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
  globalThis.__nimbusRewriteDynamicImports = rewriteDynamicImports;
})();
