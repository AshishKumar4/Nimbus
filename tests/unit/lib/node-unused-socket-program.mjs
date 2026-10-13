export const NODE_UNUSED_SOCKETS = String.raw`
const net = require('net');
const untouched = new net.Socket();
const closed = [];
for (let i = 0; i < 3; i++) {
  const socket = new net.Socket();
  if (i === 1) socket.unref();
  if (i === 2) socket.ref();
  socket.on('close', () => closed.push([i, socket.destroyed, socket.connecting]));
  socket.destroy();
}
process.on('exit', () => console.log('UNUSED_SOCKETS ' + JSON.stringify({ closed, untouchedDestroyed: untouched.destroyed })));
`;
