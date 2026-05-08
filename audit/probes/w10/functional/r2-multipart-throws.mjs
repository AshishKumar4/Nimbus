// W10 functional: R2 multipart-upload methods throw clear "not supported"
// errors rather than being silently undefined. (See plan §13 review B4.)

import { ok, summary, rejects } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/bindings/r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

ok('createMultipartUpload exists (function)', typeof r2.createMultipartUpload === 'function');
ok('resumeMultipartUpload exists (function)', typeof r2.resumeMultipartUpload === 'function');

await rejects(
  'createMultipartUpload throws with "not supported" message',
  async () => { await r2.createMultipartUpload('big.bin'); },
  'not supported',
);
await rejects(
  'resumeMultipartUpload throws with "not supported" message',
  async () => { await r2.resumeMultipartUpload('big.bin', 'fake-id'); },
  'not supported',
);

summary('w10/functional/r2-multipart-throws');
