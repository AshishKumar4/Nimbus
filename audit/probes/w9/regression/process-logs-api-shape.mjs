// W9 regression: the existing process-logs HTTP/WS surface keeps its
// public contract after the W9 changes (hibernatable WS + persist).
//
// What MUST stay stable:
//   - matchLogsPath('/api/logs/<pid>') returns the pid; bad URLs return null
//   - handleProcessesListRequest returns { processes: [{ pid, command, state, exitCode, longRunning, hasLogs, logBytes, startTime }] }
//   - notifyTerminalEvent gracefully handles a null terminal
//   - LogsWebSocketDeps still has processLogs + processTable
//
// What MAY grow (additive, no break):
//   - handleLogsWebSocketRequest can take an additional ctx parameter
//     for ctx.acceptWebSocket. Callers in nimbus-session pass it explicitly.

import { ok, eq, group, summary } from '../_tap.mjs';

let api;
try {
  api = await import('../../../../src/process-logs-api.ts');
} catch (e) {
  ok('process-logs-api imports', false, e.message);
  summary('w9/regression/process-logs-api-shape');
}

const { matchLogsPath, notifyTerminalEvent, handleProcessesListRequest } = api;

group('matchLogsPath unchanged', () => {
  eq('valid path', matchLogsPath('/api/logs/42'), 42);
  eq('zero pid is rejected', matchLogsPath('/api/logs/0'), null);
  eq('negative not matched', matchLogsPath('/api/logs/-1'), null);
  eq('non-numeric', matchLogsPath('/api/logs/foo'), null);
  eq('trailing slash', matchLogsPath('/api/logs/42/'), null);
  eq('different prefix', matchLogsPath('/api/log/42'), null);
});

group('notifyTerminalEvent fail-soft on null terminal', () => {
  let threw = false;
  try { notifyTerminalEvent(null, { type: 'spawn', pid: 1 }); } catch { threw = true; }
  ok('null terminal does not throw', !threw);
});

group('notifyTerminalEvent uses ws.send', () => {
  const seen = [];
  const term = { ws: { send: (s) => seen.push(s) } };
  notifyTerminalEvent(term, { type: 'exit', pid: 1, code: 0 });
  eq('one frame sent', seen.length, 1);
  ok('frame is JSON', JSON.parse(seen[0]).pid === 1);
});

// async block — group() is sync; use a plain async IIFE block.
console.log('# handleProcessesListRequest returns expected shape');
{
  const fakeTable = {
    getAll: () => [
      { pid: 11, command: 'vite', state: 'running', exitCode: null, startTime: 1000 },
      { pid: 12, command: 'echo hi', state: 'exited', exitCode: 0, startTime: 1500 },
    ],
    get: (pid) => fakeTable.getAll().find(p => p.pid === pid) ?? null,
  };
  const fakeLogs = {
    snapshot: (pid) => pid === 11 ? { bytes: 100, chunks: 4, exit: null } : null,
  };

  const resp = handleProcessesListRequest(fakeTable, fakeLogs);
  ok('response is a Response', resp instanceof Response);
  eq('content-type-ish header', resp.headers.get('Cache-Control'), 'no-store');
  const body = await resp.json();
  ok('processes is array', Array.isArray(body.processes));
  eq('two processes', body.processes.length, 2);
  eq('vite is longRunning', body.processes[0].longRunning, true);
  eq('vite hasLogs', body.processes[0].hasLogs, true);
  eq('vite logBytes', body.processes[0].logBytes, 100);
  eq('echo is not longRunning', body.processes[1].longRunning, false);
  eq('echo hasLogs false', body.processes[1].hasLogs, false);
}

summary('w9/regression/process-logs-api-shape');
