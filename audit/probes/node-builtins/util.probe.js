const u = require('util');
console.log('keys:', Object.keys(u).slice(0, 20).join(','));
console.log('inspect basic:', u.inspect({a:1, b:[1,2]}));
const cyc = {}; cyc.self = cyc;
try { console.log('inspect cyclic:', u.inspect(cyc)); } catch(e) { console.log('inspect cyclic THREW:', e.message); }
console.log('format:', u.format('%s=%d', 'x', 42));
console.log('promisify typeof:', typeof u.promisify);
console.log('parseArgs typeof:', typeof u.parseArgs);
console.log('debuglog typeof:', typeof u.debuglog);
