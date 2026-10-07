// @serial
// @tier slow — long; CI 100 s wall, 328 s CPU, 1.4 GiB peak (1 run, 2026-10-06)
// test262's language tests through the runtime-code interpreter: the
// "statements-class" slice. The runner, the known deviations and what each slice holds
// are lib/test262.mjs.

import { runTest262Slice } from './lib/test262.mjs';

const { ok } = await runTest262Slice('statements-class');
if (!ok) process.exit(1);
