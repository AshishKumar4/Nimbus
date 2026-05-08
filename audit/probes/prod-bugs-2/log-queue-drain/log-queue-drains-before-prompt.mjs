// Bug 1 probe: log queue drain ordering vs. prompt return.
//
// Scenario reproduced from the user brief:
//   `npm install` returns and the next shell prompt is rendered
//   BEFORE all of the install's `[npm]` log lines have been
//   written to the wire. The trailing line ("Pre-bundle
//   complete:") arrives 100+ ms later, OVERWRITING / appearing
//   AFTER the freshly-printed prompt. Confusing for the user
//   ("did the prompt redraw?"); breaks the invariant that all
//   output of a foreground command precedes the next prompt.
//
// Root cause (P3 finding, fixed in P4):
//   src/npm/installer.ts:376  fire-and-forget
//     const prebundlePromise = this.prebundleUsedModules(...).catch(...)
//     void prebundlePromise;
//   prebundleUsedModules emits its summary banner via
//   safeProgress (→ onProgress → ctx.stdout.write) in its own
//   `finally` block (installer.ts:1548-1552). install() returns
//   before that block runs, so the summary banner races the
//   shell's prompt-return.
//
// The probe sets up a project that triggers pre-bundle (one
// `react` import at minimum), runs `npm install`, captures the
// time-ordered sequence of WS frames, and asserts:
//   - every frame whose stripped contents contains "[npm]"
//     arrives BEFORE the first frame containing the next prompt.
//
// RED before P4 fix; GREEN after.
import { BASE, mintSession, WsSession, sleep, strip } from '../../interactive-liveness/_driver.mjs';

const LATE_FRAME_GRACE_MS = 2000;
const NPM_TAG = '[npm]';
const PROMPT_RE = /user@nimbus:[^$#]+\$\s*$/;

// Find the LAST frame whose stripped contents end with a prompt.
// Frame 0 typically contains the echoed input ("user@nimbus:~$ npm
// install\r\n") which would also pass the regex; we want the prompt
// that the shell renders AFTER the command exits.
function findPromptFrameIdx(frames) {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(strip(frames[i].data).trimEnd())) return i;
  }
  return -1;
}

function frameContainsNpmTag(frame) {
  return strip(frame.data).includes(NPM_TAG);
}

const sid = await mintSession();
const ws = new WsSession(sid);
await ws.connect();
await ws.waitForPrompt(20000);

// Replace the message handler with a timestamp-recording one.
// We keep the WsSession bookkeeping (buf / bannerCount) intact.
const frames = [];
ws.ws.removeAllListeners('message');
ws.ws.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') {
      ws.buf += m.data;
      if (m.data.includes(ws.bannerMarker)) ws.bannerCount++;
      frames.push({ ts: Date.now(), data: m.data });
    }
  } catch {}
});

console.log('==== Bug 1 probe: log queue drain ordering ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('SID:', sid);

// Set up a project that triggers pre-bundle (react = JSX runtime
// pre-bundle slots, which is what reproduces Bug 1 in production).
ws.send('mkdir -p /home/user/app && cd /home/user/app\n');
await ws.waitForNewPrompt(5000);
ws.send(`echo '{"name":"t","version":"1.0.0","dependencies":{"react":"18.3.1","react-dom":"18.3.1","zod":"3.23.8"}}' > package.json\n`);
await ws.waitForNewPrompt(5000);
ws.send(`mkdir -p src && echo "import React from 'react'; export default React;" > src/index.tsx\n`);
await ws.waitForNewPrompt(5000);

// Reset capture: only record frames from `npm install` onward.
ws.reset();
frames.length = 0;

// Run the install.
ws.send('npm install\n');
// First wait for "added N packages" — that's the install's
// success line, written inline from
// src/session/init.ts:1735. Once it lands, the install
// command has logically returned and the PROMPT will be
// (re-)drawn very soon after.
await ws.waitFor(
  (b) => /added \d+ packages \(\d+ files\)/.test(strip(b)),
  120000,
  '"added N packages" install-success line',
);
// Wait for any frame to contain the new prompt suffix.
// Crucially: we do NOT use waitForNewPrompt — that requires
// the buf to END with a prompt, but that's exactly the
// invariant the bug breaks (trailing `[npm]` gets appended
// AFTER the prompt). Instead we look for the prompt
// substring anywhere in the buf, so the probe can exit
// regardless of whether the bug is present.
const promptSuffix = 'user@nimbus:~/app$ ';
await ws.waitFor(
  (b) => strip(b).includes(promptSuffix),
  60000,
  'next prompt rendered',
);
const promptArrivedAt = Date.now();
// Grace period for stragglers.
await sleep(LATE_FRAME_GRACE_MS);

ws.close();

// ── Analysis ──────────────────────────────────────────────────────────
// The wire transport batches small writes into larger frames, so a
// per-frame "frame index of prompt" check is fragile (the prompt
// can land in the middle of a batched frame). The correct
// invariant is BYTE-LEVEL:
//
//   In the concatenated post-`npm install` stripped stream:
//     position of LAST occurrence of "[npm]" < position of LAST
//     occurrence of the prompt suffix
//
// If a `[npm]` line lands AFTER the prompt is drawn, the user
// sees the prompt on screen with stray "[npm] ..." text dumped
// to its right (and the cursor advanced past it).
console.log(`captured ${frames.length} frames`);
console.log('---- frames (ts offset relative to prompt-detection wall time) ----');
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const offset = f.ts - promptArrivedAt;
  const sign = offset >= 0 ? '+' : '';
  const stripped = strip(f.data).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const trimmed = stripped.length > 200 ? stripped.slice(0, 197) + '...' : stripped;
  console.log(`  [${i.toString().padStart(2)}] t${sign}${offset.toString().padStart(5)}ms  ${JSON.stringify(trimmed)}`);
}

// Concatenate post-install stream + strip ANSI for byte-level
// position checks.
const fullStream = strip(frames.map((f) => f.data).join(''));
const lastNpmIdx = fullStream.lastIndexOf(NPM_TAG);
const lastPromptIdx = fullStream.lastIndexOf(promptSuffix);
console.log('---- byte-level positions ----');
console.log(`stream length: ${fullStream.length} chars`);
console.log(`last "${NPM_TAG}" at: ${lastNpmIdx}`);
console.log(`last prompt suffix at: ${lastPromptIdx}`);

let pass = true;
console.log('---- assertions ----');
if (lastNpmIdx === -1) {
  console.log(`FAIL: no "${NPM_TAG}" found in stream — install never ran?`);
  pass = false;
}
if (lastPromptIdx === -1) {
  console.log(`FAIL: prompt never rendered in stream`);
  pass = false;
}
if (pass) {
  if (lastNpmIdx < lastPromptIdx) {
    console.log(`PASS: last "${NPM_TAG}" (idx=${lastNpmIdx}) precedes last prompt (idx=${lastPromptIdx})`);
  } else {
    const tail = fullStream.slice(lastPromptIdx, lastPromptIdx + 200).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    console.log(
      `FAIL: last "${NPM_TAG}" (idx=${lastNpmIdx}) arrived AFTER last prompt (idx=${lastPromptIdx}). ` +
      `Bytes from prompt onwards: ${JSON.stringify(tail)}`
    );
    pass = false;
  }
}

// Suppress lint on the unused legacy frame-index helpers.
void findPromptFrameIdx; void frameContainsNpmTag;

console.log(`==== EXIT ${pass ? 0 : 1} ====`);
process.exit(pass ? 0 : 1);
