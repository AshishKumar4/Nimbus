// The resident filesystem models' shared program vocabulary and seeded stream.
export const DIR = 'home/user/other';
export const NAMES = ['a', 'b', 'c'];
export const MAX_FDS = 3;

/** mulberry32: a small seeded generator. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A program of `length` steps from `seed`; `wasi` adds descriptor-path opens
 * and stream reads; `copies` adds copies (one name's file to another name)
 * and squeezes (the budget full for the next step), from a stream of their
 * own; `swaps` adds, from another, renames of the names' directory to a
 * longer name and back while a barrier begun before them waits, some with
 * the budget full; some awaited, a file opened beneath before the answer.
 */
export function program(seed, length = 40, { wasi = false, copies = false, swaps = false } = {}) {
  const random = generator(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const word = () => 'x'.repeat(1 + Math.floor(random() * 3)).replace(/x/g, () => pick(['p', 'q', 'r', 's']));
  // As utimensat(2) takes a time: explicit milliseconds, now, or kept.
  const time = () => pick([1_600_000_000_000 + Math.floor(random() * 9) * 1000, 'now', 'omit']);
  const steps = [];
  for (let i = 0; i < length; i++) {
    const roll = random();
    if (roll < 0.22) {
      const access = pick(['r', 'w', 'rw']);
      steps.push({ op: 'open', fd: Math.floor(random() * MAX_FDS), name: pick(NAMES), flags: {
        read: access !== 'w', write: access !== 'r', append: access !== 'r' && random() < 0.25,
        create: random() < 0.6, exclusive: random() < 0.2, truncate: random() < 0.3,
      } });
    } else if (roll < 0.40) steps.push({ op: 'write', fd: Math.floor(random() * MAX_FDS), offset: random() < 0.3 ? null : Math.floor(random() * 6), data: word() });
    else if (roll < 0.46) steps.push({ op: 'ftruncate', fd: Math.floor(random() * MAX_FDS), size: Math.floor(random() * 5) });
    else if (roll < 0.52) steps.push({ op: 'close', fd: Math.floor(random() * MAX_FDS) });
    else if (roll < 0.57) steps.push({ op: 'unlink', name: pick(NAMES) });
    else if (roll < 0.62) steps.push({ op: 'rename', from: pick(NAMES), to: pick(NAMES) });
    else if (roll < 0.645) steps.push({ op: 'chmod', name: pick(NAMES), mode: pick([0o644, 0o444, 0o600]) });
    else if (roll < 0.665) steps.push({ op: 'utimes', name: pick(NAMES), atime: time(), mtime: time() });
    else if (roll < 0.685) steps.push({ op: 'fchmod', fd: Math.floor(random() * MAX_FDS), mode: pick([0o644, 0o444, 0o600]) });
    else if (roll < 0.70) steps.push({ op: 'futimes', fd: Math.floor(random() * MAX_FDS), atime: time(), mtime: time() });
    else if (roll < 0.73) steps.push({ op: 'writeFile', name: pick(NAMES), data: word() });
    else if (roll < 0.75) steps.push({ op: 'readAsync', fd: Math.floor(random() * MAX_FDS) });
    else if (roll < 0.82) steps.push({ op: 'peer', kind: pick(['write', 'write', 'unlink', 'rename', 'chmod']), name: pick(NAMES), to: pick(NAMES), data: word(), mode: pick([0o644, 0o444]) });
    else if (roll < 0.92) steps.push({ op: 'deliver' });
    else steps.push({ op: 'catchUp' });
  }
  if (copies) {
    // Keep the original stream intact: copies and squeezes have their own, and so do swaps.
    const extra = generator(seed ^ 0x636f7079);
    const swap = generator(seed ^ 0x73776170);
    return steps.flatMap((step) => {
      const out = [];
      if (extra() < 0.08) out.push({ op: 'squeeze' });
      out.push(step);
      if (extra() < 0.1) {
        const from = NAMES[Math.floor(extra() * NAMES.length)];
        const to = NAMES[(NAMES.indexOf(from) + 1 + Math.floor(extra() * (NAMES.length - 1))) % NAMES.length];
        out.push({ op: 'copy', from, to });
      }
      // A swap with the budget full now and then: what the names beneath it grow by has no room.
      if (swaps && swap() < 0.12) out.push(...(swap() < 0.3 ? [{ op: 'squeeze' }] : []), { op: 'swap', awaited: swap() < 0.4 });
      return out;
    });
  }
  if (!wasi) return steps;
  // Keep the original stream intact; extra syscalls have a separate seeded stream.
  const codec = generator(seed ^ 0x77617369);
  return steps.flatMap((step) => {
    if (step.op === 'readAsync') return [step, { op: 'read', fd: step.fd }];
    if (step.op !== 'deliver' && step.op !== 'catchUp') return [step];
    const access = Math.floor(codec() * 3);
    return [step, { op: 'reopen', fd: Math.floor(codec() * MAX_FDS), via: Math.floor(codec() * MAX_FDS), flags: {
      read: access !== 1, write: access !== 0, append: access !== 0 && codec() < 0.25,
      create: false, exclusive: false, truncate: codec() < 0.3,
    } }];
  });
}
