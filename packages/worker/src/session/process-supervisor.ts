import { RpcTarget } from 'cloudflare:workers';
import type { SupervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { supervisorCalls, TRANSPORT, type SupervisorTransport } from './supervisor-calls.js';

/**
 * A one-shot's SUPERVISOR as a capability its host hands it in the call that
 * runs it, answered by `answer`, the host Durable Object's own
 * supervisorOp. workerd delivers a call on it over that call's RPC session,
 * inside the host's IoContext: no new request to the host, so it neither
 * becomes the host's front request, whose subrequest depth every later call
 * of the host inherits, nor costs the binding's hop and the stub's.
 */
export class ProcessSupervisor extends supervisorCalls(RpcTarget) {
  readonly #transport: SupervisorTransport;

  constructor(props: SupervisorBindingProps, env: unknown, answer: (envelope: SupervisorOpEnvelope) => Promise<unknown>) {
    super();
    this.#transport = { props, env, send: (envelope) => answer(envelope) };
  }

  [TRANSPORT](): SupervisorTransport {
    return this.#transport;
  }
}
