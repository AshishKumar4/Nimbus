// WASI fixtures — hand-rolled wasm modules used by the wasi/*.mjs probes.
//
// Each fixture imports `wasi_snapshot_preview1.<fns>` and exports `_start`
// + `memory`. Bytes were built by /tmp/build-wasi-fixtures.mjs and verified
// locally via Node's experimental `node:wasi`:
//
//   hello    fd_write                       → "hello, WASI!\n"
//   exit7    proc_exit                      → exits with code 7
//   args     args_sizes_get, fd_write       → "<argc>\n"
//   env      environ_sizes_get, fd_write    → "<envc>\n"
//   random   random_get, fd_write           → "<digit>\n"  (digit varies)
//   clock    clock_time_get, fd_write       → "0\n"        (errno 0 = ok)
//
// Each is ASCII-safe (workspace `nimbus-primitives-wave` binary-fs sibling
// is in flight — text-only writes are safer this wave).

export const FIXTURES = {
  hello: 'AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIjARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADAgEBBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAEKDwENAEEBQQhBAUEQEAAaCwsjAQBBCAsdGAAAAA0AAAAAAAAAAAAAAGhlbGxvLCBXQVNJIQo=',
  exit7:  'AGFzbQEAAAABCAJgAX8AYAAAAiQBFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAADAgEBBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAEKCAEGAEEHEAAL',
  args:   'AGFzbQEAAAABGARgAn9/AX9gAn9/AX9gBH9/f38Bf2AAAAJLAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmFyZ3Nfc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQACAwIBAwUDAQABBxMCBm1lbW9yeQIABl9zdGFydAACCkEBPwEBf0EAQQQQABpBACgCACEAQcgBQTAgAGo6AABByQFBCjoAAEEgQcgBNgIAQSRBAjYCAEEBQSBBAUEoEAEaCw==',
  env:    'AGFzbQEAAAABEgNgAn9/AX9gBH9/f38Bf2AAAAJOAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxEWVudmlyb25fc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABAwIBAgUDAQABBxMCBm1lbW9yeQIABl9zdGFydAACCkEBPwEBf0EAQQQQABpBACgCACEAQcgBQTAgAGo6AABByQFBCjoAAEEgQcgBNgIAQSRBAjYCAEEBQSBBAUEoEAEaCw==',
  random: 'AGFzbQEAAAABEgNgAn9/AX9gBH9/f38Bf2AAAAJHAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCnJhbmRvbV9nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKRAFCAQF/QQhBBBAAGkEILQAAQQpwIQBByAFBMCAAajoAAEHJAUEKOgAAQSBByAE2AgBBJEECNgIAQQFBIEEBQSgQARoL',
  clock:  'AGFzbQEAAAABEwNgA39+fwF/YAR/f39/AX9gAAACSwIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQ5jbG9ja190aW1lX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAAQMCAQIFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAgo9ATsBAX9BAEIAQQgQACEAQcgBQTAgAGo6AABByQFBCjoAAEEgQcgBNgIAQSRBAjYCAEEBQSBBAUEoEAEaCw==',
};

/** Materialise a fixture in VFS via a one-liner heredoc-style write. */
export function writeFixtureCmd(name, vfsPath) {
  const b64 = FIXTURES[name];
  if (!b64) throw new Error(`unknown fixture: ${name}`);
  return `node -e "require('fs').writeFileSync('${vfsPath}', Buffer.from('${b64}','base64'))"`;
}
