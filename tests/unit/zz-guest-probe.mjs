import { residentGuest } from './lib/wasi-resident-guest.mjs';
const guest = await residentGuest();
try {
  await guest.open('home/user/probe.bin', { create: true, truncate: true, write: true });
  console.log('opened');
} catch (error) {
  console.log('open failed', error.errno, JSON.stringify(guest.stats()).slice(0, 1500));
}
await guest.dispose();
throw new Error('PROBE-END');
