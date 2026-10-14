/**
 * pending-io.ts — a node process's outstanding I/O, for every generated node
 * runner (facets/manager.ts's two lifetimes, runtime/opencode-facet-runner.ts).
 *
 * `__pendingIO` holds what the process has started telling the session and
 * the session has not answered: its output batches, its children's stdin and
 * kills, its port registrations, its exit report. A boundary (a one-shot's
 * end, a resident's response or exit, opencode's teardown) waits for what is
 * in it. The shims push to it and check that it is an Array, so it is one.
 * Each entry leaves as it settles, fulfilled or rejected: a server that logs
 * with no HTTP traffic, or a long one-shot run, holds what is outstanding,
 * not every write it ever made.
 *
 * Spliced where the runner's process scope begins, before the shims.
 */
export declare const PENDING_IO_SOURCE = "\nconst __pendingIO = [];\n{\n  const __append = __pendingIO.push.bind(__pendingIO);\n  __pendingIO.push = (...pushed) => {\n    for (const each of pushed) {\n      const task = Promise.resolve(each);\n      __append(task);\n      const leave = () => {\n        const at = __pendingIO.indexOf(task);\n        if (at >= 0) __pendingIO.splice(at, 1);\n      };\n      task.then(leave, leave);\n    }\n    return __pendingIO.length;\n  };\n}\n";
//# sourceMappingURL=pending-io.d.ts.map