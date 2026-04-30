const s = require('stream');
console.log('keys:', Object.keys(s).slice(0, 15).join(','));
console.log('Readable:', typeof s.Readable);
console.log('Writable:', typeof s.Writable);
console.log('Transform:', typeof s.Transform);
console.log('promises typeof:', typeof s.promises);
console.log('web typeof:', typeof s.web);
const r = s.Readable.from(['a','b','c']);
let out=''; r.on('data', c=>out+=c); r.on('end', ()=>console.log('Readable.from collected:', out));
