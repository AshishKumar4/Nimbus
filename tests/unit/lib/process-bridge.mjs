// The process-binding contract (RuntimeFsBridge / NimbusFilesystemAuthority),
// built the one way tests build it. Tests that need a fake supervisor or a
// process's bound filesystem take it from here, never from the classes that
// implement it, so the implementation can change under them.

import { SqliteRuntimeFsBridge } from '../../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';

/**
 * A `RuntimeFsBridge` over `rawVfs` as `credOrView`: a credential, or a view
 * already made with `rawVfs.as(cred)`.
 */
export function processBridge(rawVfs, credOrView) {
  const view = typeof credOrView?.exists === 'function' ? credOrView : rawVfs.as(credOrView);
  return new SqliteRuntimeFsBridge(view, rawVfs);
}

/** The session's process-binding authority (`bind`, `openHost`, `releaseProcess`) over `rawVfs`. */
export function processFiles(rawVfs) {
  return new ProcessFiles(rawVfs);
}
