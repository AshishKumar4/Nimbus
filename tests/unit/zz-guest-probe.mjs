import { residentGuest } from './lib/wasi-resident-guest.mjs';
const guest = await residentGuest();
const writer = await guest.open('home/user/refused.bin', { create: true, truncate: true, write: true });
guest.kernel.chown('home/user/refused.bin', 0, 0);
guest.kernel.chmod('home/user/refused.bin', 0o444);
console.log('write', await guest.write(writer, 'lost bytes'));
try {
  const reader = await guest.open('home/user/refused.bin');
  console.log('reader opened', reader);
} catch (error) {
  console.log('reader failed', error.errno, JSON.stringify(guest.stats()).slice(0, 2500));
}
await guest.dispose();
throw new Error('PROBE-END');
