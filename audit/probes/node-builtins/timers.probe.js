const t = require('timers');
console.log('keys:', Object.keys(t).slice(0, 10).join(','));
console.log('setTimeout typeof:', typeof t.setTimeout);
console.log('setImmediate typeof:', typeof t.setImmediate);
console.log('promises typeof:', typeof t.promises);
