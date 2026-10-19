// A Worker whose requests share the isolate's supervisor budget, as a
// session's requests do: one holds all of it, one waits for a share and its
// client leaves, one gives the budget back, one asks for all of it.
import { acquireSupervisorAllocation, readSupervisorAllocationBudget, type SupervisorAllocationLease } from '../../../packages/platform/src/heavy-alloc-coord.ts';

const MiB = 1024 * 1024;
let held: SupervisorAllocationLease | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    const budget = readSupervisorAllocationBudget;
    switch (new URL(request.url).pathname) {
      case '/ready':
        return new Response('ok');
      case '/hold':
        held = await acquireSupervisorAllocation(budget().capacity);
        return Response.json(budget());
      case '/wait': {
        // Its client leaves while it waits: workerd cancels this request, and with it every continuation of its own.
        const lease = await acquireSupervisorAllocation(10 * MiB);
        lease.release();
        return Response.json(budget());
      }
      case '/release':
        held?.release();
        held = null;
        return Response.json(budget());
      case '/stats':
        return Response.json(budget());
      case '/whole': {
        try {
          const lease = await acquireSupervisorAllocation(budget().capacity, AbortSignal.timeout(5000));
          lease.release();
          return Response.json({ granted: true, ...budget() });
        } catch {
          return Response.json({ granted: false, ...budget() });
        }
      }
      default:
        return new Response('not found', { status: 404 });
    }
  },
};
