// A real session process for tests that change credentials between launches.
// Unlike withNamespace's default process, this process is spawned with the
// credential the runner receives; permission decisions still belong to the
// session's real supervisor-op handler.
import { opSender, supervisorDouble } from './supervisor-double.mjs';

export function processInstanceSupervisor(authority, cred) {
  const { pid } = authority.host.processes.spawn('instance-test', [], '/home/user', { cred });
  const acquireRequests = [];
  const outputs = { stdout: '', stderr: '', exit: null };
  const decoder = new TextDecoder();
  const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
  const supervisor = supervisorDouble((name, args) => {
    if (name === 'stdout' || name === 'stderr') {
      outputs[name] += decoder.decode(/** @type {Uint8Array} */ (args[0]));
      return;
    }
    if (name === 'reportExit') { outputs.exit = args[0]; return; }
    if (name === 'fsAcquire') acquireRequests.push(args[0]);
    return send(name, args);
  });
  return {
    supervisor, pid, acquireRequests, outputs,
    async close() {
      authority.host.processes.exit(pid, 0);
      await authority.host.processes.released(pid);
    },
  };
}
