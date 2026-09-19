import { BindingError } from './vendor/errors.js';
import { hostDispatchMethod, hostNamespace } from './composition.js';
import type { createSupervisorOpHandler } from '@nimbus-sh/core/workspace/supervisor-op.js';

export type HostNamespaceBinding = Pick<DurableObjectNamespace, 'get' | 'idFromName' | 'idFromString'>;
export type HostOpDispatch = ReturnType<typeof createSupervisorOpHandler>;

function isNamespace(value: object): value is HostNamespaceBinding {
  return typeof Reflect.get(value, 'idFromName') === 'function'
    && typeof Reflect.get(value, 'idFromString') === 'function'
    && typeof Reflect.get(value, 'get') === 'function';
}

export function hostNamespaceBinding(env: object | null | undefined, usage: string): HostNamespaceBinding {
  const name = hostNamespace();
  const binding = env ? Reflect.get(env, name) : undefined;
  if (binding === null || (typeof binding !== 'object' && typeof binding !== 'function') || !isNamespace(binding)) {
    throw new BindingError(`${usage}: env.${name} must be the Durable Object namespace configured by composeFabric`);
  }
  return binding;
}

export function hostOpDispatch(stub: object, usage: string): HostOpDispatch {
  const name = hostDispatchMethod();
  if (stub === null || (typeof stub !== 'object' && typeof stub !== 'function')) {
    throw new BindingError(`${usage}: the workspace namespace returned no stub`);
  }
  const dispatch = Reflect.get(stub, name);
  if (typeof dispatch !== 'function') {
    throw new BindingError(`${usage}: the workspace host must forward ${name}(envelope) to the runtime`);
  }
  // RpcStub.call would invoke a remote method named "call".
  return (envelope) => Promise.resolve(Reflect.apply(dispatch, stub, [envelope]));
}
