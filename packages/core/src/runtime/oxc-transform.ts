/**
 * oxc-transform.ts — esbuild's `transform()` contract, run by Nimbus's Oxc
 * build (packages/worker/scripts/oxc-wasm).
 *
 * `createOxcTransform(module)` answers the esbuild transform calls Nimbus
 * makes (esbuild-service.ts's transformWithEsbuild and runTransformRequest)
 * with the same output contract: the loaders `js`, `jsx`, `ts` and `tsx`;
 * `format` unset (module syntax kept), `esm` or `cjs` with esbuild's interop
 * helpers and `__esModule` marking; `define`; `supported['dynamic-import']`
 * and `supported['import-meta']`; JSX classic, automatic (with an import
 * source and the development runtime) or preserved (for ES module output
 * only: preserved JSX in CommonJS would name imports that conversion moved
 * onto records, and nothing in Nimbus asks for it), from esbuild's own JSX
 * options and from `tsconfigRaw` as esbuild applies them (tsconfig-raw.ts,
 * which also decides each other tsconfig field); source maps returned or
 * inlined; and esbuild's error message shape, down to the top-level-await
 * refusal the caller recognizes. Anything else a caller asks for (another
 * target, minify, CSS) is refused rather than ignored: there is no caller for
 * it, and silently doing less would be wrong.
 *
 * The wasm imports nothing and keeps nothing between calls; its linear
 * memory, which only grows, is the largest module's working set. An instance
 * whose memory passed `retireAboveBytes` is dropped after its call, and one
 * that trapped is never called again: the next call instantiates afresh.
 *
 * Oxc's passes recurse once per level of nesting, on the host's native stack.
 * A module nested deeper than that stack holds (a concatenation of some ten
 * thousand terms under workerd) fails with an error whose `stackExhausted` is
 * true, set here from the RangeError the wasm call threw and from nothing
 * else; the transform facet carries it in the outcome, and its host sends such
 * a module to esbuild instead (facets/oxc-transform.ts).
 *
 * The transform facet's runtime bundles it (oxc-facet/preamble.ts).
 */

import { resolveTsSettings } from './tsconfig-raw.js';

/** Whether `error` is a transform's report that it ran out of native stack. */
export function isOxcStackExhaustion(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'stackExhausted') === true;
}

export interface OxcTransformOptions {
  loader?: string;
  format?: string;
  target?: string;
  sourcemap?: boolean | string;
  sourcefile?: string;
  minify?: boolean;
  jsx?: string;
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  jsxDev?: boolean;
  tsconfigRaw?: string | object;
  define?: Record<string, string>;
  supported?: Record<string, boolean>;
}

export interface OxcLocation {
  file: string;
  namespace: string;
  line: number;
  column: number;
  length: number;
  lineText: string;
  suggestion: string;
}

export interface OxcMessage {
  id: string;
  pluginName: string;
  text: string;
  location: OxcLocation | null;
  notes: never[];
  detail: undefined;
}

export interface OxcTransformResult {
  code: string;
  map: string;
  warnings: OxcMessage[];
}

export interface OxcTransform {
  transform(code: string, options?: OxcTransformOptions): Promise<OxcTransformResult>;
  /** The live instance's linear memory, 0 when there is none. */
  memoryBytes(): number;
  /** AST arena bytes the last transform used and reserved. */
  lastArena(): { used: number; reserved: number };
}

interface OxcExports {
  memory: WebAssembly.Memory;
  nimbus_oxc_alloc(capacity: number): number;
  nimbus_oxc_realloc(ptr: number, capacity: number, newCapacity: number): number;
  nimbus_oxc_transform(ptr: number, capacity: number, sourceLength: number, optionsLength: number): number;
  nimbus_oxc_release(): void;
}

/** The wasm's exports, checked against the ABI scripts/oxc-wasm/src/abi.rs defines. */
function bindExports(instance: WebAssembly.Instance): OxcExports {
  const exports = instance.exports;
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('oxc transform: the wasm exports no memory');
  const call = (name: string): ((...args: number[]) => number) => {
    const fn = exports[name];
    if (typeof fn !== 'function') throw new Error(`oxc transform: the wasm does not export ${name}`);
    return (...args) => Number(fn(...args));
  };
  const release = call('nimbus_oxc_release');
  return {
    memory,
    nimbus_oxc_alloc: call('nimbus_oxc_alloc'),
    nimbus_oxc_realloc: call('nimbus_oxc_realloc'),
    nimbus_oxc_transform: call('nimbus_oxc_transform'),
    nimbus_oxc_release: () => { release(); },
  };
}

export function createOxcTransform(
  module: WebAssembly.Module,
  { retireAboveBytes = 64 * 1024 * 1024 }: { retireAboveBytes?: number } = {},
): OxcTransform {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let instance: OxcExports | null = null;
  let lastArena = { used: 0, reserved: 0 };
  const KNOWN: Record<string, true> = {
    loader: true, format: true, target: true, sourcemap: true, sourcefile: true, minify: true, jsx: true,
    jsxFactory: true, jsxFragment: true, jsxImportSource: true, jsxDev: true, tsconfigRaw: true, define: true, supported: true,
  };

  /** The options' wire form (abi.rs, options.rs), and esbuild's warnings about its tsconfig. */
  function wire(options: OxcTransformOptions): { fields: string; warnings: OxcMessage[] } {
    for (const key of Object.keys(options)) {
      if (KNOWN[key] !== true && Reflect.get(options, key) !== undefined) throw new Error(`oxc transform: option "${key}" is not supported`);
    }
    const loader = options.loader ?? 'js';
    if (loader !== 'js' && loader !== 'jsx' && loader !== 'ts' && loader !== 'tsx') {
      throw new Error(`oxc transform: loader "${loader}" is not supported`);
    }
    const format = options.format === undefined ? 'preserve' : options.format;
    if (format !== 'preserve' && format !== 'esm' && format !== 'cjs') throw new Error(`oxc transform: format "${format}" is not supported`);
    if (options.target !== undefined && options.target !== 'esnext') {
      throw new Error(`oxc transform: target "${options.target}" is not supported; only esnext`);
    }
    if (options.minify) throw new Error('oxc transform: minify is not supported');
    let settings;
    try {
      settings = resolveTsSettings(options, 'transform');
    } catch (error) {
      throw new Error(`oxc transform: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sourcemap = options.sourcemap === undefined || options.sourcemap === false ? 'none'
      : options.sourcemap === true || options.sourcemap === 'external' ? 'external'
        : options.sourcemap === 'inline' ? 'inline' : null;
    if (sourcemap === null) throw new Error(`oxc transform: sourcemap "${String(options.sourcemap)}" is not supported`);
    const { jsx: jsxSettings } = settings;
    const jsx = jsxSettings.preserve ? 'preserve' : jsxSettings.automatic ? 'automatic' : 'transform';
    if (jsx === 'preserve' && format === 'cjs' && (loader === 'jsx' || loader === 'tsx')) {
      throw new Error('oxc transform: jsx "preserve" is not supported with format "cjs"');
    }
    const fields = ['loader', loader, 'format', format, 'jsx', jsx, 'sourcemap', sourcemap];
    if (jsx === 'transform' && jsxSettings.factory) fields.push('jsxFactory', jsxSettings.factory);
    if (jsx === 'transform' && jsxSettings.fragment) fields.push('jsxFragment', jsxSettings.fragment);
    if (jsx === 'automatic' && jsxSettings.importSource) fields.push('jsxImportSource', jsxSettings.importSource);
    if (jsx === 'automatic' && jsxSettings.development) fields.push('jsxDev', '1');
    if (settings.preserveValueImports) fields.push('preserveValueImports', '1');
    if (settings.alwaysStrict) fields.push('alwaysStrict', '1');
    if (settings.refuse.decorators) fields.push('refuseDecorators', settings.refuse.decorators);
    if (settings.refuse.classFields) fields.push('refuseClassFields', settings.refuse.classFields);
    if (options.sourcefile) fields.push('sourcefile', options.sourcefile);
    for (const [name, value] of Object.entries(options.define ?? {})) fields.push('define', name, value);
    for (const [feature, supported] of Object.entries(options.supported ?? {})) {
      if (feature === 'dynamic-import') fields.push('dynamicImport', supported ? '1' : '0');
      else if (feature === 'import-meta') fields.push('importMeta', supported ? '1' : '0');
      else if (!supported) throw new Error(`oxc transform: supported["${feature}"] = false is not supported`);
    }
    for (const field of fields) {
      if (field.includes('\0')) throw new Error('oxc transform: an option contains a NUL character');
    }
    // esbuild reports its tsconfig's warnings at "<tsconfig.json>"; their place in it is not kept.
    const warnings = settings.warnings.map((text): OxcMessage => ({
      id: '', pluginName: '', text, location: null, notes: [], detail: undefined,
    }));
    return { fields: fields.join('\0'), warnings };
  }

  /** abi.rs's diagnostics: seven fields each, every field `<byte length>:<bytes>`. */
  function messages(bytes: Uint8Array): { errors: OxcMessage[]; warnings: OxcMessage[] } {
    const errors: OxcMessage[] = [];
    const warnings: OxcMessage[] = [];
    const fields: string[] = [];
    for (let at = 0; at < bytes.length;) {
      let length = 0;
      for (; bytes[at] !== 0x3a; at++) {
        const digit = bytes[at] - 0x30;
        if (!(digit >= 0 && digit <= 9) || at >= bytes.length) throw new Error('oxc transform: malformed diagnostics');
        length = length * 10 + digit;
      }
      at++;
      if (at + length > bytes.length) throw new Error('oxc transform: malformed diagnostics');
      fields.push(decoder.decode(bytes.subarray(at, at + length)));
      at += length;
    }
    if (fields.length % 7 !== 0) throw new Error('oxc transform: malformed diagnostics');
    for (let i = 0; i + 7 <= fields.length; i += 7) {
      const [kind, line, column, length, file, lineText, message] = fields.slice(i, i + 7);
      const lineNumber = Number(line);
      const location = lineNumber > 0
        ? { file, namespace: file === '<stdin>' ? '' : 'file', line: lineNumber, column: Number(column), length: Number(length), lineText, suggestion: '' }
        : null;
      (kind === 'E' ? errors : warnings).push({ id: '', pluginName: '', text: message, location, notes: [], detail: undefined });
    }
    return { errors, warnings };
  }

  function failure(errors: OxcMessage[], warnings: OxcMessage[]): Error {
    const lines = errors.map((e) => e.location
      ? `${e.location.file}:${e.location.line}:${e.location.column}: ERROR: ${e.text}`
      : `error: ${e.text}`);
    const count = errors.length === 1 ? '1 error' : `${errors.length} errors`;
    return Object.assign(new Error(`Transform failed with ${count}:\n${lines.join('\n')}`), { errors, warnings });
  }

  function run(code: string, optionsWire: string): OxcTransformResult {
    const exports = instance ??= bindExports(new WebAssembly.Instance(module, {}));
    const options = encoder.encode(optionsWire);
    // Room for the source as ASCII, grown only by what its other characters need.
    let capacity = code.length + options.length;
    let ptr = exports.nimbus_oxc_alloc(capacity);
    let read = 0;
    let written = 0;
    for (;;) {
      const into = new Uint8Array(exports.memory.buffer, ptr + written, capacity - options.length - written);
      const step = encoder.encodeInto(read === 0 ? code : code.slice(read), into);
      read += step.read;
      written += step.written;
      if (read >= code.length) break;
      const grown = written + (code.length - read) * 3 + options.length;
      ptr = exports.nimbus_oxc_realloc(ptr, capacity, grown);
      capacity = grown;
    }
    new Uint8Array(exports.memory.buffer, ptr + written, options.length).set(options);
    const at = exports.nimbus_oxc_transform(ptr, capacity, written, options.length);
    try {
      const [status, codePtr, codeLength, mapPtr, mapLength, diagnosticsPtr, diagnosticsLength, arenaUsed, arenaReserved] =
        new Uint32Array(exports.memory.buffer, at, 9);
      lastArena = { used: arenaUsed, reserved: arenaReserved };
      const memory = exports.memory.buffer;
      const { errors, warnings } = messages(new Uint8Array(memory, diagnosticsPtr, diagnosticsLength));
      if (status !== 0) {
        if (status === 2) throw Object.assign(new Error(`oxc transform: ${errors[0]?.text ?? 'the options were refused'}`), { errors, warnings });
        throw failure(errors, warnings);
      }
      return {
        code: decoder.decode(new Uint8Array(memory, codePtr, codeLength)),
        map: decoder.decode(new Uint8Array(memory, mapPtr, mapLength)),
        warnings,
      };
    } finally {
      exports.nimbus_oxc_release();
    }
  }

  return {
    async transform(code, options = {}) {
      const { fields: optionsWire, warnings } = wire(options);
      try {
        const result = run(code, optionsWire);
        return warnings.length ? { ...result, warnings: [...warnings, ...result.warnings] } : result;
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'errors') !== undefined) throw error;
        // A trap, or the host's stack running out inside a deeply nested
        // module, leaves the instance mid-call: never call it again.
        instance = null;
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        // V8 and JavaScriptCore both throw a RangeError of this text when
        // the native stack runs out; the module's own text never reaches here.
        if (error instanceof RangeError && /^Maximum call stack size exceeded\.?$/.test(error.message)) {
          throw Object.assign(new Error(`Transform failed with 1 error:\nerror: the Oxc transform ran out of stack (${reason})`), {
            stackExhausted: true,
          });
        }
        throw new Error(`Transform failed with 1 error:\nerror: the Oxc transform crashed (${reason})`);
      } finally {
        if (instance && instance.memory.buffer.byteLength > retireAboveBytes) instance = null;
      }
    },
    memoryBytes: () => (instance ? instance.memory.buffer.byteLength : 0),
    lastArena: () => lastArena,
  };
}
