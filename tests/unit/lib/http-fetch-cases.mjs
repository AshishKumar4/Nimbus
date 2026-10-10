export async function httpFetchCases(http) {
  const cookies = ['a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/', 'b=2; HttpOnly'];
  let uploaded = '';
  let connectionIsSocket = false;
  /** @type {PromiseWithResolvers<import('node:http').ServerResponse>} */
  const arrived = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/cookies') { res.setHeader('set-cookie', cookies); res.end('cookies'); return; }
    if (req.url === '/upload') {
      req.on('data', (chunk) => { uploaded += chunk; if (uploaded === 'first') res.write('seen'); });
      req.on('end', () => res.end(':' + uploaded));
      return;
    }
    if (req.url === '/bytes') { req.pipe(res); return; }
    if (req.url === '/wire') { req.resume(); req.on('end', () => res.end(JSON.stringify([req.headers['content-length'] ?? null, req.headers['transfer-encoding'] ?? null]))); return; }
    if (req.url === '/abort') { arrived.resolve(res); req.on('error', () => {}); return; }
    if (req.url === '/connection') {
      const count = await new Promise((resolve, reject) => server.getConnections((error, value) => error ? reject(error) : resolve(value)));
      res.end(JSON.stringify({ count, remotePort: req.socket.remotePort, connectionIsSocket }));
      return;
    }
    res.end('ok');
  });
  server.on('connection', (socket) => { connectionIsSocket = typeof socket.remoteAddress === 'string'; });
  const listen = (server, host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const close = (server) => new Promise((resolve) => server.close(resolve));
  const agent = new http.Agent({ keepAlive: true });
  try {
    await listen(server, '127.0.0.1');
    const port = server.address().port;
    const request = (path, callback, extra = {}) => http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, ...extra }, callback);
    const parity = {};
    parity.cookies = await new Promise((resolve, reject) => {
      const req = request('/cookies', (res) => {
        const values = [res.headers['set-cookie'], res.headersDistinct['set-cookie'], res instanceof http.IncomingMessage, res.constructor.name];
        res.resume(); res.on('end', () => resolve(values));
      });
      req.on('error', reject); req.end();
    });
    parity.upload = await new Promise((resolve, reject) => {
      let ended = false, early = false, body = '';
      const req = request('/upload', (res) => {
        res.on('data', (data) => {
          body += data;
          if (!ended) { early = true; ended = true; clearTimeout(timer); req.end('last'); }
        });
        res.on('end', () => resolve({ early, body }));
      });
      req.on('error', reject);
      const timer = setTimeout(() => { ended = true; req.end('last'); }, 1500);
      req.write('first');
    });
    parity.bytes = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = request('/bytes', (res) => {
        res.on('data', (bytes) => chunks.push(...bytes));
        res.on('end', () => resolve(chunks));
      });
      req.on('error', reject);
      req.cork();
      req.write(new Uint8Array([99, 0, 255, 18, 77, 99]).subarray(1, 5));
      req.write('é');
      req.uncork();
      req.end(new Uint8Array([9, 8, 7]));
    });
    parity.uploadHeaders = [];
    for (const payload of [undefined, 'é', new Uint8Array([1, 2, 3])]) {
      parity.uploadHeaders.push(await new Promise((resolve, reject) => {
        let body = '';
        const req = request('/wire', (res) => { res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve(JSON.parse(body))); });
        req.on('error', reject);
        req.end(payload);
      }));
    }
    const signalled = request('/abort', undefined, { signal: AbortSignal.abort('reason') });
    const signalEvents = [];
    const signalledClose = new Promise((resolve) => signalled.on('close', () => { signalEvents.push('close'); resolve(); }));
    signalled.on('error', (error) => signalEvents.push([error.name, error.code, error.message, error.cause, Object.keys(error)]));
    signalled.end();
    await signalledClose;
    parity.abortedSignal = signalEvents;
    const abort = (request) => {
      const events = [];
      request.on('abort', () => events.push('abort'));
      request.on('error', (error) => events.push([error.code, error.message]));
      const closed = new Promise((resolve) => request.on('close', () => { events.push('close'); resolve(events); }));
      return closed;
    };
    const before = request('/never-sent');
    const beforeClosed = abort(before);
    before.abort();
    parity.abortBeforeSend = await beforeClosed;
    const sent = request('/abort');
    const sentClosed = abort(sent);
    sent.end();
    const abortResponse = await arrived.promise;
    sent.abort();
    parity.abortAfterSend = await sentClosed;
    abortResponse.end('late');
    const connections = [];
    for (let i = 0; i < 2; i++) {
      connections.push(await new Promise((resolve, reject) => {
        let body = '', response;
        const req = request('/connection', (res) => {
          response = res;
          res.on('data', (chunk) => { body += chunk; });
        }, { method: 'GET', agent });
        req.on('error', reject);
        req.on('close', () => {
          const info = JSON.parse(body);
          resolve({ socket: req.socket?.constructor.name ?? null, responseSocket: response.socket?.constructor.name ?? null,
            reusedSocket: req.reusedSocket, peerPortMatches: info.remotePort === req.socket?.localPort,
            connections: info.count, connectionIsSocket: info.connectionIsSocket });
        });
        req.end();
      }));
    }
    const gaps = { connections, maxConnections: String(server.maxConnections), legacyConnections: String(server.connections) };
    agent.destroy();
    await close(server);
    parity.addresses = [];
    for (const host of ['127.0.0.1', '0.0.0.0', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::', undefined]) {
      const listener = http.createServer();
      await listen(listener, host);
      parity.addresses.push({ ...listener.address(), port: listener.address().port > 0 });
      await close(listener);
      if (listener.address() !== null) throw new Error('closed listener retained its address');
    }
    return { parity, gaps };
  } finally {
    agent.destroy();
    if (server.listening) { server.closeAllConnections(); await close(server); }
  }
}
