// _runtime-behavioral-template.mjs — helpers for probes that drive the
// literal user flow via a real Chrome and assert on observable
// behaviour (rendered DOM text, runtime errors, console output).
//
// CONTRACT: a probe built on this template must FAIL when, and only
// when, a real human user would see the bug. Structural-only assertions
// (regex on bundle output, HTTP 200 alone, marker substrings in HTML
// shell) are forbidden as the SOLE pass criterion. They may appear as
// supporting evidence, but the canonical pass/fail signal is observable
// browser behaviour.
//
// See `tests/behavioral/PROBE-QUALITY.md` for the full contract.
//
// ─────────────────────────────────────────────────────────────────────
// Driver: puppeteer-core targeting the system Chrome at
//   /root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome
// (a real Google Chrome for Testing 148, NOT a JSDOM emulation).
//
// The probe:
//   1. mintSession() → POST /new → sid
//   2. Drive the shell via WS to scaffold + install + start dev server
//   3. Open the iframe URL in real Chrome: BASE + '/s/<sid>/preview/'
//   4. Wait for app to mount (poll #root/body)
//   5. Drive interactions (clicks, navigations, route changes) via
//      real DOM events
//   6. Read iframe.body.innerText / pageErrors / console messages
//   7. Assert observable things; fail loudly when reality breaks
//
// Anti-requirements (inherited from charter):
//   - NO setTimeout / sleep / retry / defensive-catch in assertion logic
//     (waitForFunction with bounded timeout is the accepted shape;
//     the probe fails loudly when the timeout expires).
//   - NO probe that can pass when bundle is structurally-correct-but-
//     runtime-broken.

import puppeteer from 'puppeteer-core';
import { mintSession, Terminal, sleep, stripAnsi, BASE } from './_driver.mjs';

export { BASE, mintSession, sleep, stripAnsi };

/** System Chrome path. The puppeteer-core install in this monorepo
 *  is bundle-only (no Chromium download); the binary is provisioned
 *  separately by the host/dockerfile. Resolve from env so non-default
 *  installs work. */
export const CHROME_BIN =
  process.env.NIMBUS_CHROME_BIN ||
  '/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome';

/**
 * Launch a headless Chrome with the args needed for our environment
 * (--no-sandbox: the test container runs as root; --disable-dev-shm-usage:
 * /dev/shm is too small for some default allocations).
 */
export async function launchBrowser(opts = {}) {
  return puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: opts.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Allow cross-origin iframe DOM access for our tests
      '--disable-web-security',
      ...(opts.args || []),
    ],
    defaultViewport: { width: 1280, height: 800 },
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
}

/**
 * Open a `BehavioralPage` for a given session. The page hooks
 * `page.on('console')` and `page.on('pageerror')` so probes can assert
 * that no runtime error fired during interactions. Returns an object
 * with helpers for the standard probe shape.
 */
export async function openPage(browser, sid, opts = {}) {
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    consoleMessages.push({
      type: msg.type(),
      text: msg.text(),
      // location() returns { url, lineNumber, columnNumber }
      location: msg.location?.() || null,
    });
  });
  page.on('pageerror', (err) => {
    pageErrors.push({
      message: err.message || String(err),
      stack: err.stack || null,
    });
  });
  page.on('requestfailed', (req) => {
    // Only count network failures that the page initiated; ignore
    // favicon and the like.
    const url = req.url();
    if (/\.(png|jpg|jpeg|gif|svg|ico)$/i.test(url)) return;
    consoleMessages.push({
      type: 'request-failed',
      text: `${req.method()} ${url} — ${req.failure()?.errorText || 'unknown'}`,
      location: null,
    });
  });

  page.setDefaultNavigationTimeout(opts.navTimeoutMs || 60_000);

  return {
    page,
    sid,
    consoleMessages,
    pageErrors,

    /** Navigate to the preview iframe URL. Path is relative to /preview/. */
    async navigatePreview(path = '') {
      const url = `${BASE}/s/${sid}/preview/${path.replace(/^\/+/, '')}`;
      const resp = await page.goto(url, {
        waitUntil: opts.waitUntil || 'networkidle0',
        timeout: opts.navTimeoutMs || 60_000,
      });
      return {
        url,
        status: resp ? resp.status() : 0,
      };
    },

    /** Wait for the page's body.innerText to match a predicate. Returns
     *  the matching text. Throws on timeout. */
    async waitForBodyText(predicate, timeoutMs = 30_000) {
      const predicateStr = predicate.toString();
      try {
        await page.waitForFunction(
          (predSrc) => {
            // eslint-disable-next-line no-eval
            const pred = eval('(' + predSrc + ')');
            const text = (document.body?.innerText || '').trim();
            return pred(text);
          },
          { timeout: timeoutMs, polling: 200 },
          predicateStr,
        );
      } catch (e) {
        const text = await page.evaluate(() => (document.body?.innerText || '')).catch(() => '');
        throw new Error(
          `waitForBodyText timeout after ${timeoutMs}ms; ` +
          `body.innerText (last ${Math.min(text.length, 400)} chars): ` +
          JSON.stringify(text.slice(-400)),
        );
      }
      return await page.evaluate(() => document.body?.innerText || '');
    },

    /** Read the current body innerText. */
    async getBodyText() {
      return await page.evaluate(() => document.body?.innerText || '');
    },

    /** Click a selector inside the page (NOT inside an iframe — these
     *  probes drive the preview directly, not the supervisor host page). */
    async clickSelector(selector, opts = {}) {
      await page.waitForSelector(selector, {
        timeout: opts.timeoutMs || 15_000,
        visible: opts.visible !== false,
      });
      await page.click(selector, opts.clickOpts || {});
    },

    /** Type into a focused input. */
    async type(selector, text, delay = 0) {
      await page.waitForSelector(selector, { timeout: 15_000 });
      await page.type(selector, text, { delay });
    },

    /** Programmatic navigation inside the SPA (calls history.pushState
     *  and dispatches popstate so React-Router etc. respond). Use this
     *  when a click target isn't readily available — same effect on
     *  the runtime as a real click on a `<Link to="/x" />`. */
    async pushHistory(path) {
      await page.evaluate((p) => {
        window.history.pushState({}, '', p);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, path);
    },

    /** Sum the page errors + console error messages into a single
     *  list — useful for `assertNoRuntimeErrors`. */
    collectErrors() {
      const errors = [];
      for (const e of pageErrors) errors.push({ kind: 'pageerror', ...e });
      for (const m of consoleMessages) {
        if (m.type === 'error' || m.type === 'request-failed') {
          errors.push({ kind: 'console-error', ...m });
        }
      }
      return errors;
    },

    /** Hard assertion: no `pageerror` and no console.error fired
     *  during the probe's lifetime. Returns the error list when
     *  triggered (for inspection); throws otherwise. */
    assertNoRuntimeErrors(filter = () => true) {
      const errors = this.collectErrors().filter(filter);
      if (errors.length > 0) {
        const summary = errors.slice(0, 5).map((e) =>
          `[${e.kind}] ${e.message || e.text || ''}`).join('\n');
        throw new Error(`runtime errors observed (${errors.length}):\n${summary}`);
      }
      return errors;
    },

    /** Get the current page URL. */
    async currentUrl() {
      return page.url();
    },

    /** Take a screenshot for diagnostic capture. Returns base64 string. */
    async screenshotB64() {
      return await page.screenshot({ encoding: 'base64', fullPage: true });
    },

    async close() {
      try { await page.close(); } catch { /* best-effort */ }
    },
  };
}

/**
 * High-level helper: scaffold a project, install, start vite,
 * wait until vite logs "ready". Returns a `Terminal` keyed to `sid`
 * that the caller can keep using (e.g. to send Ctrl-C at end).
 */
export async function scaffoldAndStartVite(sid, opts) {
  // opts: {
  //   workdir: string (e.g. 'mf'),
  //   files: Record<string, string>,    // path → utf8 content
  //   installCmd?: string,               // 'npm install' default
  //   installTimeoutMs?: number,
  //   devCmd?: string,                   // 'npm run dev' default
  //   devReadyMarkers?: string[],
  //   devReadyTimeoutMs?: number,
  // }
  const installCmd = opts.installCmd || 'npm install';
  const installTimeoutMs = opts.installTimeoutMs || 600_000;
  const devCmd = opts.devCmd || 'npm run dev';
  const devReadyTimeoutMs = opts.devReadyTimeoutMs || 180_000;
  const devReadyMarkers = opts.devReadyMarkers || [
    'ready in', 'Local:', 'Nimbus Vite Dev', 'VITE v',
  ];

  const t = new Terminal(sid);
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run(`mkdir -p /home/user/${opts.workdir}`, 10_000);
  await t.run(`cd /home/user/${opts.workdir}`, 10_000);

  // Write each file via base64 → fs.writeFileSync
  for (const [relPath, content] of Object.entries(opts.files)) {
    const abs = `/home/user/${opts.workdir}/${relPath}`;
    // Ensure parent dirs.
    const lastSlash = abs.lastIndexOf('/');
    if (lastSlash > '/home/user'.length) {
      await t.run(`mkdir -p ${abs.substring(0, lastSlash)}`, 10_000);
    }
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    await t.run(
      `node -e "require('fs').writeFileSync('${abs}', Buffer.from('${b64}','base64').toString('utf8'))"`,
      30_000,
    );
  }

  // Install
  const installR = await t.run(installCmd, installTimeoutMs);
  const installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-6).join('\n');

  // Start dev (long-running — don't await prompt)
  t.reset();
  t.cmd(devCmd);
  let viteReady = false;
  try {
    await t.waitFor(
      (b) => devReadyMarkers.some((m) => b.includes(m)),
      devReadyTimeoutMs,
      'vite-ready',
    );
    viteReady = true;
  } catch {
    // Caller asserts on viteReady.
  }
  // Bounded settle time so the port-registry registration completes
  // before the iframe loads. NOT a retry — a single bounded yield.
  await sleep(2_000);

  return { terminal: t, viteReady, installTail };
}

/**
 * Higher-level variant of scaffoldAndStartVite: clones a real public
 * repo via `git clone <url> <workdir>`, runs install + dev, waits for
 * the dev-ready marker. Used by real-repo probes (markflow-real,
 * astro-real, sveltekit-real, …).
 *
 * Contract: caller-supplied `repoUrl` MUST be a public HTTPS URL the
 * Nimbus session's `git clone` can reach (Nimbus's git layer is
 * isomorphic-git via cf-git). Caller-supplied `installCmd` and
 * `devCmd` default to `npm install` and `npm run dev`; pass `bun
 * install` / `bun run dev` for repos that pin bun in their lockfile.
 *
 * Returns { terminal, viteReady, installTail, cloneOk, cloneTail }.
 */
export async function cloneAndStartVite(sid, opts) {
  // opts: {
  //   repoUrl: string,                   // 'https://github.com/X/Y.git'
  //   workdir: string,                   // 'mf' → /home/user/mf
  //   installCmd?: string,               // default 'npm install'
  //   installTimeoutMs?: number,         // default 900_000 (15 min for big repos)
  //   devCmd?: string,                   // default 'npm run dev'
  //   devReadyMarkers?: string[],        // default vite markers
  //   devReadyTimeoutMs?: number,        // default 240_000
  //   cloneTimeoutMs?: number,           // default 240_000
  //   postCloneCmds?: string[],          // optional pre-install fixups
  // }
  const installCmd = opts.installCmd || 'npm install';
  const installTimeoutMs = opts.installTimeoutMs || 900_000;
  const devCmd = opts.devCmd || 'npm run dev';
  const devReadyTimeoutMs = opts.devReadyTimeoutMs || 240_000;
  const cloneTimeoutMs = opts.cloneTimeoutMs || 240_000;
  const devReadyMarkers = opts.devReadyMarkers || [
    'ready in', 'Local:', 'Nimbus Vite Dev', 'VITE v',
  ];

  const t = new Terminal(sid);
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('cd /home/user', 10_000);

  // Clone. Nimbus's git layer is isomorphic-git (cf-git fork) — public
  // HTTPS works.
  const cloneR = await t.run(
    `git clone ${opts.repoUrl} ${opts.workdir}`,
    cloneTimeoutMs,
  );
  const cloneTail = stripAnsi(cloneR.output).split(/\r?\n/).slice(-12).join('\n');
  const cloneOk =
    /Cloning into|Receiving objects|done\.|HEAD is now/.test(cloneR.output) &&
    !/clone failed|fatal:/i.test(cloneR.output);

  if (!cloneOk) {
    return {
      terminal: t,
      cloneOk: false,
      cloneTail,
      viteReady: false,
      installTail: '',
    };
  }

  await t.run(`cd /home/user/${opts.workdir}`, 10_000);

  // Optional post-clone commands (e.g. fix lockfile mismatches).
  for (const cmd of opts.postCloneCmds || []) {
    await t.run(cmd, 30_000);
  }

  // Install.
  const installR = await t.run(installCmd, installTimeoutMs);
  const installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-12).join('\n');

  // Start dev (long-running — don't await prompt).
  t.reset();
  t.cmd(devCmd);
  let viteReady = false;
  try {
    await t.waitFor(
      (b) => devReadyMarkers.some((m) => b.includes(m)),
      devReadyTimeoutMs,
      'dev-ready',
    );
    viteReady = true;
  } catch {
    // Caller asserts on viteReady.
  }
  // Bounded settle so port-registry registration completes.
  await sleep(3_000);

  return { terminal: t, viteReady, installTail, cloneOk: true, cloneTail };
}

/**
 * Shorthand sentinel substrings the assert helpers default to looking
 * for. Probes can extend per-case.
 *
 * Categories covered (probe should fail loudly if any appear):
 *   - V8 runtime exceptions: TypeError, ReferenceError, SyntaxError
 *   - method-call shapes:    "is not a function", "is not defined"
 *   - property access:       "Cannot read prop", "Cannot read properties"
 *   - module resolution:     "Cannot resolve module", "Failed to resolve",
 *                            "does not provide an export"
 *   - Nimbus dev-server:     "Preview crashed", "[vite-dev] cannot serve",
 *                            "on-demand bundle failed"
 *   - generic uncaught:      "Uncaught"
 *   - babel-runtime ESM/CJS interop (the original false-GREEN incident):
 *                            "_objectWithoutPropertiesLoose"
 */
export const RUNTIME_ERROR_MARKERS = [
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'is not a function',
  'is not defined',
  'Cannot read prop',
  'Cannot read properties',
  'Cannot resolve module',
  'Failed to resolve',
  'does not provide an export',
  'Preview crashed',
  '[vite-dev] cannot serve',
  'on-demand bundle failed',
  'Uncaught',
  '__objectWithoutPropertiesLoose',
  '_objectWithoutPropertiesLoose2',
];

/**
 * Returns true iff `text` (typically body.innerText) contains any
 * marker in `RUNTIME_ERROR_MARKERS` (or a probe-supplied list).
 */
export function bodyTextHasErrorMarker(text, markers = RUNTIME_ERROR_MARKERS) {
  for (const m of markers) {
    if (text.includes(m)) return m;
  }
  return null;
}
