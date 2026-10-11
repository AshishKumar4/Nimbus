/** Deliver the embedder's scheduled tasks to the runtime, on later turns. */
export function hostedLifecycle(ctx, runtime) {
  const alarms = new Map();
  return {
    waitUntil(task) { ctx.waitUntil(task); },
    async schedule(task, at) {
      clearTimeout(alarms.get(task));
      const alarm = setTimeout(() => {
        alarms.delete(task);
        ctx.waitUntil(runtime().onScheduled(task));
      }, Math.max(0, at - Date.now()));
      alarms.set(task, alarm);
    },
    async cancel(task) {
      clearTimeout(alarms.get(task));
      alarms.delete(task);
    },
  };
}
