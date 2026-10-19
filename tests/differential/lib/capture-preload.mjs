// Records the runtime code a native framework run produces
// (interpreter-memory.mjs), loaded with `node --import`: every function a
// Function constructor builds ({ kind, params, body }) and every module file
// loaded from a Vite temp directory (the bundled config), as JSON files in
// NIMBUS_CAPTURE_DIR. The program runs unchanged.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';

import { hookFunctionConstructors } from './constructor-hooks.mjs';

const dir = process.env.NIMBUS_CAPTURE_DIR;
mkdirSync(join(dir, 'functions'), { recursive: true });
mkdirSync(join(dir, 'modules'), { recursive: true });
const record = (sub, value) => {
  const text = JSON.stringify(value);
  writeFileSync(join(dir, sub, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`), text);
};

hookFunctionConstructors(({ kind, params, body, native }) => {
  record('functions', { kind, params, body });
  return native;
});

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (/\/\.vite-temp\/|\.timestamp-/.test(url) && result.source) {
      record('modules', { url, text: typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source) });
    }
    return result;
  },
});
