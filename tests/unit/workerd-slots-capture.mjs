#!/usr/bin/env bun
// createWorkerdSlots (node-inspect-host.ts WORKERD_SLOTS_SOURCE) holds
// Array.prototype.includes only from the start of a read to workerd's first
// cycle check, which no program code runs before, and lets go of it
// whatever happens: when the inspect throws inside that window or after it,
// and when a read is nested in another. A stand-in for workerd's inspect
// follows its protocol here (the cycle check first, then stylize for a
// primitive one level in); console-format-matches-node-workerd reads real
// slots in workerd.
import assert from 'node:assert/strict';
import { types } from 'node:util';

import { WORKERD_SLOTS_SOURCE } from '../../packages/worker/src/runtime/node-inspect-host.ts';

const createWorkerdSlots = new Function(`return (${WORKERD_SLOTS_SOURCE});`)();
const includes = Array.prototype.includes;

// Thrown before the first cycle check.
{
  const slots = createWorkerdSlots({ types, inspect() { throw new Error('inside the window'); } });
  assert.throws(() => slots.getPromiseDetails(Promise.resolve(1)), /inside the window/);
  assert.equal(Array.prototype.includes, includes, 'let go when the inspect throws before its first cycle check');
}

// Thrown after it.
{
  const slots = createWorkerdSlots({ types, inspect(value) { [].includes(value); throw new Error('after the window'); } });
  assert.throws(() => slots.getPromiseDetails(Promise.resolve(1)), /after the window/);
  assert.equal(Array.prototype.includes, includes, 'let go when the inspect throws after it');
}

// A fulfilled promise as workerd formats one, with a read nested inside it.
{
  let slots;
  const inner = Promise.resolve('inner');
  slots = createWorkerdSlots({
    types,
    inspect(value, options) {
      const seen = [];
      seen.includes(value);
      assert.equal(Array.prototype.includes, includes, 'let go at the first cycle check');
      assert.notEqual(seen.includes, includes, "from then the hook is the call's own array's");
      seen.push(value);
      if (value !== inner) assert.deepEqual(slots.getPromiseDetails(inner), [1, 'inner'], 'a read nested in another');
      options.stylize(value === inner ? "'inner'" : '42', value === inner ? 'string' : 'number');
      seen.pop();
      return 'Promise { }';
    },
  });
  assert.deepEqual(slots.getPromiseDetails(Promise.resolve(42)), [1, 42], 'the outer read keeps its own values');
  assert.equal(Array.prototype.includes, includes);
}

console.log('workerd-slots-capture: Array.prototype.includes is held only until the first cycle check, and let go however a read ends');
