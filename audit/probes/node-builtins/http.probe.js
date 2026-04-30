const h = require('http');
console.log('keys:', Object.keys(h).slice(0, 15).join(','));
console.log('createServer:', typeof h.createServer);
try { const s = h.createServer((req,res)=>res.end('ok')); console.log('Server constructed:', !!s); } catch(e) { console.log('createServer threw:', e.message); }
try { h.request('http://example.com', r=>{}); console.log('request OK'); } catch(e) { console.log('request threw:', e.message); }
try { h.get('http://example.com', r=>{}); console.log('get OK'); } catch(e) { console.log('get threw:', e.message); }
