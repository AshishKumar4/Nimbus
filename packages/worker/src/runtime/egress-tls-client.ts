/**
 * Why `tls.connect({ socket })` is refused under an egress: the egress carries
 * that connection, and workerd starts no TLS on a connection through a
 * service binding. A new connection would not be the same one.
 */
const EGRESS_STARTTLS_REFUSAL =
  "Nimbus: TLS over a socket the program opened (tls.connect({ socket }), as STARTTLS does) is not available "
  + "when the workspace's network goes through an egress: the egress carries that connection, "
  + 'and workerd starts no TLS on a connection through a service binding';

/** Native TLSSocket owns the Node stream; the egress owns its encrypted session. */
export const EGRESS_TLS_CLIENT_SOURCE = String.raw`
function __nimbusEgressTlsConnect(real, net, args) {
  let options = {}, callback;
  if (args[0] !== null && typeof args[0] === 'object') { options = { ...args[0] }; callback = args[1]; }
  else {
    options.port = args[0];
    let i = 1;
    if (typeof args[i] === 'string') options.host = args[i++];
    if (args[i] !== null && typeof args[i] === 'object') Object.assign(options, args[i++]);
    callback = args[i];
  }
  const previous = options.socket;
  const target = () => {
    if (previous !== undefined) throw nodeError(Error, 'ERR_NIMBUS_EGRESS_STARTTLS', ${JSON.stringify(EGRESS_STARTTLS_REFUSAL)});
    const host = options.host ?? 'localhost';
    const port = Number(options.port);
    return typeof options.servername === 'string' && options.servername !== '' ? { host, port, servername: options.servername } : { host, port };
  };
  let reader, writer, resource;
  let endedRead = false, endedWrite = false, stopped = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const finish = () => {
    if (!endedRead || !endedWrite) return;
    resource?.[Symbol.dispose]?.();
    resource = undefined;
    resolveClosed();
  };
  let admit;
  const admitted = new Promise((resolve) => { admit = resolve; });
  const ready = admitted.then(async () => {
    const where = target();
    await __nimbusRawSocket();
    if (stopped) return;
    resource = await __supervisor.netTls('open', '', where);
    if (stopped) {
      await Promise.all([resource.readable.cancel(), resource.writable.abort()]);
      resource[Symbol.dispose]?.(); resource = undefined;
      return;
    }
    reader = resource.readable.getReader();
    writer = resource.writable.getWriter();
  });
  ready.catch(() => {});
  const close = async () => {
    if (stopped) return;
    stopped = true;
    previous?.destroy();
    await Promise.all([reader?.cancel().catch(() => {}), writer?.abort().catch(() => {})]);
    endedRead = endedWrite = true;
    finish();
  };
  const readable = new ReadableStream({ type: 'bytes',
    async pull(controller) {
      try {
        await ready;
        if (stopped) { controller.close(); return; }
        const next = await reader.read();
        if (next.done) { endedRead = true; controller.close(); finish(); }
        else controller.enqueue(new Uint8Array(next.value));
      } catch (error) { controller.error(error); }
    },
    cancel: close,
  });
  const writable = new WritableStream({
    async write(chunk) { await ready; if (!stopped) await writer.write(chunk); },
    async close() { await ready; if (!stopped) await writer.close(); endedWrite = true; finish(); },
    abort: close,
  });
  const transport = {
    readable, writable, opened: ready.then(() => ({})), closed,
    secureTransport: 'on', upgraded: false, close,
    startTls() { throw new TypeError('Cannot startTls on a TLS socket.'); },
  };
  let carrier;
  const initial = {
    ...transport, secureTransport: 'starttls',
    startTls() { carrier._handle = null; admit(); return transport; },
  };
  carrier = new net.Socket({ allowHalfOpen: options.allowHalfOpen === true, handle: {
    socket: initial, reader: readable.getReader({ mode: 'byob' }), writer: writable.getWriter(),
    bytesRead: 0, bytesWritten: 0, reading: false,
    options: { host: options.host ?? 'localhost', port: Number(options.port), addressType: 0 },
  } });
  const socket = real.connect({ ...options, socket: carrier }, callback);
  if (previous === undefined && options.timeout) socket.setTimeout(options.timeout);
  ready.catch((error) => socket.destroy(error));
  return socket;
}
`;
