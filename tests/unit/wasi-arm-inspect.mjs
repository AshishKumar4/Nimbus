import { residentGuest, USER } from './lib/wasi-resident-guest.mjs';

const outcome = async (work) => { try { return await work(); } catch (error) { return { code: error.code, errno: error.errno, message: error.message }; } };
for (const root of ['home/user', 'home/user/other']) {
  const guest = await residentGuest();
  try {
    guest.kernel.mkdir(root, { recursive: true });
    guest.kernel.chown(root, USER.uid, USER.gid);
    guest.inbound();
    const fd = await guest.open(`${root}/a`, { create: true, truncate: true, write: true });
    await guest.write(fd, 'held');
    await guest.flush();
    for (let i = 0; i < 16; i++) {
      const warm = await guest.open(`${root}/warm`, { create: true, truncate: true, write: true });
      await guest.write(warm, 'warm');
      await guest.close(warm);
      await guest.flush();
      await guest.sleep(0);
    }
    console.log(root, 'warm', JSON.stringify(guest.stats()));
    console.log(root, 'before rename', JSON.stringify(guest.stats()));
    await guest.rename(`${root}/a`, `${root}/b`);
    console.log(root, 'reopen', JSON.stringify(await outcome(() => guest.open(`dev/fd/${fd}`, { write: true, truncate: true }))));
    console.log(root, 'after reopen', JSON.stringify(guest.stats()));
  } finally { await guest.end(); await guest.dispose(); }
}
{
  const guest = await residentGuest();
  try {
    const fd = await guest.open('home/user/a', { create: true, truncate: true, write: true });
    await guest.write(fd, 'abc');
    console.log('unlink before', JSON.stringify(await guest.fstat(fd)));
    guest.kernel.unlink('home/user/a');
    console.log('unlink after', JSON.stringify(await guest.fstat(fd)));
  } finally { await guest.end(); await guest.dispose(); }
}
process.exit(1);
