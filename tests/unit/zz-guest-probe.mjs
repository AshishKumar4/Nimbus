import { residentGuest } from './lib/wasi-resident-guest.mjs';
const guest = await residentGuest();
const writer = await guest.open('home/user/refused.bin', { create: true, truncate: true, write: true });
guest.kernel.chown('home/user/refused.bin', 0, 0);
guest.kernel.chmod('home/user/refused.bin', 0o444);
console.log('write', await guest.write(writer, 'lost bytes'));
const before = JSON.stringify(guest.stats());
let error = null;
try {
  await guest.open('home/user/refused.bin');
} catch (e) { error = e.errno; }
console.log('reader', error, '\nBEFORE', before, '\nAFTER', JSON.stringify(guest.stats()));
// The same open again, and a stat: which one fails?
try { console.log('stat errno', await guest.stat?.('home/user/refused.bin')); } catch (e) { console.log('stat threw', e.errno); }
await guest.dispose();
throw new Error('PROBE-END');
