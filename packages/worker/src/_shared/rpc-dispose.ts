type DisposableSymbolConstructor = SymbolConstructor & { readonly dispose?: symbol };

export function disposeRpcResource(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const disposerKey = (Symbol as DisposableSymbolConstructor).dispose;
  if (!disposerKey) return false;
  const disposer = Reflect.get(value, disposerKey);
  if (typeof disposer !== 'function') return false;
  try {
    Reflect.apply(disposer, value, []);
    return true;
  } catch {
    return false;
  }
}

export function disposeRpcResources(values: Iterable<unknown>): void {
  for (const value of values) disposeRpcResource(value);
}

export async function useRpcResource<T, R>(
  promise: Promise<T>,
  use: (value: T) => R | Promise<R>,
): Promise<R> {
  const value = await promise;
  try {
    return await use(value);
  } finally {
    disposeRpcResource(value);
  }
}
