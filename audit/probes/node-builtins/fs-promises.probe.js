const fsp = require('fs/promises');
console.log('keys:', Object.keys(fsp).slice(0, 20).join(','));
fsp.writeFile('/tmp/_p', 'x').then(()=>fsp.readFile('/tmp/_p','utf8')).then(v=>console.log('roundtrip:',v)).catch(e=>console.log('err:',e.message));
console.log('cp typeof:', typeof fsp.cp);
console.log('rm typeof:', typeof fsp.rm);
console.log('open typeof:', typeof fsp.open);
