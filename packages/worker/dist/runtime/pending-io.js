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
export const PENDING_IO_SOURCE = `
const __pendingIO = [];
{
  const __append = __pendingIO.push.bind(__pendingIO);
  __pendingIO.push = (...pushed) => {
    for (const each of pushed) {
      const task = Promise.resolve(each);
      __append(task);
      const leave = () => {
        const at = __pendingIO.indexOf(task);
        if (at >= 0) __pendingIO.splice(at, 1);
      };
      task.then(leave, leave);
    }
    return __pendingIO.length;
  };
}
`;
