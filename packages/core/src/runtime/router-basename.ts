/**
 * router-basename.ts — Auto-inject React Router `basename` for the /preview/
 * base path so `<NavLink to="/docs">` lands at `/preview/docs` with no
 * additional config in the user's source.
 *
 * Applied at VFS serve time inside vite-dev-server.ts `serveTransformed()`,
 * BEFORE esbuild's TS/JSX transform (source is easier to regex on).
 *
 * Patterns handled:
 *   A. createBrowserRouter(routes)                    → inject { basename }
 *   B. createBrowserRouter(routes, { ... })           → merge if no basename
 *   C. <BrowserRouter ...>                            → add basename attr
 *   D. <BrowserRouter basename="x">                   → leave alone
 *
 * Never overrides user-set values. Opt-out:
 *   - Explicit basename in source (per pattern)
 *   - Comment `// nimbus-no-basename` anywhere in the file
 *   - `nimbusInjectBasename: false` in vite.config.ts (plumbed by caller)
 *
 * Scope guard: only transforms likely router entry files (main.tsx, index.tsx,
 * App.tsx, root.tsx, router.tsx). node_modules is excluded by the caller.
 */

/**
 * Opt-out comment pattern. Matches a line-leading `//` comment containing the
 * directive. Intentionally strict so that mere mentions of the directive in
 * quoted strings, JSX text, or long-form comments do not accidentally disable
 * injection (e.g., docstrings that reference the opt-out won't opt out).
 *
 * Examples that trigger opt-out:
 *   // nimbus-no-basename
 *   //   nimbus-no-basename
 *   // nimbus-no-basename — disables auto-inject here
 *
 * Examples that DO NOT trigger (by design):
 *   const s = "// nimbus-no-basename";          // string literal
 *   // add the comment "// nimbus-no-basename"  // quoted inside comment
 */
const OPT_OUT_RE = /^[ \t]*\/\/[ \t]*nimbus-no-basename\b/m;

/** Files that are likely router entries. Path is the VFS path. */
const ENTRY_PATTERNS: RegExp[] = [
  /(?:^|\/)main\.(tsx|ts|jsx|js|mjs)$/i,
  /(?:^|\/)index\.(tsx|ts|jsx|js|mjs)$/i,
  /(?:^|\/)App\.(tsx|ts|jsx|js|mjs)$/i,
  /(?:^|\/)root\.(tsx|ts|jsx|js|mjs)$/i,
  /(?:^|\/)router(?:\.config)?\.(tsx|ts|jsx|js|mjs)$/i,
  /(?:^|\/)routes\.(tsx|ts|jsx|js|mjs)$/i,
];

/**
 * Should this VFS path be considered for router-basename injection?
 * Fast filter before we pay for regex scans on the file body.
 */
export function shouldProcessForRouter(vfsPath: string): boolean {
  if (!vfsPath) return false;
  // Never touch vendored code — our seed/user code lives under src/, not node_modules.
  if (vfsPath.includes('/node_modules/')) return false;
  if (vfsPath.startsWith('node_modules/')) return false;
  const normalized = '/' + vfsPath.replace(/^\/+/, '');
  return ENTRY_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Inject a `basename` into React Router `createBrowserRouter` / <BrowserRouter>
 * calls in the source, unless the user has set one or opted out.
 *
 * Returns the transformed source. Always safe — if no pattern matches,
 * returns the input unchanged.
 */
export function injectRouterBasename(src: string, basePath: string): string {
  // Fast short-circuits
  if (!src || src.length === 0) return src;
  if (OPT_OUT_RE.test(src)) return src;
  // Only scan further if the source MENTIONS the relevant router APIs.
  // Using substring checks (not regex) to keep the fast path cheap.
  const mentionsFactory = src.indexOf('createBrowserRouter') !== -1;
  const mentionsComponent = src.indexOf('BrowserRouter') !== -1;
  if (!mentionsFactory && !mentionsComponent) return src;

  const basenameLiteral = JSON.stringify(basePath);
  let out = src;

  // ── Pattern B first: createBrowserRouter(routes, { ...options })
  // Handled first so Pattern A (single-arg) doesn't accidentally gobble the
  // second-arg object. Non-greedy body match to stop at the first balanced-
  // looking `}` — good enough for typical hand-written code.
  //
  // Matches:
  //   createBrowserRouter(routes, {})
  //   createBrowserRouter(routes, { future: { ... } })
  //   createBrowserRouter([...], {\n  basename: '/x',\n})
  //
  // Multi-line safe because we use [\s\S].
  out = out.replace(
    /\bcreateBrowserRouter\s*\(\s*([\s\S]*?)\s*,\s*\{([\s\S]*?)\}\s*\)/g,
    (match, routes, opts) => {
      // Balance check: if `routes` contains unmatched parens, our regex ate too much.
      if (!isBalanced(routes)) return match;
      if (/\bbasename\s*:/.test(opts)) return match; // user set basename
      // Trim opts to make formatting tidy; add leading space for readability.
      const trimmedOpts = opts.replace(/^[\s,]*/, '').replace(/[\s,]*$/, '');
      const body = trimmedOpts
        ? `basename: ${basenameLiteral}, ${trimmedOpts}`
        : `basename: ${basenameLiteral}`;
      return `createBrowserRouter(${routes}, { ${body} })`;
    },
  );

  // ── Pattern A: createBrowserRouter(routes)   — single-arg form
  // Must NOT match calls that already have a second arg (handled by B above).
  // Detect "single arg" by looking at the char right after the first balanced-
  // looking close — if it's `)`, no second arg.
  //
  // We implement this manually rather than with a clever regex: scan for
  // `createBrowserRouter(`, find the matching close paren, and check whether
  // a comma (at depth 0) exists between them.
  out = scanAndReplaceCreateBrowserRouterSingleArg(out, basenameLiteral);

  // ── Pattern C: <BrowserRouter ...>  and  <BrowserRouter />
  // Adds `basename="/preview"` if not already present. Opening tag only.
  //
  // Matches (examples):
  //   <BrowserRouter>             attrs="", end=">"
  //   <BrowserRouter />           attrs="", end=" />"
  //   <BrowserRouter window={w}>  attrs=" window={w}", end=">"
  //   <BrowserRouter\n  x={y}\n>  attrs="\n  x={y}\n", end=">"
  //
  // The regex keeps `attrs` non-empty only when real attribute chars
  // exist; bare whitespace before `/>` ends up in `end` so we preserve
  // the user's original whitespace style.
  out = out.replace(
    /<BrowserRouter((?:\s+[^>\/\s][^>]*?)?)(\s*\/?\s*>)/g,
    (match, attrs, end) => {
      if (attrs && /\bbasename\s*=/.test(attrs)) return match;
      // Inject basename AFTER the attribute block (before `end`'s leading
      // whitespace). `attrs` is either empty or starts with whitespace.
      return `<BrowserRouter${attrs} basename=${basenameLiteral}${end}`;
    },
  );

  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Check that parens + brackets + braces in `s` are balanced. */
function isBalanced(s: string): boolean {
  let p = 0, b = 0, c = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    else if (ch === '{') c++;
    else if (ch === '}') c--;
    if (p < 0 || b < 0 || c < 0) return false;
  }
  return p === 0 && b === 0 && c === 0;
}

/**
 * Find every `createBrowserRouter(ARGS)` where ARGS at depth-0 contains no
 * comma (i.e. exactly one argument), and replace with
 * `createBrowserRouter(ARGS, { basename: "..." })`.
 *
 * Skips any call whose argument list has a second (or more) comma-separated
 * top-level item, since Pattern B handled those.
 */
function scanAndReplaceCreateBrowserRouterSingleArg(
  src: string,
  basenameLiteral: string,
): string {
  const needle = 'createBrowserRouter';
  let out = '';
  let i = 0;
  while (i < src.length) {
    const hit = src.indexOf(needle, i);
    if (hit < 0) {
      out += src.slice(i);
      break;
    }
    // Ensure this is a standalone identifier (not "myCreateBrowserRouter" or
    // "createBrowserRouterFoo"). Check the chars immediately before and after.
    const before = hit > 0 ? src[hit - 1] : '';
    const after = src[hit + needle.length];
    const isIdentChar = (c: string) => /[\w$]/.test(c);
    if (isIdentChar(before) || isIdentChar(after)) {
      out += src.slice(i, hit + needle.length);
      i = hit + needle.length;
      continue;
    }
    // Skip optional whitespace, then require `(`.
    let j = hit + needle.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '(') {
      out += src.slice(i, j);
      i = j;
      continue;
    }
    // Find matching `)` at depth 0 of this `(`, tracking nested parens,
    // brackets, braces, and string/template-literal bodies. Also note if a
    // depth-0 `,` exists (→ multi-arg form, skip; Pattern B handled it).
    const parenStart = j;
    let depthP = 1, depthB = 0, depthC = 0;
    let hasTopLevelComma = false;
    let k = parenStart + 1;
    let strQuote: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    let inTemplate = false;
    // Note: we skip template-literal interpolation depth tracking for simplicity.
    // If a user embeds `createBrowserRouter(...)` inside a template literal, we
    // just leave it alone (rare pattern).
    while (k < src.length) {
      const ch = src[k];
      const nx = src[k + 1];
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        k++;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && nx === '/') { inBlockComment = false; k += 2; continue; }
        k++;
        continue;
      }
      if (strQuote) {
        if (ch === '\\') { k += 2; continue; }
        if (ch === strQuote) strQuote = null;
        k++;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') { k += 2; continue; }
        if (ch === '`') inTemplate = false;
        k++;
        continue;
      }
      if (ch === '/' && nx === '/') { inLineComment = true; k += 2; continue; }
      if (ch === '/' && nx === '*') { inBlockComment = true; k += 2; continue; }
      if (ch === '"' || ch === "'") { strQuote = ch; k++; continue; }
      if (ch === '`') { inTemplate = true; k++; continue; }
      if (ch === '(') depthP++;
      else if (ch === ')') {
        depthP--;
        if (depthP === 0 && depthB === 0 && depthC === 0) break;
      }
      else if (ch === '[') depthB++;
      else if (ch === ']') depthB--;
      else if (ch === '{') depthC++;
      else if (ch === '}') depthC--;
      else if (ch === ',' && depthP === 1 && depthB === 0 && depthC === 0) {
        hasTopLevelComma = true;
      }
      k++;
    }
    if (depthP !== 0) {
      // Unbalanced — can't reason about this call. Emit as-is.
      out += src.slice(i, k);
      i = k;
      continue;
    }
    const parenEnd = k; // index of the matching `)`
    if (hasTopLevelComma) {
      // Multi-arg — Pattern B already processed it (or refused to). Skip.
      out += src.slice(i, parenEnd + 1);
      i = parenEnd + 1;
      continue;
    }
    // Single-arg form — inject `, { basename: "..." }` before the `)`.
    out += src.slice(i, parenEnd);
    out += `, { basename: ${basenameLiteral} }`;
    out += ')';
    i = parenEnd + 1;
  }
  return out;
}
