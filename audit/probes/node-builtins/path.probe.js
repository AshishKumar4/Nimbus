const p = require('path');
console.log('keys:', Object.keys(p).slice(0, 15).join(','));
console.log('join:', p.join('/a','b/../c','d.txt'));
console.log('resolve:', p.resolve('/a','./b','c'));
console.log('basename:', p.basename('/a/b/c.txt','.txt'));
console.log('dirname:', p.dirname('/a/b/c.txt'));
console.log('extname:', p.extname('foo.tar.gz'));
console.log('posix===path:', p.posix === p);
console.log('win32 typeof:', typeof p.win32);
