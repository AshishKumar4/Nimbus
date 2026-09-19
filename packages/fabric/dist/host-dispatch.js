import { BindingError } from './vendor/errors.js';
import { hostDispatchMethod, hostNamespace } from './composition.js';
function isNamespace(value) {
    return typeof Reflect.get(value, 'idFromName') === 'function'
        && typeof Reflect.get(value, 'idFromString') === 'function'
        && typeof Reflect.get(value, 'get') === 'function';
}
export function hostNamespaceBinding(env, usage) {
    const name = hostNamespace();
    const binding = env ? Reflect.get(env, name) : undefined;
    if (binding === null || (typeof binding !== 'object' && typeof binding !== 'function') || !isNamespace(binding)) {
        throw new BindingError(`${usage}: env.${name} must be the Durable Object namespace configured by composeFabric`);
    }
    return binding;
}
export function hostOpDispatch(stub, usage) {
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
