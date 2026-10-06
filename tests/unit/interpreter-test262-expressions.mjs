// @serial
// test262's language tests through the runtime-code interpreter: the
// "expressions" slice. The runner, the known deviations and what each slice holds
// are lib/test262.mjs.

import { runTest262Slice } from './lib/test262.mjs';

const { ok } = await runTest262Slice('expressions');
if (!ok) process.exit(1);
