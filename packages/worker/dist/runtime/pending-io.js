/**
 * pending-io.ts — a node process's outstanding I/O, for every generated node
 * runner (facets/manager.ts's two lifetimes, runtime/opencode-facet-runner.ts).
 *
 * `__pendingIO` holds what the process has started telling the session and
 * the session has not answered: its children's stdin and kills, its port
 * registrations, its umask, its exit report. A boundary (a one-shot's end, a
 * resident's response or exit, opencode's teardown) waits for what is in it.
 * The shims push to it and check that it is an Array, so it is one. Its
 * settled entries, fulfilled or rejected, leave together once they are half
 * of it, so each costs a constant to remove: it holds at most twice what is
 * outstanding, and is empty when nothing is. A server that logs with no HTTP
 * traffic, or a long one-shot run, holds what is outstanding, not every
 * call it ever made.
 *
 * Watching an entry settle does not take its failure: a rejection is raised
 * again, unhandled, so the runtime reports it (node-shims' unhandledrejection)
 * as it did when nothing watched the entry. A push site that handles a
 * failure pushes the handled promise (`task.catch(...)`), as the shims do.
 *
 * Spliced where the runner's process scope begins, before the shims.
 */
export const PENDING_IO_SOURCE = `
const __pendingIO = [];
{
  const append = __pendingIO.push.bind(__pendingIO);
  const settled = new WeakSet();
  let settledCount = 0;
  const leave = (task) => {
    settled.add(task);
    if (++settledCount * 2 < __pendingIO.length) return;
    let kept = 0;
    for (let at = 0; at < __pendingIO.length; at++) {
      const entry = __pendingIO[at];
      if (!settled.has(entry)) __pendingIO[kept++] = entry;
    }
    __pendingIO.length = kept;
    settledCount = 0;
  };
  __pendingIO.push = (...pushed) => {
    for (const each of pushed) {
      const task = Promise.resolve(each);
      append(task);
      task.then(() => leave(task), (reason) => {
        leave(task);
        void Promise.reject(reason);
      });
    }
    return __pendingIO.length;
  };
}
`;
