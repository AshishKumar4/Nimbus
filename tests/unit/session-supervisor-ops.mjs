/**
 * Give a fake session host the same supervisor surface NimbusSession has:
 * `supervisorOp` dispatches envelopes through the session's real handler and
 * `supervisorBridge` serves the RPC bodies that take the bridge directly.
 * Any host with `sqliteFs`/`processes`/`ensureSqliteFs` can attach it; a
 * pre-built `ops` lets a test hold the bridge store the handler shares.
 *
 * Kept out of sqlite-vfs-test-harness.mjs on purpose: that file is imported
 * by tests that register wasm-loader plugins, and importing the worker
 * session here would evaluate esbuild-service (and its `.wasm` static
 * import) before those plugins exist.
 */
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';

export function attachSupervisorOps(host, ops = buildSessionSupervisorOps(host)) {
  host.supervisorOp = (envelope) => ops.dispatch(envelope);
  host.supervisorBridge = (pid) => ops.bridge(pid);
  host.supervisorForgetBridge = (pid) => ops.forget(pid);
  return host;
}
