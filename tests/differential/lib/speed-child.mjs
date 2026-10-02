// One speed measurement (interpreter-speed.mjs), run as `node speed-child.mjs
// <loop|ajv>` natively, or with string code generation refused and
// lib/interpret-preload.mjs routing the Function constructors to the
// interpreter. The work is a function built from a string either way; prints
// the best of five runs in milliseconds.

import { createRequire } from 'node:module';
import { join } from 'node:path';

const [, , work] = process.argv;
let run;
if (work === 'loop') {
  const f = new Function('n', 'let s = 0; for (let i = 0; i < n; i++) { s += i * i % 7; } return s;');
  run = () => f(3e6);
} else {
  const Ajv = createRequire(join(process.cwd(), 'package.json'))('ajv');
  const schema = {
    type: 'object', required: ['id', 'name', 'tags'], additionalProperties: false,
    properties: {
      id: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 64 },
      email: { type: 'string', pattern: '^[^@]+@[^@]+$' }, tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      nested: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'boolean' } }, additionalProperties: false },
    },
  };
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const good = { id: 7, name: 'n', email: 'a@b', tags: ['x', 'y'], nested: { a: 1, b: true } };
  const bad = { id: 0, name: '', tags: [1], extra: 1 };
  run = () => {
    let ok = 0;
    for (let i = 0; i < 200000; i++) if (validate(i % 2 ? good : bad)) ok++;
    return ok;
  };
}
let best = Infinity;
for (let i = 0; i < 5; i++) {
  const t0 = process.hrtime.bigint();
  run();
  best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
}
console.log(JSON.stringify({ work, ms: best }));
