/**
 * pending-io.ts — a node process's outstanding I/O, for every generated node
 * runner (facets/manager.ts's two lifetimes, runtime/opencode-facet-runner.ts).
 *
 * `__pendingIO` holds what the process has started telling the session and
 * the session has not answered: its output batches, its children's stdin and
 * kills, its port registrations, its exit report. A boundary (a one-shot's
 * end, a resident's response or exit, opencode's teardown) waits for what is
 * in it. The shims push to it and check that it is an Array, so it is one.
 * Its settled entries, fulfilled or rejected, leave together once they are
 * half of it, so each costs a constant to remove: it holds at most twice what
 * is outstanding, and is empty when nothing is. A server that logs with no
 * HTTP traffic, or a long one-shot run, holds what is outstanding, not every
 * write it ever made.
 *
 * Spliced where the runner's process scope begins, before the shims.
 */
export declare const PENDING_IO_SOURCE = "\nconst __pendingIO = [];\n{\n  const append = __pendingIO.push.bind(__pendingIO);\n  const settled = new WeakSet();\n  let settledCount = 0;\n  const leave = (task) => {\n    settled.add(task);\n    if (++settledCount * 2 < __pendingIO.length) return;\n    let kept = 0;\n    for (let at = 0; at < __pendingIO.length; at++) {\n      const entry = __pendingIO[at];\n      if (!settled.has(entry)) __pendingIO[kept++] = entry;\n    }\n    __pendingIO.length = kept;\n    settledCount = 0;\n  };\n  __pendingIO.push = (...pushed) => {\n    for (const each of pushed) {\n      const task = Promise.resolve(each);\n      append(task);\n      const done = () => leave(task);\n      task.then(done, done);\n    }\n    return __pendingIO.length;\n  };\n}\n";
//# sourceMappingURL=pending-io.d.ts.map