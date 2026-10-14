/**
 * A Node builtin of the realm's own process (`process.getBuiltinModule`),
 * never a program's: a Nimbus runtime that puts a program's process in front
 * of the realm's (node-shims) records the realm's own under
 * `Symbol.for('nimbus.fronts')`, and a warm isolate keeps the last program's
 * process as the global after it ends. Its builtins carry Node's argument
 * checks and errors for programs, which the runtime's own callers pay for
 * on every call. Undefined where the realm has no such builtin.
 */
type BuiltinProcess = { getBuiltinModule?(id: string): unknown };
type Fronts = WeakMap<object, { own: unknown }>;

export function realmBuiltin<T>(id: string): T | undefined {
  try {
    const global = globalThis as { process?: BuiltinProcess } & Record<symbol, Fronts | undefined>;
    const current = global.process;
    const own = (current && global[Symbol.for('nimbus.fronts')]?.get(current)?.own) as BuiltinProcess | undefined;
    return (own ?? current)?.getBuiltinModule?.(id) as T | undefined;
  } catch {
    return undefined;
  }
}
