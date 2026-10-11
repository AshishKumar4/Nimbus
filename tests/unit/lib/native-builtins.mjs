// The shims take the platform's builtins from the host's
// process.getBuiltinModule as they evaluate (node-shims.ts __nativeBuiltin).
// A test that stands in for one of the platform's (workerd's net, its vm)
// gives it here: `standIns` answer for the ids they name, the host for the
// rest, for the shims `evaluate` evaluates.

export function withNativeBuiltins(standIns, evaluate) {
  const host = globalThis.process;
  const own = host.getBuiltinModule;
  host.getBuiltinModule = (id) => {
    const name = String(id).replace(/^node:/, '');
    return Object.hasOwn(standIns, name) ? standIns[name] : Reflect.apply(own, host, [id]);
  };
  try {
    return evaluate();
  } finally {
    host.getBuiltinModule = own;
  }
}
