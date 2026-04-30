const n = require('net');
console.log('keys:', Object.keys(n).slice(0, 15).join(','));
console.log('isIP v4:', n.isIP('1.2.3.4'));
console.log('isIP v6:', n.isIP('::1'));
const sock = new n.Socket();
sock.on('connect', () => console.log('Socket connect emitted'));
sock.on('error', (e) => console.log('Socket error:', e.message));
sock.connect(443, 'example.com');
setTimeout(() => console.log('Socket state: connecting=', sock.connecting, 'remoteAddress=', sock.remoteAddress), 1500);
