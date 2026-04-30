const U = require('url');
console.log('keys:', Object.keys(U).slice(0, 12).join(','));
console.log('URL.pathname:', new U.URL('http://a.com/p?x=1').pathname);
console.log('parse:', U.parse('http://a.com/p?x=1').query);
console.log('fileURLToPath:', U.fileURLToPath('file:///a/b'));
console.log('pathToFileURL:', String(U.pathToFileURL('/x/y')));
