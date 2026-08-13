/**
 * ruby-resident.ts — a Ruby program that keeps serving, as a Durable Object
 * facet.
 *
 * The half of the Ruby runtime that names workerd. Everything about running
 * the interpreter is in `@nimbus-sh/core`; this is the substrate a program
 * that outlives its invocation needs — an actor that stays alive between
 * requests, with inbound HTTP routed into the socket the program bound. A
 * host without one supplies no {@link RubyResidentStart}, and such a program
 * is refused rather than quietly run as a one-shot that dies with the call.
 */
import { type RubyResidentStart } from '@nimbus-sh/core/runtime/ruby-runner.js';
import type { FacetManager } from '../facets/manager.js';
/**
 * Start a Ruby program that binds a port as its own process, so it outlives
 * the invocation that started it.
 */
export declare function rubyResidentStart(facetMgr: FacetManager): RubyResidentStart;
export declare function buildRubySocketProcessWorker(preamble: string): string;
//# sourceMappingURL=ruby-resident.d.ts.map