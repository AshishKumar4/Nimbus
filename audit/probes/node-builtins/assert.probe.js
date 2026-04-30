const a = require('assert');
console.log('keys:', Object.keys(a).slice(0, 15).join(','));
try { a.equal(1,1); console.log('equal ok'); } catch(e){}
try { a.deepEqual({a:1},{a:1}); console.log('deepEqual flat ok'); } catch(e) { console.log('deepEqual flat fail:', e.message); }
try { a.deepEqual({a:[1,2,{b:3}]},{a:[1,2,{b:3}]}); console.log('deepEqual nested ok'); } catch(e) { console.log('deepEqual nested fail:', e.message); }
const cyc = {}; cyc.self = cyc;
try { a.deepEqual(cyc, cyc); console.log('deepEqual cyclic ok'); } catch(e) { console.log('deepEqual cyclic THREW:', e.message); }
console.log('assert.match typeof:', typeof a.match);
console.log('assert.rejects typeof:', typeof a.rejects);
