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

/** Whether a red row's output shows the symptom a reset or an overload leaves. */
export const showsResetSymptom = (output) => /close code 1006\b|E_NIMBUS_DO_OVERLOADED/.test(output);

/** The sessions a failing probe names (_driver.mjs nameMintedOnFailure): sid, mint time, and its target when not the run's. */
export function mintedSessions(output, base) {
  return [...output.matchAll(/^ {2}(\S+) {2}minted (\S+)(?: {2}on (\S+))?/gm)]
    .map(([, sid, at, on]) => ({ sid, at: Date.parse(at), base: on ?? base }))
    .filter((session) => Number.isFinite(session.at));
}

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
    async query(from, to, filters, { needle, limit = 2000 } = {}) {
      const body = {
        queryId: 'remote-probes-attribution', timeframe: { from, to }, view: 'events', limit,
        parameters: { filters: filters.map(([key, value, operation = 'eq', type = 'string']) => ({ key, operation, type, value })), filterCombination: 'and',
          ...(needle ? { needle: { value: needle, isRegex: false, matchCase: true } } : {}) },
      };
      const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`telemetry query answered ${response.status}`);
      return (await response.json()).result?.events?.events ?? [];
    },
  };
}

/** The platform errors an event carries: its log line, or the exception its invocation ended with. */
const errorsOf = (event) => [event.source?.message, event.$metadata?.error].filter((text) => typeof text === 'string');

/**
 * Attribute one session: its object (by its sid, within its Worker), then
 * every reset class whose exact error that object logged, or its failed
 * invocations' traces recorded, between its mint and `until`. Resolves to
 * { sid, object, classes: [{ kind, platform, at, error }] }, object null
 * when no log names the session yet.
 */
export async function attributeSession(reader, { sid, at, base }, until) {
  const scope = scopeOf(base);
  const named = await reader.query(at - 5_000, until, [[scope.key, scope.value], ['$workers.executionModel', 'durableObject']], { needle: sid, limit: 50 });
  const object = named.find((event) => event.$workers?.durableObjectId)?.$workers.durableObjectId ?? null;
  if (!object) return { sid, object: null, classes: [] };
  // Only warnings and errors: a busy object's info lines would crowd them out
  // of a query's 2000. The router's lines name the session too, and carry
  // what it was refused.
  const notInfo = ['$metadata.level', 'info', 'neq'];
  const events = [
    ...await reader.query(at - 5_000, until, [[scope.key, scope.value], ['$workers.executionModel', 'stateless'], notInfo], { needle: sid }),
    ...await reader.query(at - 5_000, until, [['$workers.durableObjectId', object], notInfo]),
  ];
  const traces = [...new Set(events.filter((event) => event.$workers?.outcome === 'exception').map((event) => event.$metadata?.traceId).filter(Boolean))];
  for (const trace of traces) events.push(...await reader.query(at - 5_000, until, [['$metadata.traceId', trace]], { limit: 500 }));
  const classes = [];
  for (const event of events.sort((x, y) => x.timestamp - y.timestamp)) {
    for (const text of errorsOf(event)) {
      const found = RESET_CLASSES.find((entry) => text.includes(entry.error));
      if (found && !classes.some((seen) => seen.kind === found.kind)) {
        classes.push({ kind: found.kind, platform: found.platform, at: new Date(event.timestamp).toISOString(), error: text.slice(0, 300) });
      }
    }
  }
  return { sid, object, classes };
}

/**
 * Attribute a red row: each session it names. `regrade` is true only when a
 * session shows the platform storage reset and none shows any other class:
 * then the row says nothing about the commit, and one rerun grades it.
 */
export async function attributeRow(reader, { output, base, until }) {
  const sessions = [];
  for (const session of mintedSessions(output, base)) sessions.push(await attributeSession(reader, session, until));
  const classes = sessions.flatMap((session) => session.classes);
  return { sessions, regrade: classes.some((entry) => entry.platform) && classes.every((entry) => entry.platform) };
}

/** One line per session for a row's report. */
export function describeAttribution({ sessions }) {
  return sessions.map((session) => `${session.sid}: ${session.object === null ? 'no log names this session yet'
    : session.classes.length === 0 ? `object ${session.object.slice(0, 12)}…: no reset or overload error logged`
      : `object ${session.object.slice(0, 12)}…: ${session.classes.map((entry) => `${entry.kind} at ${entry.at} ("${entry.error.slice(0, 120)}")`).join('; ')}`}`);
}
