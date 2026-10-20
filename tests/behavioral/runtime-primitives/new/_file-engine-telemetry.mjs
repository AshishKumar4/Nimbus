// The platform's record of each measured session: its Durable Object's CPU,
// memory and storage per minute (GraphQL durableObjectsPeriodicGroups, its
// facets included), and the Preview's Worker invocations over the same span.
//   GQL_TOKEN=<token> bun _file-engine-telemetry.mjs <runs.jsonl> [preview-slug]
// Reads the {sid, start, end} records the measurement drivers print.
import { readFileSync } from 'node:fs';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.GQL_TOKEN;
const runs = readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((r) => r.sid);
const slug = process.argv[3];

async function gql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.viewer.accounts[0];
}

const minute = (iso, delta) => new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000 + delta * 60_000).toISOString();
const from = minute(runs.reduce((a, r) => (r.start < a ? r.start : a), runs[0].start), -2);
const to = minute(runs.reduce((a, r) => (r.end > a ? r.end : a), runs[0].end), 3);

const objects = await gql(`query($a:String!,$s:Time!,$e:Time!){accounts:viewer{accounts(filter:{accountTag:$a}){durableObjectsPeriodicGroups(limit:10000,filter:{datetimeMinute_geq:$s,datetimeMinute_leq:$e}){
  dimensions{datetimeMinute name objectId}
  sum{cpuTime activeTime rowsRead rowsWritten exceededMemoryErrors exceededCpuErrors fatalInternalErrors}
  max{memoryUsageBytes activeWebsocketConnections}
}}}}`.replace('accounts:viewer', 'viewer'), { a: account, s: from, e: to });

const rows = objects.durableObjectsPeriodicGroups;
for (const run of runs) {
  const mine = rows.filter((row) => row.dimensions.name && row.dimensions.name.endsWith(':' + run.sid));
  const inWindow = mine.filter((row) => row.dimensions.datetimeMinute >= minute(run.measuredFrom ?? run.start, 0) && row.dimensions.datetimeMinute <= minute(run.end, 0));
  const total = (list, f) => list.reduce((a, row) => a + (row.sum[f] || 0), 0);
  const peak = (list) => list.reduce((a, row) => Math.max(a, row.max.memoryUsageBytes || 0), 0);
  console.log(JSON.stringify({
    ...run,
    tail: undefined,
    minutes: mine.length,
    cpuMs: Math.round(total(mine, 'cpuTime') / 1000),
    windowCpuMs: Math.round(total(inWindow, 'cpuTime') / 1000),
    peakMiB: +(peak(mine) / 1048576).toFixed(1),
    windowPeakMiB: +(peak(inWindow) / 1048576).toFixed(1),
    rowsWritten: total(mine, 'rowsWritten'),
    errors: total(mine, 'exceededMemoryErrors') + total(mine, 'exceededCpuErrors') + total(mine, 'fatalInternalErrors'),
    perMinute: mine.map((row) => [row.dimensions.datetimeMinute.slice(11, 16), Math.round(row.sum.cpuTime / 1000), +(row.max.memoryUsageBytes / 1048576).toFixed(1)]),
  }));
}

if (slug) {
  const workers = await gql(`query($a:String!,$s:Time!,$e:Time!,$p:String!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e,previewSlug:$p}){
    dimensions{datetimeMinute scriptName previewSlug}
    sum{requests cpuTimeUs wallTime}
    quantiles{memoryUsageBytesP50 memoryUsageBytesP99 cpuTimeP50 cpuTimeP99}
  }}}}`, { a: account, s: from, e: to, p: slug });
  for (const row of workers.workersInvocationsAdaptive) console.log(JSON.stringify({ worker: row.dimensions, ...row.sum, ...row.quantiles }));
}
