// W10 functional: R2 get with range option

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/binding-r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

const body = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';  // 26 bytes
await r2.put('alphabet.txt', body);

// {offset, length}
const r1 = await r2.get('alphabet.txt', { range: { offset: 5, length: 5 } });
eq('range[5,5)+5 text', await r1.text(), 'FGHIJ');

// {offset} only — read from offset to EOF
const r2_ = await r2.get('alphabet.txt', { range: { offset: 20 } });
eq('range from offset 20 returns tail', await r2_.text(), 'UVWXYZ');

// {suffix} — read last N bytes
const r3 = await r2.get('alphabet.txt', { range: { suffix: 3 } });
eq('suffix 3 returns last 3 bytes', await r3.text(), 'XYZ');

// out-of-range offset returns empty body but successful response
const r4 = await r2.get('alphabet.txt', { range: { offset: 100 } });
ok('offset > size returns object', !!r4);
eq('offset > size returns empty text', await r4.text(), '');

summary('w10/functional/r2-range-read');
