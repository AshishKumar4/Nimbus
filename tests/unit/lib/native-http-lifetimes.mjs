// Serialized into the real-workerd HTTP test. The only controlled boundaries
// are the network body and supervisor allocation RPC; all HTTP objects and
// the entrypoint lifetime loop are the actual runtime implementation.
export async function clientLifetime(https, runToExit, mode) {
  const fetch = globalThis.fetch;
  const produced = Promise.withResolvers();
  let producerFinished = false;
  let cancelled = false;
  let timer;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      timer = setTimeout(() => {
        producerFinished = true;
        if (mode === 'error') controller.error(new Error('body transport failed'));
        else { controller.enqueue(new TextEncoder().encode('second')); controller.close(); }
        produced.resolve();
      }, 40);
    },
    cancel() { cancelled = true; clearTimeout(timer); produced.resolve(); },
  }));
  let ended = false, errored = false, closed = false, streamed = false, body = '';
  try {
    const request = https.get('https://controlled-network.invalid/body', response => {
      response.on('data', chunk => {
        streamed ||= !producerFinished;
        body += chunk.toString();
        if (mode === 'cancel') response.destroy();
      });
      response.on('end', () => { ended = true; });
      response.on('error', () => { errored = true; });
    });
    request.on('error', () => { errored = true; });
    request.on('close', () => { closed = true; });
    const loop = await runToExit(undefined, 500);
    // Snapshot at natural exit, before test cleanup lets a late producer run.
    const result = { ended, errored, closed, streamed, body, cancelled, pending: loop.pending };
    await produced.promise;
    return result;
  } finally { globalThis.fetch = fetch; clearTimeout(timer); }
}

export async function pendingListenLifetime(http, runToExit, supervisor, drain) {
  const allocate = supervisor.allocatePort;
  const gate = Promise.withResolvers();
  supervisor.allocatePort = async () => { await gate.promise; return allocate(); };
  const server = http.createServer();
  let listening = false;
  server.listen(0, () => { listening = true; server.close(); });
  const timer = setTimeout(() => gate.resolve(), 40);
  try {
    const loop = await runToExit(undefined, 500);
    const result = { listening, pending: loop.pending };
    await drain();
    return result;
  } finally { gate.resolve(); clearTimeout(timer); supervisor.allocatePort = allocate; if (server.listening) server.close(); }
}

export async function pendingCloseLifetime(http, supervisor, registered, drain) {
  const allocate = supervisor.allocatePort;
  const old = Promise.withResolvers(), next = Promise.withResolvers();
  let allocations = 0;
  supervisor.allocatePort = () => (++allocations === 1 ? old.promise : next.promise);
  const server = http.createServer((_request, response) => response.end('reopened'));
  let closes = 0, callbacks = 0, listening = false, relistenError = null;
  server.on('close', () => { closes++; });
  try {
    server.listen(0);
    server.close(() => { callbacks++; });
    try { server.listen(0, () => { listening = true; }); } catch (e) { relistenError = e.code; }
    // The newer allocation wins first. Its port must survive retirement of
    // the older allocation after the server has already been reopened.
    registered.set(55001, true);
    next.resolve(55001);
    await new Promise(resolve => setTimeout(resolve, 10));
    registered.set(55000, true);
    old.resolve(55000);
    await drain();
    return {
      closes, callbacks, listening, relistenError,
      port: server.address()?.port ?? null,
      oldReleased: !registered.has(55000),
      newRetained: registered.has(55001),
    };
  } finally {
    old.resolve(55000); next.resolve(55001);
    supervisor.allocatePort = allocate;
    if (server.listening) server.close();
    await drain();
    registered.delete(55001);
  }
}
