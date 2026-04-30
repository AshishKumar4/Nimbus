const h = require('https');
console.log('keys:', Object.keys(h).slice(0, 15).join(','));
console.log('request typeof:', typeof h.request);
console.log('get typeof:', typeof h.get);
