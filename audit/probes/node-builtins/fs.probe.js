const fs = require('fs');
console.log('keys:', Object.keys(fs).slice(0, 25).join(','));
console.log('readFileSync:', typeof fs.readFileSync);
console.log('promises:', typeof fs.promises);
try { fs.writeFileSync('/tmp/_probe', 'hi'); console.log('write+read:', fs.readFileSync('/tmp/_probe', 'utf8')); } catch(e) { console.log('write fail:', e.message); }
console.log('createReadStream:', typeof fs.createReadStream);
console.log('openSync typeof:', typeof fs.openSync);
console.log('realpathSync typeof:', typeof fs.realpathSync);
