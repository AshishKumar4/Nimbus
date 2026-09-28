// wasi-trampoline.mjs — emits the ~1 KB wasm module that lets one WASI
// import answer synchronously on one stack and suspend on another.
//
// JSPI's `WebAssembly.Suspending` traps whenever it is called from a stack
// `WebAssembly.promising` did not enter — even when the wrapped function
// returns a plain number. The rolldown binding is entered both ways: napi
// callbacks (a `transformSync`, a plugin-context call) run on the caller's
// ordinary stack, while the runtime pump runs under `promising` and may wait
// for a file the process does not hold. A JavaScript import cannot tell the
// two apart, so the choice is made in wasm, where it is exact:
//
//   - `active` is 1 only while the pump's own stack is running wasm. `pump`
//     sets it, calls the binding's pump through a funcref table (a direct
//     wasm call, so no JavaScript frame sits between `promising` and a
//     suspension), and clears it.
//   - Every filesystem import becomes a dispatcher: with `active` set it
//     clears the flag, calls the Suspending (`async`) body, and sets the flag
//     again when the guest resumes; otherwise it calls the plain (`sync`)
//     body. While the pump is suspended the flag is 0, so JavaScript that
//     re-enters the binding in that window takes the synchronous path.
//
// The flag is only ever written from wasm, so it changes exactly when the
// stack does; a JavaScript write would race the microtask that resumes the
// guest.

/** The WASI preview1 imports the binding may make that can touch files. */
export const DISPATCHED_WASI_IMPORTS = Object.freeze({
  fd_close: ['i32'],
  fd_filestat_get: ['i32', 'i32'],
  fd_filestat_set_size: ['i32', 'i64'],
  fd_pread: ['i32', 'i32', 'i32', 'i64', 'i32'],
  fd_pwrite: ['i32', 'i32', 'i32', 'i64', 'i32'],
  fd_read: ['i32', 'i32', 'i32', 'i32'],
  fd_readdir: ['i32', 'i32', 'i32', 'i64', 'i32'],
  fd_seek: ['i32', 'i64', 'i32', 'i32'],
  fd_sync: ['i32'],
  fd_write: ['i32', 'i32', 'i32', 'i32'],
  path_create_directory: ['i32', 'i32', 'i32'],
  path_filestat_get: ['i32', 'i32', 'i32', 'i32', 'i32'],
  path_open: ['i32', 'i32', 'i32', 'i32', 'i32', 'i64', 'i64', 'i32', 'i32'],
  path_readlink: ['i32', 'i32', 'i32', 'i32', 'i32', 'i32'],
  path_remove_directory: ['i32', 'i32', 'i32'],
  path_rename: ['i32', 'i32', 'i32', 'i32', 'i32', 'i32'],
  path_symlink: ['i32', 'i32', 'i32', 'i32', 'i32'],
  path_unlink_file: ['i32', 'i32', 'i32'],
  poll_oneoff: ['i32', 'i32', 'i32', 'i32'],
});

const VALTYPE = { i32: 0x7f, i64: 0x7e };

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

const bytesOf = (text) => [...new TextEncoder().encode(text)];
const name = (text) => [...uleb(bytesOf(text).length), ...bytesOf(text)];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];

/** The trampoline module's bytes. Deterministic: same input, same bytes. */
export function buildWasiTrampoline() {
  const names = Object.keys(DISPATCHED_WASI_IMPORTS).sort();
  const sigKeys = [];
  const sigIndex = new Map();
  const typeOf = (params) => {
    const key = params.join(',');
    if (!sigIndex.has(key)) {
      sigIndex.set(key, sigKeys.length);
      sigKeys.push(params);
    }
    return sigIndex.get(key);
  };
  const dispatcherTypes = names.map((n) => typeOf(DISPATCHED_WASI_IMPORTS[n]));
  const pumpType = typeOf(['i32']);

  const types = sigKeys.map((params) => [0x60, ...vec(params.map((p) => [VALTYPE[p]])), 0x01, VALTYPE.i32]);
  // Imports: sync.<name> at 2i, async.<name> at 2i + 1.
  const imports = names.flatMap((n, i) => [
    [...name('sync'), ...name(n), 0x00, ...uleb(dispatcherTypes[i])],
    [...name('async'), ...name(n), 0x00, ...uleb(dispatcherTypes[i])],
  ]);
  const importedFuncs = names.length * 2;
  const functions = [...dispatcherTypes, pumpType].map((t) => uleb(t));
  const table = [[0x70, 0x01, 0x01, 0x01]]; // funcref, min 1, max 1
  const globals = [[VALTYPE.i32, 0x01, 0x41, 0x00, 0x0b]]; // mut i32 = 0
  const exports = [
    ...names.map((n, i) => [...name(n), 0x00, ...uleb(importedFuncs + i)]),
    [...name('pump'), 0x00, ...uleb(importedFuncs + names.length)],
    [...name('table'), 0x01, 0x00],
    [...name('active'), 0x03, 0x00],
  ];

  const localGets = (count) => Array.from({ length: count }, (_, k) => [0x20, ...uleb(k)]).flat();
  const bodies = names.map((n, i) => {
    const arity = DISPATCHED_WASI_IMPORTS[n].length;
    const code = [
      0x23, 0x00, // global.get active
      0x04, VALTYPE.i32, // if (result i32)
      0x41, 0x00, 0x24, 0x00, // active = 0
      ...localGets(arity),
      0x10, ...uleb(2 * i + 1), // call async.<name> (may suspend)
      0x41, 0x01, 0x24, 0x00, // active = 1 on resume
      0x05, // else
      ...localGets(arity),
      0x10, ...uleb(2 * i), // call sync.<name>
      0x0b, // end if
      0x0b, // end func
    ];
    return [...uleb(code.length + 1), 0x00, ...code];
  });
  const pumpCode = [
    0x41, 0x01, 0x24, 0x00, // active = 1
    0x20, 0x00, // budget
    0x41, 0x00, // table slot 0: the binding's nimbus_rolldown_pump
    0x11, ...uleb(pumpType), 0x00, // call_indirect
    0x41, 0x00, 0x24, 0x00, // active = 0
    0x0b,
  ];
  bodies.push([...uleb(pumpCode.length + 1), 0x00, ...pumpCode]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec(functions)),
    ...section(4, vec(table)),
    ...section(6, vec(globals)),
    ...section(7, vec(exports)),
    ...section(10, vec(bodies)),
  ]);
}
