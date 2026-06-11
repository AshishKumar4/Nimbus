/**
 * opentui-facet-backend.ts — the in-facet boot glue that constructs the OpenTUI
 * wasm FFI backend and parks it on `globalThis.__nimbusOpenTUIBackend` for the
 * Nimbus-patched @opentui/core seams (see scripts/opencode/build-node.ts,
 * nimbusPatchOpenTUI) to resolve their render library from.
 *
 * The opencode bundle rides into the Worker Loader module map as an ESM module,
 * so worker-internal TypeScript cannot be imported into the facet isolate.
 * Facet-side runtime code is therefore authored as a source string injected at
 * module-init — the same mechanism wasi-instance.ts (WASI_INSTANCE_PREAMBLE_SRC)
 * and sqlite-shim.ts (generateSqliteFacetPreamble) use.
 *
 * SOURCE OF TRUTH: the backend implementation is
 * runtime/opentui-wasm-backend.ts (OpenTUIWasmBackend, Stage B, audited). The
 * string below is its facet-runnable mirror (type annotations stripped, private
 * fields kept). Keep the two in sync by hand; the bundle-wiring test
 * (tests/unit/opentui-bundle-wiring.mjs) evaluates THIS string and drives a full
 * 279-symbol render through it, so any behavioral drift from the TS class fails
 * loudly.
 *
 * The WASI host the backend needs (`__wasiMakeImports` / `__wasiInitFS`) comes
 * from WASI_INSTANCE_PREAMBLE_SRC, which the runner injects ahead of this glue.
 */

import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';

/** Module-map specifier for the staged OpenTUI wasm32-wasi reactor Module. */
export const OPENTUI_WASM_MODULE_NAME = 'opentui.wasm';

/** Global the patched @opentui/core seams read their FFI backend from. */
export const OPENTUI_BACKEND_GLOBAL = '__nimbusOpenTUIBackend';

/**
 * The backend class body, facet-runnable. A near-verbatim transcription of
 * OpenTUIWasmBackend (opentui-wasm-backend.ts) with TS types removed. Authored
 * as a bare class declaration so both the facet boot and the wiring test can
 * evaluate it.
 */
const OPENTUI_BACKEND_CLASS_SRC = String.raw`
const __OTUI_FFI_TYPE_SET = new Set([
  "void","bool","u8","u16","u32","u64","i8","i16","i32","i64",
  "f32","f64","usize","ptr","pointer","cstring",
]);
const __OTUI_ARENA_ALIGN = 16;

function __otuiToOffset(pointer) {
  return (typeof pointer === "bigint" ? Number(pointer) : pointer) >>> 0;
}
function __otuiViewBytes(value) {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, 0, value.buffer.byteLength);
    return { bytes, byteOffset: value.byteOffset, byteLength: value.byteLength };
  }
  const bytes = new Uint8Array(value);
  return { bytes, byteOffset: 0, byteLength: value.byteLength };
}

class OpenTUIWasmBackend {
  suffix = "wasm";
  #instance;
  #exports;
  #wasiResult;
  #callbacks = new Map();
  #nextToken = 1;
  #pendingPtrScratch = [];
  #cachedU8 = null;
  #cachedBuffer = null;

  constructor(opts) {
    opts.wasi.initFS({
      root: "opentui-wasi-root",
      preopens: [{ wasiPath: "/", vfsPath: "opentui-wasi-root" }],
      files: {},
      dirs: [],
    });
    let memory = null;
    this.#wasiResult = opts.wasi.makeImports({
      argv: opts.argv ?? ["opentui"],
      env: opts.env ?? {},
      getMemory: () => memory,
      stdoutWrite: opts.stdoutWrite,
      stderrWrite: opts.stderrWrite,
    });
    this.#instance = new WebAssembly.Instance(opts.module, {
      wasi_snapshot_preview1: this.#wasiResult.wasiImport,
      opentui: this.#opentuiImports(),
    });
    this.#exports = this.#instance.exports;
    memory = this.#exports.memory;
    this.#exports._initialize();
  }

  static create(opts) {
    return new OpenTUIWasmBackend(opts);
  }

  getStdout() { return this.#wasiResult.getStdout(); }
  getStderr() { return this.#wasiResult.getStderr(); }
  get memory() { return this.#exports.memory; }

  #u8() {
    const buffer = this.#exports.memory.buffer;
    if (this.#cachedBuffer !== buffer || this.#cachedU8 === null) {
      this.#cachedU8 = new Uint8Array(buffer);
      this.#cachedBuffer = buffer;
    }
    return this.#cachedU8;
  }

  #opentuiImports() {
    const dispatch = (token) => this.#callbacks.get(token >>> 0)?.fn;
    return {
      logCallback: (token, level, msgPtr, msgLen) => {
        dispatch(token)?.(level, msgPtr >>> 0, msgLen >>> 0);
      },
      eventSinkCallback: (token, namePtr, nameLen, dataPtr, dataLen) => {
        dispatch(token)?.(namePtr >>> 0, nameLen >>> 0, dataPtr >>> 0, dataLen >>> 0);
      },
      streamCallback: (token, streamPtr, eventId, arg0, arg1) => {
        dispatch(token)?.(streamPtr >>> 0, eventId >>> 0, arg0 >>> 0, arg1);
      },
    };
  }

  ptr(value) {
    const { bytes, byteOffset, byteLength } = __otuiViewBytes(value);
    const size = byteLength === 0 ? __OTUI_ARENA_ALIGN : byteLength;
    const offset = this.#alloc(size);
    if (byteLength > 0) {
      this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
    }
    this.#pendingPtrScratch.push({ offset, size });
    return offset;
  }

  toArrayBuffer(pointer, offset, length) {
    const base = __otuiToOffset(pointer) + (offset ?? 0);
    return this.#exports.memory.buffer.slice(base, base + length);
  }

  liveView(ctor, pointer, length) {
    return new ctor(this.#exports.memory.buffer, __otuiToOffset(pointer), length);
  }

  dlopen(_path, symbols) {
    const exports = this.#instance.exports;
    const bound = Object.create(null);
    for (const name of Object.keys(symbols)) {
      const sig = symbols[name];
      const raw = exports[name];
      if (typeof raw !== "function") {
        throw new Error("opentui-wasm-backend: export '" + name + "' is missing or not callable");
      }
      bound[name] = this.#bindSymbol(name, raw, sig);
    }
    return {
      symbols: bound,
      createCallback: (callback, definition) => this.#createCallback(callback, definition),
      close: () => this.#closeAllCallbacks(),
    };
  }

  #bindSymbol(name, fn, sig) {
    const argTypes = sig.args ?? [];
    for (const t of argTypes) {
      if (!__OTUI_FFI_TYPE_SET.has(t)) {
        throw new Error("opentui-wasm-backend: symbol '" + name + "' has unknown arg type '" + t + "'");
      }
    }
    const returns = sig.returns ?? "void";
    if (!__OTUI_FFI_TYPE_SET.has(returns)) {
      throw new Error("opentui-wasm-backend: symbol '" + name + "' has unknown return type '" + returns + "'");
    }
    return (...args) => {
      const claimedPtr = this.#pendingPtrScratch.splice(0);
      const scratch = [];
      const marshaled = new Array(argTypes.length);
      for (let i = 0; i < argTypes.length; i++) {
        const t = argTypes[i];
        const a = args[i];
        if (t === "ptr" || t === "pointer" || t === "cstring") {
          marshaled[i] = this.#marshalPtrArg(a, scratch);
        } else if (t === "u64" || t === "i64") {
          marshaled[i] = typeof a === "bigint" ? a : BigInt(Math.trunc(Number(a)));
        } else if (t === "usize") {
          marshaled[i] = typeof a === "bigint" ? Number(a) : a;
        } else if (t === "bool") {
          marshaled[i] = a ? 1 : 0;
        } else {
          marshaled[i] = typeof a === "bigint" ? Number(a) : a;
        }
      }
      let result;
      try {
        result = fn(...marshaled);
      } finally {
        for (let i = scratch.length - 1; i >= 0; i--) {
          const sc = scratch[i];
          if (sc.view && sc.view.byteLength > 0) {
            const dst = new Uint8Array(sc.view.buffer, sc.view.byteOffset, sc.view.byteLength);
            dst.set(this.#u8().subarray(sc.offset, sc.offset + sc.view.byteLength));
          }
          this.#exports.nimbus_free(sc.offset, sc.size);
        }
        for (let i = claimedPtr.length - 1; i >= 0; i--) {
          this.#exports.nimbus_free(claimedPtr[i].offset, claimedPtr[i].size);
        }
      }
      if (returns === "u64" || returns === "i64") {
        return typeof result === "bigint" ? result : BigInt(result);
      }
      return result;
    };
  }

  #marshalPtrArg(a, scratch) {
    if (a === null || a === undefined) return 0;
    if (typeof a === "number") return a >>> 0;
    if (typeof a === "bigint") return Number(a) >>> 0;
    const { bytes, byteOffset, byteLength } = __otuiViewBytes(a);
    const offset = this.#alloc(byteLength === 0 ? __OTUI_ARENA_ALIGN : byteLength);
    if (byteLength > 0) {
      this.#u8().set(bytes.subarray(byteOffset, byteOffset + byteLength), offset);
    }
    const writableView = ArrayBuffer.isView(a) ? a : new Uint8Array(a);
    scratch.push({ offset, size: byteLength === 0 ? __OTUI_ARENA_ALIGN : byteLength, view: writableView });
    return offset;
  }

  #createCallback(callback, _definition) {
    const token = this.#nextToken++;
    const instance = {
      ptr: token,
      threadsafe: false,
      close: () => { this.#callbacks.delete(token); },
    };
    this.#callbacks.set(token, { fn: callback, instance });
    return instance;
  }

  #closeAllCallbacks() {
    for (const entry of [...this.#callbacks.values()]) entry.instance.close();
  }

  #alloc(byteLength) {
    const size = byteLength === 0 ? __OTUI_ARENA_ALIGN : byteLength;
    const offset = this.#exports.nimbus_alloc(size);
    if (offset === 0) {
      throw new Error("opentui-wasm-backend: nimbus_alloc(" + size + ") returned null (OOM)");
    }
    return offset;
  }
}
`;

/**
 * The facet-runnable backend definition: the WASI preamble + the backend class.
 * Both the runner boot code and the wiring test embed this. Exposes the class
 * and the two WASI host helpers as locals; the boot code (or test) constructs
 * the instance from them.
 */
export const OPENTUI_BACKEND_FACET_SRC: string = `${WASI_INSTANCE_PREAMBLE_SRC}\n${OPENTUI_BACKEND_CLASS_SRC}`;

/**
 * Module-init boot block for the opencode runner: instantiate the backend over
 * the Nimbus WASI host and park it on the registry global BEFORE the
 * @opentui/core bundle init runs. The staged bytes' integrity is verified
 * supervisor-side at fetch time (fetchOpenTUIWasmBytes vs OPENTUI_WASM_SHA256),
 * so the Module reaching this scope is already trusted.
 *
 * The WASI preamble + backend class (OPENTUI_BACKEND_FACET_SRC) must already be
 * in scope, and `__nimbusOpenTUIWasmModule` (the pre-compiled Module imported
 * from the Worker Loader module map) must be bound — request-time
 * WebAssembly.compile is blocked, so the Module never comes from bytes here.
 */
export function generateOpenTUIBackendBootCode(): string {
  return `
// ── OpenTUI wasm FFI backend (module-init scope) ───────────────────────────
// The pre-compiled WebAssembly.Module rides in via the module map (integrity
// already verified supervisor-side). The backend is instantiated over the
// Nimbus WASI host and parked on the registry global the Nimbus-patched
// @opentui/core seams read from — BEFORE the opencode bundle import links
// @opentui/core's module-init FFI resolution.
{
  const __otuiWasi = {
    makeImports: (o) => __wasiMakeImports(o),
    initFS: (o) => __wasiInitFS(o),
  };
  globalThis.${OPENTUI_BACKEND_GLOBAL} = OpenTUIWasmBackend.create({
    module: __nimbusOpenTUIWasmModule,
    wasi: __otuiWasi,
    env: {
      TERM: (env && env.TERM) || "xterm-256color",
      COLORTERM: (env && env.COLORTERM) || "truecolor",
    },
  });
}
`;
}
