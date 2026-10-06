// @serial
// @tier slow — long; CI 105 s wall, 356 s CPU, 1.7 GiB peak (1 run, 2026-10-06)
// test262's language tests through the runtime-code interpreter: the
// "expressions-class" slice. The runner, the known deviations and what each slice holds
// are lib/test262.mjs.

import { runTest262Slice } from './lib/test262.mjs';

const { ok } = await runTest262Slice('expressions-class');
if (!ok) process.exit(1);
