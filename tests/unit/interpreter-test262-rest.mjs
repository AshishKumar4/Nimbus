// @serial
// @tier slow — long; CI 84 s wall, 284 s CPU, 1.3 GiB peak (1 run, 2026-10-06)
// test262's language tests through the runtime-code interpreter: the
// "rest" slice. The runner, the known deviations and what each slice holds
// are lib/test262.mjs.

import { runTest262Slice } from './lib/test262.mjs';

const { ok } = await runTest262Slice('rest');
if (!ok) process.exit(1);
