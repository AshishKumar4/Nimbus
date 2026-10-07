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
