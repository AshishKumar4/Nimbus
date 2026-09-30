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
 * who may embed it, is the guest's own COEP and CORP, as the port registry
 * last saw them on a document (`DocumentPolicy`, reported in the shell's
 * stats).
 *
 * Pure: shared by the router (which serves the shell) and the shell's
 * preview-isolation controller (frontend/preview-isolation, bundled to
 * `public/_assets/preview-isolation/`).
 */
import type { DocumentPolicy } from '@nimbus-sh/core/runtime/document-policy.js';
/** Query parameter on the session shell URL that asks for the isolated shell. */
export declare const SHELL_ISOLATION_QUERY = "isolated";
/** The headers the isolated shell is served with. */
export declare const ISOLATED_SHELL_HEADERS: Readonly<Record<string, string>>;
/** True when a shell URL asks for the isolated shell. */
export declare function isIsolatedShellUrl(url: URL): boolean;
/** The shell URL `href` in the other mode: same path, same other query. */
export declare function shellUrlInMode(href: string, isolated: boolean): string;
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
export declare function previewRelation(pane: URL, shell: URL): PreviewRelation;
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
export declare function planPreviewPane(document: Pick<DocumentPolicy, 'embedderPolicy' | 'resourcePolicy'>, relation: PreviewRelation, shell: ShellIsolationState): PreviewPaneOffer;
//# sourceMappingURL=preview-isolation.d.ts.map