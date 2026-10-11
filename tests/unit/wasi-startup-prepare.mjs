import assert from 'node:assert/strict';
import { residentGuest } from './lib/wasi-resident-guest.mjs';

const guest = await residentGuest();
try {
  guest.kernel.mkdir('home/user/lib/sub', { recursive: true });
  guest.kernel.chown('home/user/lib', 1000, 1000);
  guest.kernel.chown('home/user/lib/sub', 1000, 1000);
  guest.kernel.writeFile('home/user/lib/first.txt', 'first');
  guest.kernel.writeFile('home/user/lib/sub/second.txt', 'second');
  guest.kernel.chown('home/user/lib/first.txt', 1000, 1000);
  guest.kernel.chown('home/user/lib/sub/second.txt', 1000, 1000);
  await guest.P.__wasiPrepareFilesystem(['/home/user/lib']);
  const before = guest.stats();
  const first = await guest.open('home/user/lib/first.txt');
  const second = await guest.open('home/user/lib/sub/second.txt');
  assert.equal(await guest.pread(first, 100), 'first');
  assert.equal(await guest.pread(second, 100), 'second');
  await guest.close(first);
  await guest.close(second);
  assert.equal(guest.stats().lookups, before.lookups, 'bootstrap still learned each directory serially');
  assert.equal(guest.stats().listings, before.listings, 'bootstrap still listed each prepared directory serially');
  guest.kernel.writeFile('home/user/lib/sub/second.txt', 'changed');
  await guest.sleep(1);
  const changed = await guest.open('home/user/lib/sub/second.txt');
  assert.equal(await guest.pread(changed, 100), 'changed', 'preparing a namespace bypassed its next acquire barrier');
  await guest.close(changed);
} finally {
  await guest.dispose();
}
console.log('wasi-startup-prepare: runtime boot consumes one revision-dated namespace instead of serial directory discovery');
