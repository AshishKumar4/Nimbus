// A test's stub SUPERVISOR with a session's filesystem behind it.
//
// A process never runs user code before its namespace answers (CUTOVER #13):
// the launch lists the session's filesystem first. A test that drives a
// generated runner with a stub supervisor, for its output, exit or ports,
// therefore needs the listing ops a real session serves. withNamespace(stub)
// returns the stub with every filesystem op the session serves (fsList,
// fsAcquire, fsReadBatch, fsStorageGrant, stat, readFile, ...) routed to the
// session's real handlers over a fresh authority (lib/resident-body.mjs), for
// a process of the session's own. The stub's own methods win. `authority` is
// returned too, for a test that seeds files.

import { createAuthority, facetSupervisor } from './resident-body.mjs';
import { supervisorDouble } from './supervisor-double.mjs';

export function withNamespace(stub = {}, authority = createAuthority()) {
  const { forward } = facetSupervisor(authority);
  const merged = supervisorDouble((name, args) => (name in stub ? stub[name](...args) : forward(name, args)));
  return { supervisor: merged, authority };
}
