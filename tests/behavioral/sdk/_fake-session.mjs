// A NimbusSession binding without a Durable Object, for SDK probes that run
// with no BASE: the namespace hands every name the same RPC stub, and logs
// the names it was asked for.

import { createExecStream, encodeExecStream } from '../../../packages/core/src/runtime/exec-stream.ts';

export class FakeNamespace {
  constructor(stub) {
    this.stub = stub;
    this.names = [];
  }
  idFromName(name) {
    this.names.push(name);
    return { name };
  }
  get(_id) {
    return this.stub;
  }
}

/** What _rpcExecStream answers for a command that printed `stdout` and exited 0. */
export async function succeededExecStream(command, stdout = 'ok\n') {
  const writer = createExecStream(() => {});
  await writer.write('stdout', new TextEncoder().encode(stdout));
  writer.end({ command, exitCode: 0, success: true, duration: 1, timestamp: 1 });
  return encodeExecStream(writer.stream);
}
