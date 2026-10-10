export async function httpFetchReviewCases(http, dns, net, address = (server) => server.address()) {
  const server = http.createServer((req, res) => { req.resume(); res.end('ok'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const result = { sameTick: [] };
  try {
    result.invalidEnd = [];
    for (const method of ['GET', 'POST']) {
      for (const chunk of [7, {}, new Int16Array([1])]) {
        const req = http.request({ host: '127.0.0.1', port, method });
        req.on('error', () => {});
        try { req.end(chunk); result.invalidEnd.push(null); }
        catch (error) { result.invalidEnd.push([error.code, error.message]); }
        req.abort();
      }
    }
    for (const begin of ['end', 'write', 'flushHeaders']) {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', agent: false });
      const events = [];
      req.on('abort', () => events.push('abort'));
      req.on('error', (error) => events.push([error.code, error.message]));
      const closed = new Promise((resolve) => req.on('close', () => { events.push('close'); resolve(); }));
      if (begin === 'write') req.write('a');
      else req[begin]();
      req.abort();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 0));
      result.sameTick.push({ begin, events });
    }
    const repeated = http.request({ host: '127.0.0.1', port, method: 'POST' });
    repeated.on('error', () => {});
    repeated.end('first');
    result.repeatedEnd = await new Promise((resolve) => repeated.end('second', (error) => resolve(error?.code ?? null)));
    repeated.abort();
    const req = http.request({ host: 'bad host', port: 80, method: 'POST' });
    const events = [];
    req.on('error', () => events.push('error'));
    const closed = new Promise((resolve) => req.on('close', () => { events.push('close'); resolve(); }));
    try { req.end('x'); } catch (error) { events.push('throw'); req.destroy(error); }
    await closed;
    result.preparation = events;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const named = http.createServer();
  try {
    await new Promise((resolve, reject) => { named.once('error', reject); named.listen(0, 'localhost', resolve); });
    const bound = address(named);
    const lookup = await new Promise((resolve, reject) => dns.lookup('localhost', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
    const family = net.isIP(bound.address);
    result.hostname = { numeric: family !== 0, familyMatches: bound.family === 'IPv' + family, resolved: lookup.some((ip) => ip.address === bound.address && ip.family === family) };
  } finally { await new Promise((resolve) => named.close(resolve)); }
  return result;
}
