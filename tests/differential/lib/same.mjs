// The comparison of a differential run (tests/differential/interpreter-frameworks.mjs):
// what a program can observe of two values, one from V8 and one from the interpreter.

const describe = (v) => (typeof v === 'function' ? `function ${v.name}` : typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) : `${typeof v} ${String(v).slice(0, 80)}`);

/** Whether two values a program observes are the same: equal primitives, functions of the same source, objects of the same shape. */
export function same(a, b, path, depth, seen) {
  if (Object.is(a, b)) return null;
  // A symbol made by Symbol(description) is a new one each time the module runs.
  if (typeof a === 'symbol' && typeof b === 'symbol' && Symbol.keyFor(a) === undefined && a.description === b.description) return null;
  if (typeof a !== typeof b) return `${path}: ${describe(a)} vs ${describe(b)}`;
  if (typeof a === 'function') {
    const sa = Function.prototype.toString.call(a);
    const sb = Function.prototype.toString.call(b);
    if (sa !== sb) return `${path}: function source differs`;
    if (a.name !== b.name || a.length !== b.length) return `${path}: function ${a.name}/${a.length} vs ${b.name}/${b.length}`;
    if (depth <= 0) return null;
    const pa = a.prototype, pb = b.prototype;
    if (typeof pa === 'object' && pa !== null && typeof pb === 'object' && pb !== null) {
      const ka = Object.getOwnPropertyNames(pa).join(','), kb = Object.getOwnPropertyNames(pb).join(',');
      if (ka !== kb) return `${path}.prototype: [${ka}] vs [${kb}]`;
    }
    return null;
  }
  if (typeof a !== 'object' || a === null || b === null) return `${path}: ${describe(a)} vs ${describe(b)}`;
  if (seen.has(a)) return null;
  seen.add(a);
  if (Object.prototype.toString.call(a) !== Object.prototype.toString.call(b)) return `${path}: ${describe(a)} vs ${describe(b)}`;
  if (typeof a.then === 'function') return null;
  if (depth <= 0) return null;
  const ka = Reflect.ownKeys(a).filter((k) => typeof k === 'string');
  const kb = Reflect.ownKeys(b).filter((k) => typeof k === 'string');
  if (ka.join(',') !== kb.join(',')) return `${path}: keys [${ka.slice(0, 12)}] vs [${kb.slice(0, 12)}]`;
  for (const k of ka.slice(0, 200)) {
    let va, vb;
    try { va = a[k]; } catch (e) { va = `throws ${e && e.message}`; }
    try { vb = b[k]; } catch (e) { vb = `throws ${e && e.message}`; }
    const d = same(va, vb, `${path}.${k}`, depth - 1, seen);
    if (d) return d;
  }
  return null;
}

