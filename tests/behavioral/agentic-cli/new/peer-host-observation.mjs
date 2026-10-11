import { BASE, mintSession, deleteSession, Terminal, makeAsserter, requestHeaders, sleep, hasOutputLine, termBody, fetchPort, diagMemory } from '../../_driver.mjs';

const a = makeAsserter('peer-host-observation');
const sessions = [], terminals = [];
async function probe(sid, action, pid, fields = {}) {
  const response = await fetch(`${BASE}/api/embedder/${sid}/host-loss`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
    body: JSON.stringify({ action, pid, ...fields }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`host-loss ${action}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function server(sid) {
  const terminal = new Terminal(sid); terminals.push(terminal);
  await terminal.connect(); await terminal.waitForPrompt(60000);
  await terminal.writeFile('/home/user/watch-server.js', "require('http').createServer((q,r)=>r.end('alive')).listen(3217);\n");
  const boot = await terminal.run('node /home/user/watch-server.js', 60000);
  if (boot.exitCode !== 0) throw new Error(boot.output);
  const pid = terminal.spawns.filter(event => event.longRunning && event.command.includes('watch-server.js')).at(-1)?.pid;
  if (!Number.isSafeInteger(pid)) throw new Error('server pid missing: ' + boot.output);
  return { terminal, pid };
}
try {
  const first = await mintSession(); sessions.push(first);
  const mode = await probe(first, 'mode');
  if (mode.mode !== 'peer') {
    a.check('peer cases are selected by the peer target', mode.mode === 'facet', 'run this probe with NIMBUS_PROCESS_HOST=peer');
  } else {
    const { terminal, pid } = await server(first);
    const work = terminal.run('echo HOST_ACTIVITY_OPEN; sleep 5', 15000);
    void work.catch(() => {});
    await terminal.waitFor(() => hasOutputLine(termBody(terminal.buf), 'HOST_ACTIVITY_OPEN'), 10000, 'owned work starts');
    await probe(first, 'facet-reset', pid);
    let active;
    for (let i = 0; i < 40; i++) {
      active = await probe(first, 'state', pid);
      if (active.state !== 'running') break;
      await sleep(50);
    }
    a.check('active work hears a facet loss without a data request', active?.exitCode === 137, JSON.stringify(active));
    await work;

    const second = await mintSession(); sessions.push(second);
    const idle = await server(second);
    await idle.terminal.close();
    await sleep(250);
    const reset = await probe(second, 'host-reset', idle.pid);
    a.check('the idle hosting actor changed incarnation', reset.reset === true && reset.before !== reset.after, JSON.stringify(reset));
    const beforeUse = await probe(second, 'state', idle.pid);
    a.check('idle has no continuous loss watcher', beforeUse.state === 'running', JSON.stringify(beforeUse));
    const resumed = new Terminal(second); terminals.push(resumed);
    await resumed.connect(); await resumed.waitForPrompt(30000);
    const attempted = await resumed.run('echo UNRELATED_WORK_AFTER_IDLE_LOSS', 30000);
    a.check('unrelated terminal work survives another process host loss', hasOutputLine(termBody(attempted.output), 'UNRELATED_WORK_AFTER_IDLE_LOSS'), attempted.output.slice(-700));
    const gone = await fetchPort(second, 3217, '/');
    a.check('the lost process port refuses work instead of admitting a new incarnation', gone.status === 502, JSON.stringify(gone));
    let afterUse;
    for (let i = 0; i < 40; i++) {
      afterUse = await probe(second, 'state', idle.pid);
      if (afterUse.state !== 'running' && /host.*reset|peer.*restarted/i.test(resumed.buf)) break;
      await sleep(50);
    }
    a.check('the lost process reports its host loss', /host.*reset|peer.*restarted/i.test(resumed.buf), resumed.buf.slice(-700));
    a.check('only the lost process becomes terminal', afterUse.exitCode === 137, JSON.stringify(afterUse));

    const third = await mintSession(); sessions.push(third);
    const quiet = await server(third);
    const beforeIdle = await probe(third, 'inspect', quiet.pid);
    await quiet.terminal.close();
    // No peer traffic while the coordinator stays alive. Residency must survive
    // without an RPC stub, active watch, polling alarm or peer heartbeat.
    for (let i = 0; i < 75; i++) { await sleep(2000); await probe(third, 'state', quiet.pid); }
    const afterIdle = await probe(third, 'inspect', quiet.pid);
    a.check('an idle peer resident lives while its coordinator is active', beforeIdle.incarnation === afterIdle.incarnation && afterIdle.residencies === 1, JSON.stringify({ beforeIdle, afterIdle }));
    const stillAlive = await fetchPort(third, 3217, '/');
    a.check('the same process still serves after unrelated coordinator activity', stillAlive.status === 200 && stillAlive.body === 'alive', JSON.stringify(stillAlive));
    const generation = (await diagMemory(third))?.hib?.isolateGen;
    for (let i = 0; i < 15; i++) await sleep(10000);
    const afterQuiet = await probe(third, 'placement-state', undefined, beforeIdle.placement);
    a.check('coordinator hibernation closes passive residency without a cancel call', afterQuiet.residencies === 0 && !afterQuiet.found, JSON.stringify(afterQuiet));
    const nextGeneration = (await diagMemory(third))?.hib?.isolateGen;
    a.check('passive residency does not pin the coordinator', typeof generation === 'number' && nextGeneration > generation, `${generation} -> ${nextGeneration}`);

    const fourth = await mintSession(); sessions.push(fourth);
    const resetting = await server(fourth);
    const owned = resetting.terminal.run('echo COORDINATOR_OWNED; sleep 5', 15000);
    void owned.catch(() => {});
    await resetting.terminal.waitFor(() => hasOutputLine(termBody(resetting.terminal.buf), 'COORDINATOR_OWNED'), 10000, 'the coordinator owns active work');
    const resetOwner = await probe(fourth, 'coordinator-reset', resetting.pid);
    let peerAfterReset;
    for (let i = 0; i < 40; i++) {
      peerAfterReset = await probe(fourth, 'placement-state', undefined, resetOwner.placement);
      if (!peerAfterReset.found && peerAfterReset.residencies === 0) break;
      await sleep(50);
    }
    a.check('coordinator reset releases residency during active work without a cancel call', !peerAfterReset.found && peerAfterReset.residencies === 0, JSON.stringify(peerAfterReset));
  }
} finally {
  for (const terminal of terminals) await terminal.close().catch(() => {});
  for (const sid of sessions) a.check('session deleted', (await deleteSession(sid)).ok, sid);
}
process.exit(a.summary().fail ? 1 : 0);
