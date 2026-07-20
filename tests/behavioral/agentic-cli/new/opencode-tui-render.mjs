#!/usr/bin/env bun
// agentic-cli/new/opencode-tui-render — Stage D rungs 2-4: opencode's REAL
// interactive TUI renders to the Nimbus terminal, driven by keystrokes, over
// the wasm OpenTUI backend; and the non-TUI `opencode run` path is unaffected.
//
// What this proves (in a deployed facet):
//   RUNG 2 — bare `opencode` launches as a resident attached-TTY facet and the
//     OpenTUI CliRenderer (createCliRenderer, the path app.tsx uses) renders
//     real ANSI frames to the process terminal WS. The wasm32 reactor performs
//     no terminal syscalls of its own, so frames surface ONLY through the
//     NativeSpanFeed: bundle seam 7 defaults the renderer's stdout to the facet
//     TTY stdout (distinct from process.stdout), which activates the feed and
//     forwards ANSI to the terminal RPC → xterm. Assert: alternate-screen
//     entry + CSI escape sequences + a redraw on the process terminal.
//   RUNG 3 — a keystroke changes the frame and a resize reflows: feeding input
//     over the terminal WS (ProcessInputStore → cpReadStdin → process.stdin in
//     raw mode) produces new output, and a resize event (→ renderer.resize via
//     SIGWINCH + columns/rows) drives a fresh frame.
//   RUNG 4 — `opencode run <prompt>` (the non-TUI path) still drives the DB +
//     server + session + model-resolution pipeline and never touches
//     createCliRenderer — the TUI wiring did not regress it.
//
// Honest boundary: a fully-populated opencode chat UI needs an opencode account
// login (outbound LLM auth). This probe asserts the renderer/TTY substrate —
// real frames, keystroke-driven redraws, resize reflow, clean teardown — not a
// model conversation. Frame CONTENT beyond chrome is auth-gated and not claimed.

import {
  connectProcessTerminal,
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-tui-render');

// A CSI/control marker set OpenTUI's CliRenderer emits when it renders to a
// terminal: alternate screen, cursor hide, clear, and absolute cursor moves.
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const CURSOR_HIDE = '\x1b[?25l';
function hasCsi(raw) { return /\x1b\[/.test(raw); }
function hasFrameChrome(raw) {
  // OpenTUI drives the screen with alternate-screen + cursor positioning. Any
  // of these is sufficient proof the high-level renderer produced a frame.
  return raw.includes(ALT_SCREEN_ENTER)
    || raw.includes(CURSOR_HIDE)
    || /\x1b\[2J/.test(raw)        // clear screen
    || /\x1b\[\d+;\d+H/.test(raw); // absolute cursor move (frame layout)
}

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
let tui = null;
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install -g opencode-ai', 240_000);
  a.check('opencode-ai installs the staged Nimbus bundle',
    /linked 1 bin into|added 1 packages/.test(stripAnsi(install.output)),
    JSON.stringify(stripAnsi(install.output).slice(-300)));

  // ── RUNG 4 first (cheap, non-TUI): prove `opencode run` is UNAFFECTED ──
  const run = await t.run('opencode run -m bogusprovider/nope "hi" 2>&1; echo RDONE=$?', 150_000);
  const runOut = stripAnsi(run.output);
  a.check('[rung4] non-TUI `opencode run` still reaches model resolution cleanly (unaffected)',
    /Model not found: bogusprovider\/nope/.test(runOut) && /RDONE=0/.test(runOut)
      && !/Disallowed operation called within global scope|DatabaseSync \(node:sqlite\)|operation not permitted/.test(runOut),
    JSON.stringify(runOut.slice(-900)));
  a.check('[rung4] non-TUI `opencode run` emitted no alternate-screen TUI chrome',
    !run.output.includes(ALT_SCREEN_ENTER),
    JSON.stringify(run.output.slice(-300)));

  // ── RUNG 2: bare `opencode` launches the TUI as a resident attached facet ──
  const launch = await t.run('opencode', 60_000);
  const launchOut = stripAnsi(launch.output);
  const pidMatch = launchOut.match(/\[bin started \(long-running\): pid=(\d+) cmd="opencode"\]/);
  const pid = pidMatch ? Number(pidMatch[1]) : 0;
  a.check('[rung2] bare `opencode` launches as a long-running attached-TTY facet',
    pid > 0,
    JSON.stringify(launchOut.slice(-800)));

  if (pid > 0) {
    tui = await connectProcessTerminal(sid, pid);
    // The OpenTUI renderer enters the alternate screen + draws a frame as soon
    // as createCliRenderer().setupTerminal() + the first loop() run.
    await tui.waitFor((out) => out.length > 0, 60_000, 'first TUI output');
    await tui.waitFor(() => hasFrameChrome(tui.rawOutput), 60_000, 'TUI frame chrome');
    a.check('[rung2] opencode TUI renders real ANSI frames to the terminal (span-feed path live)',
      hasCsi(tui.rawOutput) && hasFrameChrome(tui.rawOutput)
        && !/Disallowed operation|CompileError|not pre-registered|NativeSpanFeed error|Aborted\(/.test(tui.output),
      JSON.stringify(tui.rawOutput.slice(-900)));

    // ── RUNG 2b: idle residency — the span-feed consumption-ack OOM killed the
    // facet at ~15s of resident rendering (chunks never freed → wasm linear
    // memory climbs to the isolate cap). Dwell ≥25s idle after the first frame
    // and assert the facet is NOT OOM-killed, then that a keystroke still
    // redraws (the renderer/loop is live, not wedged on stale refcounts). ──
    const DWELL_MS = 25_000;
    const dwellStart = Date.now();
    let dwellKilled = false;
    while (Date.now() - dwellStart < DWELL_MS) {
      if (/\[process killed:/.test(tui.output) || tui.exit || tui.closed) { dwellKilled = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    a.check('[rung2b] opencode TUI survives a ≥25s idle dwell with no OOM kill (span-feed ack leak closed)',
      !dwellKilled && !/\[process killed:/.test(tui.output) && !tui.exit && !tui.closed,
      JSON.stringify({ dwellMs: Date.now() - dwellStart, exit: tui.exit, closed: tui.closed, tail: tui.output.slice(-300) }));

    const afterDwellLen = tui.rawOutput.length;
    tui.input(' '); // benign keystroke; any redraw proves the renderer is live
    const redrew = await tui.waitFor(() => tui.rawOutput.length > afterDwellLen, 15_000, 'redraw after idle dwell')
      .then(() => true).catch(() => false);
    a.check('[rung2b] a keystroke after the idle dwell still redraws (renderer not wedged)',
      redrew && tui.rawOutput.length > afterDwellLen && !/\[process killed:/.test(tui.output),
      JSON.stringify({ afterDwellLen, now: tui.rawOutput.length, redrew }));

    const beforeLen = tui.rawOutput.length;

    // ── RUNG 3a: a keystroke changes the frame ──
    tui.input('?'); // a key that opencode's keymap reacts to (help/menu)
    await tui.waitFor(() => !!tui.stdinAck, 30_000, 'keystroke ack');
    a.check('[rung3] keystroke over the terminal WS is acknowledged (ProcessInputStore → stdin)',
      tui.stdinAck && tui.stdinAck.ok === true,
      JSON.stringify(tui.stdinAck));
    await tui.waitFor(() => tui.rawOutput.length > beforeLen, 30_000, 'frame change on keystroke');
    a.check('[rung3] a keystroke drives a new frame (raw-mode stdin reaches the renderer)',
      tui.rawOutput.length > beforeLen && hasCsi(tui.rawOutput.slice(beforeLen)),
      JSON.stringify(tui.rawOutput.slice(-700)));

    const beforeResize = tui.rawOutput.length;

    // ── RUNG 3b: a resize reflows the frame ──
    tui.resize(120, 40);
    await tui.waitFor(() => tui.rawOutput.length > beforeResize, 30_000, 'frame reflow on resize');
    a.check('[rung3] a terminal resize reflows the frame (SIGWINCH + columns/rows → renderer.resize)',
      tui.rawOutput.length > beforeResize && hasCsi(tui.rawOutput.slice(beforeResize)),
      JSON.stringify(tui.rawOutput.slice(-700)));

    // ── teardown: Ctrl-C should bring the TUI down cleanly ──
    tui.input('\x03'); // Ctrl-C
    // opencode handles Ctrl-C in app logic (exitOnCtrlC:false); also send a
    // SIGINT to guarantee teardown if the keymap requires a confirm.
    tui.signal('SIGINT');
    const exited = await tui.waitFor(() => !!tui.exit, 30_000, 'TUI exit')
      .then(() => true).catch(() => false);
    // A CLEAN teardown, not an OOM kill: code 137 (SIGKILL) or a
    // `[process killed: …]` stderr line is the facet death the ack leak caused —
    // the old `exited && !!tui.exit` assertion passed on exactly that. Ctrl-C /
    // SIGINT teardown exits gracefully (code 0 or 130).
    a.check('[rung2] opencode TUI tears down with a CLEAN exit — not an OOM kill (resident facet lifecycle)',
      exited && !!tui.exit && tui.exit.code !== 137 && !/\[process killed:/.test(tui.output),
      JSON.stringify({ exit: tui.exit, tail: tui.output.slice(-300) }));
    try { tui.ws.close(); } catch {}
  }
} finally {
  try { tui?.ws?.close(); } catch {}
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
