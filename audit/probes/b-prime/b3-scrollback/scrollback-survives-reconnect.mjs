// Phase 3 B'.3 functional probe — terminal scrollback survives forced
// webSocketClose + reconnect (bounded ring, byte-capped).
//
// Acceptance bar:
//   1. Cold session has empty scrollback table (no rows).
//   2. After issuing a few commands and letting the WS flush settle,
//      nimbus_terminal_scrollback contains rows; total bytes < cap.
//   3. After a forced ws-close + reconnect on the SAME isolate, the
//      replay frame includes the pre-close output (a marker we can
//      grep for from the new buf).
//   4. Reconnect does NOT reprint the MOTD banner (Track B' invariant
//      already covered by B'.1; we re-assert here).
//   5. Cap enforcement: write more than the cap allows, confirm the
//      stored byte total stays under the cap (eviction policy works).
//      Functional, not exact — the precise eviction watermark is an
//      implementation detail.
//
// Pre-build: scrollback writes never reach SQL. /api/_diag/session
// has no `scrollbackRows` / `scrollbackBytes` field. Reconnect sees
// nothing of the prior session's output. This probe must be RED
// before the build, GREEN after.
//
// The probe assumes SHELL_SCROLLBACK_MAX_BYTES is exposed on the
// /api/_diag/session response so the cap test is self-describing
// (no hardcoded constant duplicated across probe + src).

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'scrollback-survives-reconnect.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function getSessionDebug(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`);
  if (r.status === 404) return null;
  return r.json();
}

async function main() {
  log("==== B'.3 scrollback-survives-reconnect probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: cold session — empty scrollback ───────────────────────────
  // Hit /api/_diag/session BEFORE any /ws upgrade.
  const cold = await getSessionDebug(sid);
  if (!cold) {
    fail("/api/_diag/session 404 — endpoint regressed since B'.1");
    log('==== EXIT ' + exitCode + ' ====');
    process.exit(exitCode);
  }
  log('stage 1: cold debug = ' + JSON.stringify({
    scrollbackRows: cold.scrollbackRows,
    scrollbackBytes: cold.scrollbackBytes,
    scrollbackMaxBytes: cold.scrollbackMaxBytes,
  }));
  if (typeof cold.scrollbackRows !== 'number') {
    fail('scrollbackRows missing on /api/_diag/session — B\'.3 surface not landed');
  } else if (cold.scrollbackRows !== 0) {
    fail(`cold scrollbackRows = ${cold.scrollbackRows} (expected 0)`);
  } else {
    pass('cold session: scrollback table is empty');
  }
  if (typeof cold.scrollbackMaxBytes !== 'number' || cold.scrollbackMaxBytes <= 0) {
    fail('scrollbackMaxBytes missing/invalid on /api/_diag/session');
  } else {
    pass(`scrollbackMaxBytes = ${cold.scrollbackMaxBytes}`);
  }

  // ── Stage 2: connect, run a few commands, scrollback should fill ───────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);

  s1.reset();
  s1.send('echo SENTINEL_ALPHA_42\r');
  await s1.waitForPrompt(5000);

  s1.reset();
  s1.send('echo SENTINEL_BETA_xyz\r');
  await s1.waitForPrompt(5000);

  // Let the WS flush + scrollback persist hooks settle.
  await sleep(500);

  const mid = await getSessionDebug(sid);
  log('stage 2: after-2-cmds debug = ' + JSON.stringify({
    rows: mid.scrollbackRows, bytes: mid.scrollbackBytes,
  }));
  if (mid.scrollbackRows > 0) {
    pass(`scrollback table populated (rows=${mid.scrollbackRows}, bytes=${mid.scrollbackBytes})`);
  } else {
    fail('scrollback table still empty after 2 commands — persist hook not firing');
  }
  if (mid.scrollbackBytes > 0 && mid.scrollbackBytes <= cold.scrollbackMaxBytes) {
    pass(`scrollbackBytes within cap (${mid.scrollbackBytes} ≤ ${cold.scrollbackMaxBytes})`);
  } else {
    fail(`scrollbackBytes ${mid.scrollbackBytes} not within (0, ${cold.scrollbackMaxBytes}]`);
  }

  // ── Stage 3: force close on same isolate ───────────────────────────────
  const isoBefore = (await getDiag(sid)).hib.isolateGen;
  await s1.close();
  await sleep(800);
  const isoAfter = (await getDiag(sid)).hib.isolateGen;
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across close`);
  }

  // ── Stage 4: reconnect, scrollback replay should include prior output ──
  const s2 = new WsSession(sid);
  await s2.connect();
  // The replay frame should arrive promptly (single batched WS send),
  // followed by Phase O ready + prompt.
  await s2.waitForPrompt(8000);
  log('stage 4: post-reconnect banner=' + s2.bannerCount);
  log('stage 4: post-reconnect buf head 200 = ' + JSON.stringify(s2.buf.slice(0, 200)));

  // On rehydrate, the banner from the original cold-start is part of
  // the scrollback replay — that's the architectural "what you saw
  // before" guarantee. So bannerCount should be exactly 1 (replayed),
  // NOT 0 (would mean replay missed the banner) and NOT 2 (would
  // mean Phase O reprinted on top of the replay).
  if (s2.bannerCount === 1) {
    pass('banner appears exactly once on rehydrate (replayed, not reprinted)');
  } else if (s2.bannerCount === 0) {
    fail('banner=0 on rehydrate — scrollback replay missed the original MOTD');
  } else {
    fail(`banner=${s2.bannerCount} on rehydrate — Phase O reprinted on top of replay`);
  }

  if (s2.buf.includes('SENTINEL_ALPHA_42')) {
    pass('scrollback replay contains SENTINEL_ALPHA_42 (cmd 1 output)');
  } else {
    fail('scrollback replay missing SENTINEL_ALPHA_42 — replay path broken');
  }
  if (s2.buf.includes('SENTINEL_BETA_xyz')) {
    pass('scrollback replay contains SENTINEL_BETA_xyz (cmd 2 output)');
  } else {
    fail('scrollback replay missing SENTINEL_BETA_xyz');
  }

  // ── Stage 5: cap enforcement — exceed the cap, confirm eviction ──────
  // The shell here is @lifo-sh/core's minimal shell — no `for` loops,
  // no $() command substitution, and `seq` with large args triggers
  // a workerd CPU-budget freeze (pre-existing bug, not B'.3-related).
  // Strategy: write a known-size file via heredoc, then `cat` it
  // many times to exceed 256 KiB across coalesced WS frames.
  //
  // 256 lines × ~64 chars ≈ 16 KiB per cat. 20 cats ≈ 320 KiB
  // produced — comfortably over the cap.
  s2.reset();
  // Build a 16 KiB filler file via printf in heredoc-esque way.
  // Use a single command that writes a known-size payload:
  //   `printf 'XXXXXXXXX...' > /tmp/big`  is one big string send —
  // we can produce it client-side and ship it as one input message.
  const fillerLine = 'PADDING_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_LINE\n';
  const fillerBlock = fillerLine.repeat(256); // ~16 KiB
  // The shell receives this as raw stdin to `cat > /tmp/big <<EOF` ?
  // The shell here doesn't have EOF heredocs reliably either. Use
  // node-side fetch to populate via the VFS API, then cat from shell.
  // Simpler still: do many `echo` commands; each is small but the
  // tee aggregates over the full session.
  //
  // Pragmatic approach: send 80 separate `echo` commands; each
  // produces a coalesced frame of ~70 bytes; cumulatively ~5.6 KiB.
  // That's not enough to hit the cap — but combined with
  // `cat /etc/motd` (which IS large in this fs) we can get there.
  //
  // Easiest: just `cat` something big repeatedly. /etc/motd is
  // ~1 KiB; let's use the seeded /home/user/welcome.txt or build
  // a big file via a single multi-line `echo`. The shell DOES
  // support `>` redirection — write a giant single-line string to
  // a file with `printf "%s" "<long>" > /tmp/big`, then cat it.
  // Build a single big shell `for` loop with 5000 iterations. Each
  // iteration prints a ~60-byte padded line, total ~300 KiB raw —
  // comfortably past the 256 KiB cap. The shell pumps the output
  // synchronously, so the WS terminal coalesces it into a small
  // number of frames; the eviction loop runs at SUM(bytes) > cap and
  // deletes oldest rows until total fits. Earlier sentinel rows
  // (SENTINEL_ALPHA / SENTINEL_BETA) get displaced.
  // Run the flood in a few large for-loop chunks. Each chunk emits
  // a single coalesced WS frame of ~250-300 KiB; cumulatively we
  // push past the 1 MiB cap so eviction must fire and the early
  // sentinels (SENTINEL_ALPHA / BETA from stage 2) get displaced.
  s2.reset();
  const padding = 'PADDING_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  for (let chunk = 0; chunk < 6; chunk++) {
    const items = Array.from({ length: 4000 }, (_, i) => chunk * 4000 + i + 1).join(' ');
    const flood = `for i in ${items}; do echo ${padding}_$i; done`;
    const t0 = Date.now();
    s2.send(flood + '\r');
    await s2.waitForNewPrompt(60000);
    log('stage 5: flood chunk ' + chunk + ' done in ' + (Date.now() - t0) + 'ms');
  }
  // Append a sentinel "newest" marker for the post-eviction check.
  s2.send('echo SENTINEL_NEWEST_zzz9\r');
  await s2.waitForNewPrompt(5000);
  await sleep(1500); // let scrollback writes + eviction settle
  // Append a sentinel "newest" marker so we can grep it post-eviction.
  s2.reset();
  s2.send('echo SENTINEL_NEWEST_zzz9\r');
  await s2.waitForPrompt(5000);
  await sleep(1500); // let scrollback writes + eviction settle

  const after = await getSessionDebug(sid);
  log('stage 5: post-flood debug = ' + JSON.stringify({
    rows: after.scrollbackRows, bytes: after.scrollbackBytes, max: after.scrollbackMaxBytes,
  }));
  if (after.scrollbackBytes <= after.scrollbackMaxBytes) {
    pass(`scrollback bytes capped (${after.scrollbackBytes} ≤ ${after.scrollbackMaxBytes})`);
  } else {
    fail(`scrollback bytes EXCEEDED cap (${after.scrollbackBytes} > ${after.scrollbackMaxBytes}) — eviction broken`);
  }
  // The flood must have produced enough bytes to actually trigger
  // eviction — otherwise stage 5 is a no-op. We expect post-flood
  // bytes to be at least ~50% of the cap (eviction left newer rows;
  // if we're way under, the flood didn't push hard enough).
  if (after.scrollbackBytes >= cold.scrollbackMaxBytes * 0.4) {
    pass(`flood pushed scrollback to ${after.scrollbackBytes} bytes (≥ 40% of cap — eviction was actually exercised)`);
  } else {
    fail(`flood only produced ${after.scrollbackBytes} bytes — too small to test eviction; tighten the test`);
  }

  // ── Stage 6: post-eviction reconnect — earliest sentinels gone ────────
  // SENTINEL_ALPHA / SENTINEL_BETA from stage 2 were the FIRST
  // scrollback rows. After flooding past the cap, the LRU eviction
  // policy says they should be gone. Reconnect once more and
  // confirm the replay no longer contains them.
  await s2.close();
  await sleep(800);
  const s3 = new WsSession(sid);
  await s3.connect();
  await s3.waitForPrompt(8000);
  log('stage 6: post-eviction reconnect buf len=' + s3.buf.length);

  if (!s3.buf.includes('SENTINEL_ALPHA_42')) {
    pass('SENTINEL_ALPHA_42 evicted (oldest scrollback dropped on flood)');
  } else {
    fail('SENTINEL_ALPHA_42 still present after flood — eviction policy not LRU');
  }
  if (!s3.buf.includes('SENTINEL_BETA_xyz')) {
    pass('SENTINEL_BETA_xyz evicted');
  } else {
    fail('SENTINEL_BETA_xyz still present after flood — eviction policy not LRU');
  }
  // Recent flood output SHOULD still be there. The most recent
  // SENTINEL_NEWEST_zzz9 echo is the very last thing that hit the
  // scrollback before close — it must survive eviction.
  if (s3.buf.includes('SENTINEL_NEWEST_zzz9')) {
    pass('recent flood output preserved (newer rows survive eviction)');
  } else {
    fail('recent flood output not in replay — eviction is dropping wrong end');
  }
  await s3.close();

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
