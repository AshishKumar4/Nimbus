const E = require('events');
const ee = new E();
ee.on('x', v=>console.log('got:',v));
ee.emit('x', 42);
console.log('once typeof:', typeof E.once);
console.log('listenerCount:', ee.listenerCount('x'));
console.log('getEventListeners:', typeof E.getEventListeners);
