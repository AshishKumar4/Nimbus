/**
 * preview-isolation.ts — how a session preview gets cross-origin isolation.
 *
 * `self.crossOriginIsolated` (SharedArrayBuffer, Atomics.wait, high-resolution
 * timers) is a property of a whole frame tree, not of one document:
 *
 *   - The top-level document must be served with
 *     `Cross-Origin-Opener-Policy: same-origin` and an embedder policy that is
 *     compatible with isolation, `require-corp` or `credentialless`.
 *     https://html.spec.whatwg.org/multipage/document-sequences.html#cross-origin-isolation-mode
 *   - A nested document inside such a page must carry a compatible embedder
 *     policy of its own, or its navigation is blocked.
 *     https://html.spec.whatwg.org/multipage/browsers.html#check-a-navigation-response's-adherence-to-its-embedder-policy
 *   - A cross-origin nested document must also pass the parent's
 *     Cross-Origin-Resource-Policy check: a missing CORP counts as
 *     `same-origin`, so it needs `cross-origin`, or `same-site` when it is.
 *     https://fetch.spec.whatwg.org/#cross-origin-resource-policy-internal-check
 *   - It is isolated only if the `cross-origin-isolated` permission reaches it;
 *     the default allowlist is `self`, so a cross-origin frame needs
 *     `allow="cross-origin-isolated"`.
 *     https://w3c.github.io/webappsec-permissions-policy/#default-allowlists
 *     https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
 *   - A cross-origin isolated page loses its handle on any cross-origin popup
 *     it opens: the opener relationship is severed.
 *     https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy
 *
 * The preview pane is an iframe inside the session shell, so an app that asks
 * for isolation gets it in the pane only when the shell is isolated too. A
 * document cannot become isolated after it has loaded, and an isolated shell
 * blocks every preview that does not ask for isolation itself. The shell
 * therefore has two modes, and moves between them by reloading:
 *
 *   - default: no COOP, no COEP. Every preview loads in the pane exactly as it
 *     always has; one that asks for isolation is offered the isolated shell,
 *     or its own tab.
 *   - isolated (`?isolated=1` on the shell URL): COOP `same-origin` + COEP
 *     `credentialless`. `credentialless` rather than `require-corp` because the
 *     shell renders third-party content it does not control (markdown images,
 *     CDN assets): it loads them without credentials instead of blocking the
 *     ones that do not send CORP. https://developer.chrome.com/blog/coep-credentialless-origin-trial
 *
 * Guest headers are never rewritten: whether a preview asks for isolation, and
 * who may embed it, is the guest's own COEP and CORP.
 *
 * Pure: shared by the router (which serves the shell) and the shell itself
 * (bundled to `public/_assets/preview-isolation/`).
 */

/** Query parameter on the session shell URL that asks for the isolated shell. */
export const SHELL_ISOLATION_QUERY = 'isolated';

/** The headers the isolated shell is served with. */
export const ISOLATED_SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
});

/** True when a shell URL asks for the isolated shell. */
export function isIsolatedShellUrl(url: URL): boolean {
  return url.searchParams.get(SHELL_ISOLATION_QUERY) === '1';
}

/** The shell URL `href` in the other mode: same path, same other query. */
export function shellUrlInMode(href: string, isolated: boolean): string {
  const url = new URL(href);
  if (isolated) url.searchParams.set(SHELL_ISOLATION_QUERY, '1');
  else url.searchParams.delete(SHELL_ISOLATION_QUERY);
  return url.href;
}

/** An embedder policy value, as the HTML standard obtains it. */
export type EmbedderPolicy = 'unsafe-none' | 'require-corp' | 'credentialless';

/**
 * The embedder policy a `Cross-Origin-Embedder-Policy` header value gives a
 * document. The header is a Structured Field item (RFC 8941); a value that
 * does not parse, or whose item is not the token `require-corp` or
 * `credentialless`, is `unsafe-none`.
 * https://html.spec.whatwg.org/multipage/browsers.html#obtain-an-embedder-policy
 */
export function parseEmbedderPolicy(value: string | null): EmbedderPolicy {
  if (value === null) return 'unsafe-none';
  const token = parseStructuredItemToken(value);
  return token === 'require-corp' || token === 'credentialless' ? token : 'unsafe-none';
}

/** A Cross-Origin-Resource-Policy value, or null when absent or invalid. */
export type ResourcePolicy = 'same-origin' | 'same-site' | 'cross-origin' | null;

/**
 * The CORP policy a header value states. Fetch compares the whole value
 * byte for byte, so anything else — two values, other casing — is null.
 * https://fetch.spec.whatwg.org/#cross-origin-resource-policy-internal-check
 */
export function parseResourcePolicy(value: string | null): ResourcePolicy {
  return value === 'same-origin' || value === 'same-site' || value === 'cross-origin' ? value : null;
}

/** How the pane's URL relates to the shell's. */
export type PreviewRelation = 'same-origin' | 'same-site' | 'cross-site';

/**
 * `same-site` needs the registrable domain, which only the Public Suffix List
 * knows. A subdomain of the shell's own host provably shares the shell host's
 * registrable domain (`3000--sid.nimbus-os.dev` under `nimbus-os.dev`), so
 * that is the one `same-site` relation claimed; every other cross-origin URL
 * is `cross-site`. The error can only run one way: a same-site preview the
 * rule cannot prove is offered its own tab, never an isolated pane the browser
 * then refuses.
 */
export function previewRelation(pane: URL, shell: URL): PreviewRelation {
  if (pane.origin === shell.origin) return 'same-origin';
  if (pane.protocol === shell.protocol && pane.hostname.endsWith(`.${shell.hostname}`)) return 'same-site';
  return 'cross-site';
}

/** What a preview document's own response headers say about isolation. */
export interface PreviewDocumentPolicy {
  embedderPolicy: EmbedderPolicy;
  resourcePolicy: ResourcePolicy;
}

/** The shell's side of the frame tree. */
export interface ShellIsolationState {
  /** The shell was loaded in isolated mode (its URL carries the query). */
  requested: boolean;
  /** `self.crossOriginIsolated`: the browser's own answer for the shell. */
  isolated: boolean;
  /** The shell is the top-level document, so its COOP is not ignored. */
  topLevel: boolean;
}

/**
 * What the pane offers besides the preview itself:
 *   - `none`: the pane shows the preview as it asks to be shown.
 *   - `isolate-shell`: the preview asks for isolation and the isolated shell
 *     would give it that in the pane.
 *   - `default-shell`: the preview does not ask for isolation, so the isolated
 *     shell blocks it; the default shell shows it.
 *   - `own-tab`: the preview asks for isolation and no shell mode can give it
 *     that in the pane (the shell is embedded, the browser declined to isolate
 *     the shell, or the preview's CORP refuses a cross-origin embedder); a
 *     top-level tab of its own is isolated by its own headers.
 */
export type PreviewPaneOffer = 'none' | 'isolate-shell' | 'default-shell' | 'own-tab';

export function planPreviewPane(
  document: PreviewDocumentPolicy,
  relation: PreviewRelation,
  shell: ShellIsolationState,
): PreviewPaneOffer {
  const asks = document.embedderPolicy !== 'unsafe-none';
  const embeddable = relation === 'same-origin'
    || document.resourcePolicy === 'cross-origin'
    || (document.resourcePolicy === 'same-site' && relation === 'same-site');
  if (shell.isolated) {
    if (!asks) return 'default-shell';
    return embeddable ? 'none' : 'own-tab';
  }
  if (!asks) return 'none';
  return shell.topLevel && !shell.requested && embeddable ? 'isolate-shell' : 'own-tab';
}

// ── RFC 8941 item parsing ────────────────────────────────────────────────
//
// Only as much of Structured Field Values as deciding "is this item the token
// X" needs: the whole item is parsed, parameters and all, because a value that
// fails to parse anywhere is not the token either.
// https://www.rfc-editor.org/rfc/rfc8941#name-parsing-structured-fields

const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

class StructuredFieldCursor {
  position = 0;
  constructor(readonly input: string) {}
  get done(): boolean { return this.position >= this.input.length; }
  peek(): string { return this.input.charAt(this.position); }
  take(): string { return this.input.charAt(this.position++); }
  skipSpaces(): void { while (this.peek() === ' ') this.position++; }
}

/** The bare item of an sf-item when it is a token, else null (not a token, or no valid item at all). */
export function parseStructuredItemToken(value: string): string | null {
  const cursor = new StructuredFieldCursor(value);
  cursor.skipSpaces();
  const item = parseBareItem(cursor);
  if (item === undefined || !parseParameters(cursor)) return null;
  cursor.skipSpaces();
  if (!cursor.done) return null;
  return item.kind === 'token' ? item.value : null;
}

type BareItem = { kind: 'token'; value: string } | { kind: 'other' };

function parseBareItem(cursor: StructuredFieldCursor): BareItem | undefined {
  const first = cursor.peek();
  if (first === '-' || (first >= '0' && first <= '9')) return parseNumber(cursor) ? { kind: 'other' } : undefined;
  if (first === '"') return parseString(cursor) ? { kind: 'other' } : undefined;
  if (first === ':') return parseByteSequence(cursor) ? { kind: 'other' } : undefined;
  if (first === '?') {
    cursor.take();
    const bit = cursor.take();
    return bit === '0' || bit === '1' ? { kind: 'other' } : undefined;
  }
  if (first === '*' || /[A-Za-z]/.test(first)) {
    let token = cursor.take();
    while (!cursor.done && TCHAR.test(cursor.peek())) token += cursor.take();
    return { kind: 'token', value: token };
  }
  return undefined;
}

function parseNumber(cursor: StructuredFieldCursor): boolean {
  if (cursor.peek() === '-') cursor.take();
  let integerDigits = 0;
  let fractionDigits = -1;
  while (!cursor.done) {
    const char = cursor.peek();
    if (char >= '0' && char <= '9') {
      cursor.take();
      if (fractionDigits >= 0) fractionDigits++;
      else integerDigits++;
    } else if (char === '.' && fractionDigits < 0) {
      if (integerDigits > 12) return false;
      cursor.take();
      fractionDigits = 0;
    } else {
      break;
    }
  }
  if (integerDigits === 0) return false;
  if (fractionDigits < 0) return integerDigits <= 15;
  return fractionDigits >= 1 && fractionDigits <= 3;
}

function parseString(cursor: StructuredFieldCursor): boolean {
  cursor.take();
  while (!cursor.done) {
    const char = cursor.take();
    if (char === '\\') {
      const escaped = cursor.take();
      if (escaped !== '"' && escaped !== '\\') return false;
    } else if (char === '"') {
      return true;
    } else if (char < ' ' || char > '~') {
      return false;
    }
  }
  return false;
}

function parseByteSequence(cursor: StructuredFieldCursor): boolean {
  cursor.take();
  while (!cursor.done) {
    const char = cursor.take();
    if (char === ':') return true;
    if (!BASE64_CHAR.test(char)) return false;
  }
  return false;
}

function parseParameters(cursor: StructuredFieldCursor): boolean {
  while (cursor.peek() === ';') {
    cursor.take();
    cursor.skipSpaces();
    if (!KEY_START.test(cursor.peek())) return false;
    cursor.take();
    while (!cursor.done && KEY_CHAR.test(cursor.peek())) cursor.take();
    if (cursor.peek() === '=') {
      cursor.take();
      if (parseBareItem(cursor) === undefined) return false;
    }
  }
  return true;
}
