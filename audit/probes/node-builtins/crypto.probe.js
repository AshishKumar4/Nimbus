const c = require('crypto');
console.log('keys:', Object.keys(c).slice(0, 25).join(','));
console.log('randomBytes:', c.randomBytes(4).toString('hex'));
console.log('randomUUID:', c.randomUUID && c.randomUUID());
const h = c.createHash('sha256');
h.update('hello');
console.log('sha256(hello):', h.digest('hex'));
console.log('expected real:    2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
const h2 = c.createHash('md5');
h2.update('hello');
console.log('md5(hello):', h2.digest('hex'));
console.log('expected real: 5d41402abc4b2a76b9719d911017c592');
try { console.log('hmac:', c.createHmac('sha256', 'k').update('m').digest('hex')); } catch(e) { console.log('hmac fail:', e.message); }
console.log('createCipheriv:', typeof c.createCipheriv);
console.log('scrypt:', typeof c.scrypt);
console.log('pbkdf2:', typeof c.pbkdf2);
console.log('generateKeyPair:', typeof c.generateKeyPair);
