/**
 * Give a fake session host the same supervisor surface NimbusSession has:
 * `supervisorOp` answers envelopes through the session's real handler, as a
 * host stub's call is answered (counted), `serveSupervisorOp` serves the
 * session's calls to itself, and `supervisorBridge` serves the RPC bodies
 * that take the bridge directly.
 * Any host with `sqliteFs`/`processes`/`ensureSqliteFs` can attach it; a
 * pre-built `ops` lets a test hold the bridge store the handler shares.
 *
 * Kept out of sqlite-vfs-test-harness.mjs on purpose: that file is imported
 * by tests that register wasm-loader plugins, and importing the worker
 * session here would evaluate esbuild-service (and its `.wasm` static
 * import) before those plugins exist.
 */
import { answerSupervisorOp, buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';

export function attachSupervisorOps(host, ops = buildSessionSupervisorOps(host)) {
  host.serveSupervisorOp = (envelope) => ops.dispatch(envelope);
  host.supervisorOp = (envelope) => answerSupervisorOp(host.serveSupervisorOp, envelope);
  host.supervisorBridge = (pid) => ops.bridge(pid);
  host.supervisorForgetBridge = (pid) => ops.forget(pid);
  return host;
}
