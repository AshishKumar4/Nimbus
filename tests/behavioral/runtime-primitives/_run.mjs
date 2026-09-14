// runtime-primitives/_run — the bounded, never-throwing terminal step the
// tsc probes share. A step that does not come back is an outcome the
// caller reports, never a hang or a crash.
import { stripAnsi } from '../_driver.mjs';

export async function run(t, line, timeoutMs) {
  const startedAt = Date.now();
  try {
    const r = await t.run(line, timeoutMs);
    return { ok: true, elapsed: r.elapsed, output: stripAnsi(r.output) };
  } catch (e) {
    return {
      ok: false,
      elapsed: Date.now() - startedAt,
      output: stripAnsi(t.buf),
      error: e.message,
    };
  }
}
