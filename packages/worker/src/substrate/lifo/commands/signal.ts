export type WaitResult<T> =
  | { type: 'done'; value: T }
  | { type: 'aborted' }
  | { type: 'timeout' };

export function waitForSignalOrTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WaitResult<T>> {
  if (signal.aborted) {
    return Promise.resolve({ type: 'aborted' });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (result: WaitResult<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    onAbort = () => finish({ type: 'aborted' });

    timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish({ type: 'done', value }),
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForAbortOrTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<'aborted' | 'timeout'> {
  const result = await waitForSignalOrTimeout(new Promise<never>(() => {}), signal, timeoutMs);
  return result.type === 'aborted' ? 'aborted' : 'timeout';
}
