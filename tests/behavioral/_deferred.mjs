// Probes whose failure a release may ship with: each one named, with the one
// assertion in it that may fail, why, who approved it and when, who owns the
// fix, and where it is tracked.
//
// The release matrix (scripts/ci/release.mjs, graded by
// scripts/ci/lib/matrix.mjs) is green if and only if every red row is a
// probe listed here that failed exactly as approved. The probe ran to its
// end (its asserter's summary is there), the named assertion failed with
// the approved failure itself (HTTP status/page title or exact detail),
// and every other assertion in it passed, setup and
// cleanup included. Any other
// red is red, a listed probe's included. A listed probe still runs, and its
// output is kept in the release's staged.json. If a listed probe passes,
// the run is red ("<probe> passes; remove its deferral"), and so is one
// that did not run at all, so an entry ends the moment its fix lands and
// cannot sit here unseen. promote.mjs prints every deferral that graded
// the release it promotes.
//
// THIS LIST IS THE USER'S. Nothing is added to it, and no other mechanism
// uses it, without a new approval from the user, recorded in the entry's
// `approved` ("user, YYYY-MM-DD"). An agent that wants a red probe to ship
// asks for that approval; it does not write the entry and then ask.
// The hosted-demo checks, the production-only checks and the session
// ledger can never be deferred: the record refuses to load an entry for any
// of them (validateDeferrals).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED_DEMO_CHECKS, PRODUCTION_ONLY_CHECKS } from './_probe-target-skips.mjs';
import { z } from 'zod/v4';

const approvedFailure = z.union([
  z.object({ status: z.number().int(), title: z.string().trim().min(1) }).strict(),
  z.object({ detail: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]) }).strict(),
]);

/**
 * @typedef {object} Deferral
 * @property {string} probe      the probe, as run-all names it: its path under tests/behavioral, without .mjs
 * @property {string} assertion  the one assertion that may fail, its exact label (makeAsserter's check name)
 * @property {{ status: number, title: string } | { detail: string | string[] }} failure  an exact HTTP status/page title or exact required fragments of the ✗ detail
 * @property {string} reason     what fails, and why it may ship anyway
 * @property {string} approved   "user, YYYY-MM-DD"
 * @property {string} owner      who fixes it
 * @property {string} tracking   where the fix is tracked
 */

/** Never deferrable, whatever the record says. */
export const NEVER_DEFERRED = new Set([...HOSTED_DEMO_CHECKS, ...PRODUCTION_ONLY_CHECKS, 'session-ledger']);

/**
 * `entries`, if every one is a deferral the record may hold; throws naming
 * the first that is not: a field missing, an approval that is not the
 * user's and dated, a probe that does not exist or is listed twice, or one
 * that can never be deferred.
 *
 * @param {Deferral[]} entries
 * @returns {Deferral[]}
 */
export function validateDeferrals(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const name = entry?.probe ?? '(no probe)';
    for (const field of ['probe', 'assertion', 'reason', 'approved', 'owner', 'tracking']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) throw new Error(`_deferred.mjs: ${name}: ${field} is required`);
    }
    if (!approvedFailure.safeParse(entry.failure).success) {
      throw new Error(`_deferred.mjs: ${name}: failure { status, title } or { detail } is required: the approved failure itself, not only where it happens`);
    }
    if (NEVER_DEFERRED.has(entry.probe)) throw new Error(`_deferred.mjs: ${entry.probe} can never be deferred`);
    if (!/^user, \d{4}-\d{2}-\d{2}$/.test(entry.approved)) throw new Error(`_deferred.mjs: ${entry.probe}: approved must be the user's, dated ("user, YYYY-MM-DD"), not ${JSON.stringify(entry.approved)}`);
    if (!existsSync(join(import.meta.dirname, `${entry.probe}.mjs`))) throw new Error(`_deferred.mjs: ${entry.probe}: no such probe`);
    if (seen.has(entry.probe)) throw new Error(`_deferred.mjs: ${entry.probe} is listed twice`);
    seen.add(entry.probe);
  }
  return entries;
}

/** @type {Deferral[]} */
export const DEFERRED = validateDeferrals([
  {
    probe: 'frameworks/nuxt-real',
    assertion: 'nuxt dev SSR serves the Vue app through the port route on its first run',
    failure: { detail: ['HTTP 502: {"error":"'] },
    reason: "nuxt dev's own heap plus its wasm bindings exceed a facet's ~112 MiB sustained memory, so its process is lost (released, or reset for memory) "
      + 'while the app builds and the port route answers 502. Scaffolding, npm install and cleanup must still pass; only the first-run serve may fail.',
    approved: 'user, 2026-10-09',
    owner: 'Main',
    tracking: 'nuxt dev exceeds the per-facet memory budget (user decision pending: isolate split or platform change)',
  },
  {
    probe: 'frameworks/remix-real',
    assertion: 'react-router dev serves the app through the port route on its first run',
    failure: { detail: ['"last":"no resident process was launched"', '@tailwindcss/oxide/index.js'] },
    reason: "React Router dev's config load fails on @tailwindcss/oxide's missing native binding; its wasm32 build is staged by "
      + 'work/remix-first-run. Only the first-run serve assertion may fail; setup, install, conditional imports and cleanup must pass.',
    approved: 'user, 2026-10-08',
    owner: 'OutstandingManatee',
    tracking: 'work/remix-first-run (oxide binding, first-run staging), then one-process for the relaunched child',
  },
]);
