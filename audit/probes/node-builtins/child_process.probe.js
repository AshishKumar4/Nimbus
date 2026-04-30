const cp = require('child_process');
console.log('keys:', Object.keys(cp).slice(0, 15).join(','));
try { cp.execSync('echo hi'); console.log('execSync ok'); } catch(e) { console.log('execSync THREW:', e.message); }
cp.exec('echo hi', (err, stdout) => console.log('exec err:', err && err.message, 'stdout:', JSON.stringify(stdout)));
const child = cp.spawn('echo', ['hi']);
child.on('error', e => console.log('spawn error:', e.message));
child.on('exit', c => console.log('spawn exit:', c));
setTimeout(()=>{}, 1000);
