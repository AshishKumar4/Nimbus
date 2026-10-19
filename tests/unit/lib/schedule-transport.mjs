/**
 * A facet supervisor whose replies a schedule delivers. Each call of a kind
 * the schedule parks is sent to the session as it is asked, so the answer is
 * the session's at that moment, computed through its real handlers (an
 * ACQUIRE a delivery carries included: rpc.ts _acquireOnDelivery, its
 * arguments checked by the session's own schema); the reply then waits until
 * the schedule releases it. Nothing here makes up an answer: a poison is the
 * session's answer to an ACQUIRE asked from no cursor.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

/** The supervisor calls a schedule can park, by kind. A grant's recall poll and its release are never parked: they are how a peer's change reaches a holder. */
export const KINDS = Object.freeze({
  fsAcquire: 'acquire',
  fsAcquired: 'acquire',
  fsReadBatch: 'lookup',
  readdir: 'listing',
  fsList: 'listing',
  fsListTree: 'listing',
  fsReadDirectories: 'listing',
  writeBatchStream: 'wave',
  cpReadStdin: 'delivery',
});

/**
 * @param {{ park?: (kind: string, name: string) => boolean, note?: (line: string) => void }} [options]
 *   `park` decides, for each call no `hold` names, whether its reply waits
 *   for a release; `note` is told of each call, park and delivery.
 */
export function scheduleTransport({ park = () => false, note = () => {} } = {}) {
  /** @type {{ id: number, kind: string, name: string, deliver: () => void }[]} */
  const parked = [];
  /** Per kind, the replies to wait for: each the count of that kind's calls still to let through first. */
  const held = new Map();
  let ids = 0;
  let poisonNext = false;
  /** Replies delivered, and calls asked, so far: what a schedule's progress check reads. */
  const counts = { asked: 0, delivered: 0 };

  const waits = (kind, name) => {
    const holds = held.get(kind) ?? [];
    if (holds.length > 0) {
      const parks = holds[0] === 0;
      if (parks) holds.shift();
      else holds[0]--;
      return parks;
    }
    return park(kind, name);
  };

  /** `name`'s reply, asked now and delivered when released. */
  const supervise = (name) => async (call, args) => {
    const kind = KINDS[name];
    counts.asked++;
    let asked = args;
    if (poisonNext && name === 'fsAcquire') {
      poisonNext = false;
      asked = [null, 0, ...args.slice(2)];
    }
    const settled = await Promise.resolve(call(asked)).then((value) => ({ value }), (error) => ({ error }));
    const shown = `${name}(${JSON.stringify(asked).slice(1, -1).slice(0, 120)}) → ${'error' in settled ? `error ${settled.error?.code ?? settled.error?.message}` : JSON.stringify(settled.value)?.slice(0, 160)}`;
    if (waits(kind, name)) {
      const { promise, resolve } = Promise.withResolvers();
      const id = ++ids;
      parked.push({ id, kind, name, deliver: resolve });
      note(`    #${id} parked: ${shown}`);
      await promise;
      note(`    #${id} delivered`);
    } else note(`    ${shown}`);
    counts.delivered++;
    if ('error' in settled) throw settled.error;
    return settled.value;
  };

  return {
    /** For bootEngine's `supervise`: each parkable call, wrapped. */
    supervise: Object.fromEntries(Object.keys(KINDS).map((name) => [name, supervise(name)])),
    /** Park a reply of `kind`: the next, or the one after `skip` more go through. */
    hold(kind, skip = 0) { held.set(kind, [...(held.get(kind) ?? []), skip]); },
    /** The next ACQUIRE is asked from no cursor: the session answers it with a poison at its own cursor. */
    poison() { poisonNext = true; },
    /** Replies waiting, oldest first. */
    parked: () => parked.map(({ id, kind, name }) => ({ id, kind, name })),
    /** Deliver the parked reply `id` (or the oldest of `kind`). False when there is none. */
    release(which) {
      const at = typeof which === 'number' ? parked.findIndex((p) => p.id === which) : parked.findIndex((p) => which === undefined || p.kind === which);
      if (at < 0) return false;
      parked.splice(at, 1)[0].deliver();
      return true;
    },
    /** Deliver every parked reply, and park nothing more. */
    drain() {
      held.clear();
      park = () => false;
      while (parked.length > 0) parked.shift().deliver();
    },
    counts,
  };
}

/**
 * The facet supervisor (resident-body.mjs facetSupervisor) for `authority`,
 * each parkable call through `transport`: for a process launched by hand.
 */
export function supervisedFacet(facetSupervisor, authority, transport) {
  let forward;
  const own = {};
  for (const [name, wrap] of Object.entries(transport.supervise)) own[name] = (...args) => wrap((asked) => forward(name, asked), args);
  const handle = facetSupervisor(authority, own);
  forward = handle.forward;
  return handle;
}
