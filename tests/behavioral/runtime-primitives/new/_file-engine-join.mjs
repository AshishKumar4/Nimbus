// Joins _file-engine-measure.mjs's command records to the platform's record of
// the same window on the same Preview: the guest tail's lines (each guest
// invocation's CPU and outcome, each process's store measure) and the session
// Durable Object's own invocations (cpuTimeMs). One session ran at a time.
//   CLOUDFLARE_ACCOUNT_ID=… bun _file-engine-join.mjs <slug> <records.jsonl> > joined.jsonl
import { readFileSync } from 'node:fs';
import { telemetry } from '../../../../scripts/ci/lib/reset-attribution.mjs';

const [slug, file] = process.argv.slice(2);
const all = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const records = all.filter((r) => r.start && r.end);
for (const r of all) if (!(r.start && r.end)) console.log(JSON.stringify(r));
const reader = telemetry({ account: process.env.CLOUDFLARE_ACCOUNT_ID });
if (!reader) throw new Error('no observability token');

const PAD_MS = 400;
const from = Math.min(...records.map((r) => Date.parse(r.start))) - 60_000;
const to = Math.max(...records.map((r) => Date.parse(r.end))) + 120_000;

/** Every event of the Preview in [a, b], halving any window that comes back full. */
async function events(a, b, filters, needle) {
  const got = await reader.query(a, b, [['$workers.preview.slug', slug], ...filters], { needle, limit: 2000 });
  if (got.length < 2000 || b - a < 1000) return got;
  const mid = Math.floor((a + b) / 2);
  return [...await events(a, mid, filters, needle), ...await events(mid + 1, b, filters, needle)];
}

async function span(filters, needle) {
  const all = [];
  for (let a = from; a < to; a += 300_000) all.push(...await events(a, Math.min(to, a + 300_000 - 1), filters, needle));
  return all;
}

const parse = (event) => {
  const s = event.source ?? {};
  if (typeof s.guestTail === 'string') return s;
  try { const j = JSON.parse(s.message); if (j && typeof j.guestTail === 'string') return j; } catch {}
  return null;
};

const tails = (await span([], 'guestTail')).map(parse).filter(Boolean);
const invocation = (e) => ({ at: e.timestamp, cpuMs: Number(e.$workers?.cpuTimeMs ?? 0), wallMs: Number(e.$workers?.wallTimeMs ?? 0), type: e.$workers?.eventType });
const session = (await span([['$workers.entrypoint', 'NimbusSession']])).map(invocation);
// A guest's filesystem calls reach the session through its SupervisorRPC: one invocation each.
const supervisorRpc = (await span([['$workers.entrypoint', 'SupervisorRPC']])).map(invocation);
console.error(`tail lines ${tails.length}, session invocations ${session.length}, supervisor calls ${supervisorRpc.length}`);

for (const r of records) {
  const a = Date.parse(r.start) - PAD_MS;
  const b = Date.parse(r.end) + PAD_MS;
  const mine = tails.filter((x) => x.at >= a && x.at <= b);
  const guest = {};
  for (const x of mine) {
    const key = `${x.guestTail}:${x.entrypoint ?? "-"}:${x.rpc ?? (x.url ? "fetch" : "-")}`;
    const g = guest[key] ??= { n: 0, cpuMs: 0, wallMs: 0, outcomes: {} };
    g.n++;
    g.cpuMs += x.cpuMs;
    g.wallMs += x.wallMs;
    g.outcomes[x.outcome] = (g.outcomes[x.outcome] ?? 0) + 1;
  }
  const measures = mine.flatMap((x) => x.logs ?? []).filter((l) => l.startsWith('[fs-measure] {')).map((l) => JSON.parse(l.slice('[fs-measure] '.length)));
  const memLines = mine.flatMap((x) => x.logs ?? []).filter((l) => l.startsWith('[mem-probe]'));
  const memProbe = memLines.filter((l) => !l.includes('held')).map((l) => Number(l.split(' ')[1]));
  const memHeld = memLines.filter((l) => l.includes('held')).map((l) => Number(l.split(' ')[2]));
  const sess = session.filter((x) => x.at >= a && x.at <= b);
  console.log(JSON.stringify({
    ...r,
    tail: undefined,
    guestCpuMs: Math.round(mine.reduce((s, x) => s + x.cpuMs, 0)),
    guest,
    exceptions: mine.flatMap((x) => x.exceptions ?? []).slice(0, 3),
    sessionCpuMs: Math.round(sess.reduce((s, x) => s + x.cpuMs, 0)),
    sessionInvocations: sess.length,
    supervisorRpcCalls: supervisorRpc.filter((x) => x.at >= a && x.at <= b).length,
    supervisorRpcCpuMs: Math.round(supervisorRpc.filter((x) => x.at >= a && x.at <= b).reduce((s, x) => s + x.cpuMs, 0)),
    measures,
    memProbeMax: memProbe.length ? Math.max(...memProbe) : null,
    memHeld: memHeld.length ? memHeld[0] : null,
  }));
}
