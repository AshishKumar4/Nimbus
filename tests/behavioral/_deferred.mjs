// User-approved release exceptions: an exact failure a release may ship with,
// or a probe excluded from the release matrix. Both name the probe, reason,
// dated approval, owner and tracking item. Normal probe runs use neither.
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
// An entry with excluded: true instead skips the whole probe in the release
// matrix, with no assertion or failure to match. It is kept in staged.json
// and printed by release.mjs and promote.mjs alongside the deferrals.
//
// THIS LIST IS THE USER'S. Nothing is added to it, and no other mechanism
// uses it, without a new approval from the user, recorded in the entry's
// `approved` ("user, YYYY-MM-DD"). An agent that wants a red probe to ship
// asks for that approval; it does not write the entry and then ask.
// The hosted-demo checks, the production-only checks and the session
// ledger can never be deferred or excluded: the record refuses an entry for any
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
 * @typedef {object} ReleaseExceptionInfo
 * @property {string} probe      the probe, as run-all names it: its path under tests/behavioral, without .mjs
 * @property {string} reason     why the failure or exclusion is allowed for release
 * @property {string} approved   "user, YYYY-MM-DD"
 * @property {string} owner      who fixes it
 * @property {string} tracking   where the fix is tracked
 */

/**
 * @typedef {ReleaseExceptionInfo & { excluded?: false, assertion: string, failure: { status: number, title: string } | { detail: string | string[] } }} Deferral
 * @typedef {ReleaseExceptionInfo & { excluded: true, assertion?: never, failure?: never }} Exclusion
 * @typedef {Deferral | Exclusion} ReleaseException
 */

/** Never deferrable or excludable, whatever the record says. */
export const NEVER_DEFERRED = new Set([...HOSTED_DEMO_CHECKS, ...PRODUCTION_ONLY_CHECKS, 'session-ledger']);

/**
 * `entries`, if every one is a release exception the record may hold; throws naming
 * the first that is not: a field missing, an approval that is not the
 * user's and dated, a probe that does not exist or is listed twice, or one
 * that can never be deferred or excluded.
 *
 * @param {ReleaseException[]} entries
 * @returns {ReleaseException[]}
 */
export function validateDeferrals(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const name = entry?.probe ?? '(no probe)';
    for (const field of ['probe', 'reason', 'approved', 'owner', 'tracking']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) throw new Error(`_deferred.mjs: ${name}: ${field} is required`);
    }
    if (NEVER_DEFERRED.has(entry.probe)) throw new Error(`_deferred.mjs: ${entry.probe} can never be deferred or excluded`);
    if (entry.excluded !== undefined && typeof entry.excluded !== 'boolean') throw new Error(`_deferred.mjs: ${name}: excluded must be true or false`);
    if (entry.excluded === true) {
      if (Object.hasOwn(entry, 'failure') || Object.hasOwn(entry, 'assertion')) {
        throw new Error(`_deferred.mjs: ${name}: an excluded probe must not specify a failure or assertion`);
      }
    } else {
      if (typeof entry.assertion !== 'string' || !entry.assertion.trim()) throw new Error(`_deferred.mjs: ${name}: assertion is required`);
      if (!approvedFailure.safeParse(entry.failure).success) {
        throw new Error(`_deferred.mjs: ${name}: failure { status, title } or { detail } is required: the approved failure itself, not only where it happens`);
      }
    }
    if (!/^user, \d{4}-\d{2}-\d{2}$/.test(entry.approved)) throw new Error(`_deferred.mjs: ${entry.probe}: approved must be the user's, dated ("user, YYYY-MM-DD"), not ${JSON.stringify(entry.approved)}`);
    if (!existsSync(join(import.meta.dirname, `${entry.probe}.mjs`))) throw new Error(`_deferred.mjs: ${entry.probe}: no such probe`);
    if (seen.has(entry.probe)) throw new Error(`_deferred.mjs: ${entry.probe} is listed twice`);
    seen.add(entry.probe);
  }
  return entries;
}

/** @type {ReleaseException[]} */
export const DEFERRED = validateDeferrals([
  {
    probe: 'frameworks/nuxt-real',
    excluded: true,
    reason: "nuxt dev's own heap plus its wasm bindings exceed a facet's ~112 MiB sustained memory; the failure shows up nondeterministically",
    approved: 'user, 2026-10-10',
    owner: 'Main',
    tracking: 'nuxt memory: isolate split or platform change (user decision)',
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
