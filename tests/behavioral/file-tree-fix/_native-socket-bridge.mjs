import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require(require.resolve('ws', { paths: [dirname(require.resolve('puppeteer-core'))] }));
const bridge = new WebSocket.WebSocketServer({ noServer: true });
const server = createServer();
const peers = new Set();
let accept;
let target;
server.on('upgrade', (request, socket, head) => {
  accept = () => bridge.handleUpgrade(request, socket, head, (browser) => {
    const upstream = new WebSocket(target.url, target.options);
    peers.add(browser); peers.add(upstream);
    const queued = [];
    browser.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else queued.push([data, binary]);
    });
    upstream.on('open', () => { for (const [data, binary] of queued.splice(0)) upstream.send(data, { binary }); });
    upstream.on('message', (data, binary) => { if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary }); });
    for (const [from, to] of [[browser, upstream], [upstream, browser]]) {
      from.on('error', (error) => process.send({ type: 'error', message: error.message }));
      from.on('close', () => { if (to.readyState === WebSocket.OPEN) to.close(); });
    }
  });
  process.send({ type: 'pending' });
});
process.on('message', (message) => {
  if (message.type === 'start') {
    target = message;
    server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
  } else if (message.type === 'accept') accept();
});
process.on('SIGTERM', () => {
  for (const peer of peers) peer.terminate();
  bridge.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
