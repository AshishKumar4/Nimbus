const q = require('querystring');
console.log('keys:', Object.keys(q).slice(0, 10).join(','));
console.log('parse default:', JSON.stringify(q.parse('a=1&b=2')));
console.log('parse custom-sep:', JSON.stringify(q.parse('a=1;b=2', ';')));
console.log('stringify:', q.stringify({a:1,b:'x y'}));
