// Long-form repro: mimic a real interactive 5-minute dev session with
// occasional commands sprinkled across the timeline. Catches:
//   - DO reset (banner reprint mid-session)
//   - PWD drift (~/app → ~)
//   - WS close/reopen
//   - Lag (round-trip latency on a probe command)
//
// Usage: bun run repro-long.ts <sessionId> [holdMinutes=6]

const sessionId = process.argv[2];
const holdMinutes = Number(process.argv[3] ?? 6);
if (!sessionId) { console.error('usage: bun repro-long.ts <sessionId> [holdMinutes]'); process.exit(2); }

const url = `wss://nimbus.ashishkmr472.workers.dev/s/${sessionId}/ws`;
console.error(`[repro-long] connecting ${url}, holdMinutes=${holdMinutes}`);

const ws = new WebSocket(url);
let connected = false;
let outputBuf = '';
let bannerCount = 0;
let lastBannerAt = 0;
const bannerMarker = 'Cloud Dev Environment';
const startMs = Date.now();
const events: any[] = [];

const log = (event: string, extra?: any) => {
  const t = ((Date.now() - startMs) / 1000).toFixed(2);
  const e = { t: Number(t), event, ...extra };
  events.push(e);
  console.error(JSON.stringify(e));
};

ws.onopen = () => { connected = true; log('ws_open'); };
ws.onclose = (e: CloseEvent) => { log('ws_close', { code: e.code, reason: e.reason }); };
ws.onerror = (e: any) => { log('ws_error', { msg: e?.message ?? String(e) }); };

ws.onmessage = (ev: MessageEvent) => {
  try {
    const m = JSON.parse(ev.data as string);
    if (m.type === 'output' && typeof m.data === 'string') {
      // Stream to stdout for the human
      process.stdout.write(m.data);
      outputBuf += m.data;
      if (m.data.includes(bannerMarker)) {
        bannerCount++;
        const now = Date.now();
        log('banner_seen', { count: bannerCount, deltaSinceLastMs: lastBannerAt ? now - lastBannerAt : null });
        lastBannerAt = now;
      }
    }
  } catch (e: any) {
    log('msg_parse_err', { err: e.message });
  }
};

const send = (data: string, label: string) => {
  if (ws.readyState !== 1) {
    log('send_skipped', { label, readyState: ws.readyState });
    return;
  }
  ws.send(JSON.stringify({ type: 'input', data }));
  log('sent', { label, bytes: data.length });
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const waitFor = (predicate: (buf: string) => boolean, timeoutMs: number, label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (predicate(outputBuf)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
      }
    }, 200);
  });

(async () => {
  // Wait for connect + first prompt
  while (!connected && Date.now() - startMs < 15000) await sleep(100);
  if (!connected) { log('fatal_never_opened'); process.exit(1); }
  await waitFor((b) => /\$ $|# $/.test(b.slice(-30)), 10000, 'first_prompt');
  log('first_prompt_seen');
  await sleep(300);

  // npm i
  outputBuf = '';
  send('cd app && npm i\r', 'cd_app_npm_i');
  await waitFor((b) => /added \d+ packages|up to date/.test(b), 120000, 'npm_i_complete')
    .catch(e => log('npm_i_timeout', { err: e.message }));
  await sleep(1500);

  // npm run dev
  outputBuf = '';
  send('npm run dev\r', 'npm_run_dev');
  await waitFor(
    (b) => /Pre-bundle complete|ready in \d+ms|Run.*vite stop/i.test(b),
    120000,
    'vite_ready'
  ).catch(e => log('vite_ready_timeout', { err: e.message }));
  log('vite_running');
  await sleep(2000);

  // Hold loop with periodic probes (keep session active-ish like a real user)
  const endTime = startMs + holdMinutes * 60 * 1000;
  let probeCount = 0;
  while (Date.now() < endTime) {
    await sleep(30000); // probe every 30s
    probeCount++;
    const tag = `__probe_${probeCount}__`;
    outputBuf = '';
    const tProbe = Date.now();
    // Send a no-op-ish key (Enter) to trigger a prompt round trip — but
    // vite is still in the foreground so Enter goes to vite stdin.
    // Use a real probe via Ctrl-C? No — vite stop is destructive.
    // Just send Enter which appends a blank line and triggers our buffer
    // flush, measuring round-trip.
    send('\r', `enter_${probeCount}`);
    let saw = false;
    await waitFor((b) => { saw = b.length > 0; return b.length > 0; }, 5000, `probe_${probeCount}_resp`)
      .catch(e => log('probe_timeout', { probeCount, err: e.message }));
    log('probe_rt', { probeCount, ms: Date.now() - tProbe, sawAny: saw });
  }

  log('done', { totalBanners: bannerCount });
  ws.close();
  await sleep(500);
  process.exit(bannerCount > 1 ? 3 : 0);
})().catch(e => {
  log('fatal', { err: e?.stack ?? String(e) });
  ws.close();
  process.exit(1);
});
