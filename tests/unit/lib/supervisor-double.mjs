// A double of the SUPERVISOR binding a process facet holds: shaped as an RPC
// stub is (every name a method, nothing thenable), each call made by
// `call(name, args)`, and `answer` running one exactly as SupervisorRPC.answer
// does (core vfs-supervisor.ts supervisorAnswer): the facet's client makes
// its filesystem calls through it. A name `lacks` returns true for is absent,
// as a method an older session does not serve.

import { supervisorAnswer } from '../../../packages/core/src/runtime/vfs-supervisor.ts';

/**
 * @param {(method: string, args: unknown[]) => unknown} call
 * @param {(name: string) => boolean} [lacks]
 */
export function supervisorDouble(call, lacks = () => false) {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then' || lacks(name)) return undefined;
      if (name === 'answer') return (method, args) => supervisorAnswer(() => call(method, args));
      return (...args) => call(name, args);
    },
  });
}

/**
 * SupervisorRPC's two wave calls over `send(envelope)`, a session's
 * supervisor-op handler: openWaveWriter answers the epoch's writer (its
 * host's incarnation kept for the fence), and writeBatchStream carries its
 * stream, fence and owner on the envelope, not in its arguments.
 * @param {(envelope: Record<string, unknown>) => Promise<any>} send
 */
export function waveCalls(send) {
  let incarnation;
  return {
    openWaveWriter: async () => {
      const answer = await send({ op: 'openWaveWriter', args: [] });
      incarnation = answer?.hostIncarnation;
      return answer?.writer ?? null;
    },
    writeBatchStream: (stream, fence, owner) => send({
      op: 'writeBatchStream', args: [], stream,
      ...(fence && incarnation !== undefined ? { waveFence: { ...fence, hostIncarnation: incarnation } } : {}),
      ...(owner ? { mutationOwner: owner } : {}),
    }),
  };
}

/**
 * A call by name, sent as SupervisorRPC sends it through `send(envelope)`
 * (a session's supervisor-op handler, for the process the envelope's sender
 * adds): its arguments in `args`, but a wave's stream and fence on the
 * envelope (waveCalls).
 * @param {(envelope: Record<string, unknown>) => Promise<any>} send
 */
export function opSender(send) {
  const waves = waveCalls(send);
  return (name, args) => (name === 'openWaveWriter' || name === 'writeBatchStream'
    ? waves[name](...args)
    : send({ op: name, args }));
}
