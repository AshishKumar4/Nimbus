/**
 * cpython-resident.ts — a Python program that keeps serving, as a Durable
 * Object facet.
 *
 * The half of the CPython runtime that names workerd. Everything about running
 * the interpreter is in `@nimbus-sh/core`; this is the substrate a program that
 * outlives its invocation needs — an actor that stays alive between requests,
 * with inbound HTTP routed into the socket the program bound. A host without
 * one supplies no {@link CPythonResidentStart} and such a program is refused
 * rather than quietly run as a one-shot that dies with the call.
 */
import { type CPythonResidentStart } from '@nimbus-sh/core/runtime/cpython-runner.js';
import type { FacetManager } from '../facets/manager.js';
/**
 * The worker source for a resident Python process. Same shape as
 * buildRubySocketProcessWorker: the socket kernel and the interpreter live in a
 * DurableObject, startProcess runs the program until it stops, and inbound
 * requests arrive on handleHttpRequest and are dispatched into the server the
 * program registered before exiting.
 */
export declare function buildCPythonSocketProcessWorker(preamble: string): string;
/**
 * Start a program that binds a port as its own process, so it outlives the
 * invocation that started it. Mirrors spawnRubySocketProcess.
 */
export declare function cpythonResidentStart(facetMgr: FacetManager): CPythonResidentStart;
//# sourceMappingURL=cpython-resident.d.ts.map