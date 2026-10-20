// Why a probe's session was reset or refused, from the platform's own record
// of it: Workers Logs and the exception events of its traces, read from this
// machine with the observability token (never from a container). A probe's
// symptom (a socket closing 1006, a 503 naming E_NIMBUS_DO_OVERLOADED) only
// says which rows to look up; the class comes from the exact error the
// platform logged on the session's own object.
//
// Measured 2026-10-14..16 over 48 such rows of full runs of main commits:
// 11 platform storage resets (the same error on armada and kinu Workers
// those days), 13 isolate memory resets (the sessions' own memory, alone or
// with co-tenants reset at the same instant), 2 storage timeouts, 1 code
// update (a target redeployed under its run), the rest unattributed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cfApi } from './cloudflare-api.mjs';

/** The token with Workers Observability access; wrangler's OAuth login gets 403 on the telemetry API. */
export const OBSERVABILITY_TOKEN_FILE = process.env.NIMBUS_OBSERVABILITY_TOKEN_FILE || join(homedir(), '.config', 'nimbus', 'cf-observability-token');

/**
 * The classes, each by the platform's exact error. Only a platform storage
 * reset is the platform's alone: the same error reached Workers that share
 * no code with Nimbus. The others are Nimbus's own memory, a storage
 * operation that ran too long, or a deploy.
 */
export const RESET_CLASSES = [
  { kind: 'platform storage reset', error: 'Internal error in Durable Object storage caused object to be reset', platform: true },
  { kind: 'isolate memory reset', error: "Durable Object's isolate exceeded its memory limit and was reset", platform: false },
  { kind: 'storage timeout reset', error: 'Durable Object storage operation exceeded timeout which caused object to be reset', platform: false },
  { kind: 'code update reset', error: 'Durable Object reset because its code was updated', platform: false },
  { kind: 'overloaded', error: 'Durable Object is overloaded', platform: false },
];

/** Whether a red row shows the symptom a reset or an overload leaves: a socket of its closed 1006, or a 503 naming the overload. */
export const showsResetSymptom = (row) => (row.sessions ?? []).some((session) => session.abnormalCloses.length > 0)
  || row.output.includes('E_NIMBUS_DO_OVERLOADED');

/** The telemetry queries one session's attribution makes at most (its object's lookup aside): its reads, its full ones paged by halving their span, and its traces. */
const ATTRIBUTION_QUERIES = 64;

/** Workers Logs filters for the objects of `base`'s Worker: a Preview by its slug, a Worker by its name. */
function scopeOf(base) {
  const label = new URL(base).hostname.split('.')[0];
  const preview = /^(.+)-nimbus-probe-previews$/.exec(label);
  return preview ? { key: '$workers.preview.slug', value: preview[1] } : { key: '$workers.scriptName', value: label };
}

/**
 * A telemetry reader for `account`, or null without an account or a token.
 * `query(from, to, filters, { needle, limit })` resolves to events.
 */
export function telemetry({ account, tokenFile = OBSERVABILITY_TOKEN_FILE, request = globalThis.fetch }) {
  if (!account || !existsSync(tokenFile)) return null;
  const token = readFileSync(tokenFile, 'utf8').trim();
  return {
    /**
     * @param {number} from
     * @param {number} to
     * @param {string[][]} filters  each [key, value, operation (default eq), type (default string)]
     * @param {{ needle?: string, limit?: number }} [options]
     */
    async query(from, to, filters, { needle, limit = 2000 } = {}) {
      const body = {
        queryId: 'remote-probes-attribution', timeframe: { from, to }, view: 'events', limit,
        parameters: { filters: filters.map(([key, value, operation = 'eq', type = 'string']) => ({ key, operation, type, value })), filterCombination: 'and',
          ...(needle ? { needle: { value: needle, isRegex: false, matchCase: true } } : {}) },
      };
      const answered = await cfApi('/workers/observability/telemetry/query', { account, token, method: 'POST', body, signal: AbortSignal.timeout(60_000), fetch: request });
      if (!answered.ok) throw new Error(`telemetry query answered ${answered.status}`);
      return answered.result?.events?.events ?? [];
    },
  };
}

/** The platform errors an event carries: its log line, or the exception its invocation ended with. */
const errorsOf = (event) => [event.source?.message, event.$metadata?.error].filter((text) => typeof text === 'string');

/**
 * Attribute one session (a row's `sessions` entry, from the run's ledger):
 * its object (by its sid, within its Worker), then every reset class whose
 * exact error that object logged, or its failed invocations' traces
 * recorded, between its mint and `until`. Resolves to { sid, object,
 * classes: [{ kind, platform, at, error }], complete }: object null when no
 * log names the session yet. A query that comes back full is read again as
 * the two halves of its span, until each comes back short; complete is
 * false only when that could not finish (a millisecond that alone fills a
 * query, or ATTRIBUTION_QUERIES spent), so a class may lie past what was read.
 */
export async function attributeSession(reader, { sid, at, base }, until) {
  const from = Date.parse(at) - 5_000;
  const scope = scopeOf(base);
  let complete = true;
  let queries = 0;
  const read = async (filters, options = {}, start = from, end = until) => {
    if (queries >= ATTRIBUTION_QUERIES) {
      complete = false;
      return [];
    }
    const limit = options.limit ?? 2000;
    const events = await reader.query(start, end, filters, { ...options, limit });
    queries += 1;
    if (events.length < limit) return events;
    // Unsplittable, or no budget left to read its halves: keep what this page holds.
    if (end <= start || queries >= ATTRIBUTION_QUERIES) {
      complete = false;
      return events;
    }
    const middle = Math.floor((start + end) / 2);
    return [...await read(filters, options, start, middle), ...await read(filters, options, middle + 1, end)];
  };
  const named = await reader.query(from, until, [[scope.key, scope.value], ['$workers.executionModel', 'durableObject']], { needle: sid, limit: 50 });
  const object = named.find((event) => event.$workers?.durableObjectId)?.$workers.durableObjectId ?? null;
  if (!object) return { sid, object: null, classes: [], complete: false };
  // Only warnings and errors: a busy object's info lines would crowd them out
  // of a query's 2000. The router's lines name the session too, and carry
  // what it was refused.
  const notInfo = ['$metadata.level', 'info', 'neq'];
  const events = [
    ...await read([[scope.key, scope.value], ['$workers.executionModel', 'stateless'], notInfo], { needle: sid }),
    ...await read([['$workers.durableObjectId', object], notInfo]),
  ];
  const traces = [...new Set(events.filter((event) => event.$workers?.outcome === 'exception').map((event) => event.$metadata?.traceId).filter(Boolean))];
  for (const trace of traces) events.push(...await read([['$metadata.traceId', trace]]));
  const classes = [];
  for (const event of events.sort((x, y) => x.timestamp - y.timestamp)) {
    for (const text of errorsOf(event)) {
      const found = RESET_CLASSES.find((entry) => text.includes(entry.error));
      if (found && !classes.some((seen) => seen.kind === found.kind)) {
        classes.push({ kind: found.kind, platform: found.platform, at: new Date(event.timestamp).toISOString(), error: text.slice(0, 300) });
      }
    }
  }
  return { sid, object, classes, complete };
}

/**
 * A red row's attribution: every session its probe minted (the row's
 * `sessions`, from the run's ledger), each on its own target, `base` when
 * the ledger names none.
 */
export async function attributeRow(reader, row, { base, until }) {
  const sessions = [];
  for (const session of row.sessions ?? []) sessions.push(await attributeSession(reader, { ...session, base: session.base ?? base }, until));
  return { sessions };
}

/**
 * Whether only the platform turned `row` red, so one rerun may grade it.
 * The probe reached its summary (a probe that died says nothing about what
 * killed it); every check it failed is a socket that closed 1006, naming a
 * session whose socket the ledger saw drop (the driver's close error names
 * its session); every such session shows the platform storage reset; and
 * every session's record was read whole and shows no other class.
 */
export function regradable(row, { sessions }) {
  const results = row.assertions ?? [];
  if (results.length === 0 || results.some((result) => !result.complete)) return false;
  const dropped = (row.sessions ?? []).filter((session) => session.abnormalCloses.length > 0).map((session) => session.sid);
  const failed = results.flatMap((result) => result.checks).filter((check) => !check.ok);
  const attributed = new Map(sessions.map((session) => [session.sid, session]));
  return failed.length > 0
    && failed.every((check) => /close code 1006\b/.test(check.detail) && dropped.some((sid) => check.detail.includes(`session ${sid};`)))
    && dropped.every((sid) => attributed.get(sid)?.classes.some((entry) => entry.platform))
    && sessions.every((session) => session.complete && session.classes.every((entry) => entry.platform));
}

/** One line per session for a row's report. */
export function describeAttribution({ sessions }) {
  return sessions.map((session) => `${session.sid}: ${session.object === null ? 'no log names this session yet'
    : `object ${session.object.slice(0, 12)}…: ${session.classes.length === 0 ? 'no reset or overload error logged'
      : session.classes.map((entry) => `${entry.kind} at ${entry.at} ("${entry.error.slice(0, 120)}")`).join('; ')}${session.complete ? '' : ' (a query came back full: the record may hold more)'}`}`);
}
