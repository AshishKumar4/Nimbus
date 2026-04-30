const z = require('zlib');
console.log('keys:', Object.keys(z).slice(0, 18).join(','));
try { console.log('gzipSync:', z.gzipSync(Buffer.from('hi')).toString('hex')); } catch(e) { console.log('gzipSync THREW:', e.message); }
try { console.log('deflateSync:', z.deflateSync(Buffer.from('hi')).toString('hex')); } catch(e) { console.log('deflateSync THREW:', e.message); }
z.gzip(Buffer.from('hello'), (err, out) => console.log('async gzip:', err?err.message:('ok len='+out.length)));
console.log('brotliCompressSync typeof:', typeof z.brotliCompressSync);
