const name = 'fs';
try { const m = require(name); console.log('variable require ok:', typeof m.readFileSync); }
catch(e) { console.log('variable require failed:', e.message); }