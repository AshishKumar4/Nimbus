/**
 * The session shell's cross-origin isolation offer, bundled to
 * public/_assets/preview-isolation/preview-isolation.js and dynamic-imported
 * by public/s/index.html.
 *
 * The shell reports each port's last document policy from its stats (the port
 * registry reads it off the guest's own responses); this decides, from that
 * and the shell's own state, what the strip above the preview pane offers
 * (src/_shared/preview-isolation.ts has the browser rules), and carries the
 * offer out. The shell keeps the terminal socket and the preview URLs, and
 * lends them through the host.
 */

import type { DocumentPolicy } from '@nimbus-sh/core/runtime/document-policy.js';
import {
  isIsolatedShellUrl,
  planPreviewPane,
  previewRelation,
  shellUrlInMode,
  type PreviewPaneOffer,
} from '../../src/_shared/preview-isolation.js';

export interface PreviewIsolationHost {
  bar: HTMLElement;
  text: HTMLElement;
  action: HTMLButtonElement;
  /** The button's words, and the one word that replaces them in a narrow pane. */
  actionLabel: HTMLElement;
  actionShort: HTMLElement;
  sessionId: string;
  /** Open the active preview top-level (a host-form preview needs a fresh attach URL). */
  openInNewTab(): Promise<void>;
  /** Hand the session's one terminal back before a reload, waiting at most `limitMs`. */
  releaseTerminal(limitMs: number): Promise<void>;
  /** The editor file with unsaved edits, which a reload would discard. */
  unsavedPath(): string | null;
}

/** The preview the pane is showing, as far as the offer is concerned. */
export interface PreviewTarget {
  id: string;
  url: string;
  document: DocumentPolicy | null;
}

/** Each offer's copy, and the one word its button shows when the pane is too narrow for the rest. */
const OFFERS: Record<Exclude<PreviewPaneOffer, 'none'>, { text: string; action: string; short: string }> = {
  'isolate-shell': { text: 'This app asks for cross-origin isolation.', action: 'Reload isolated', short: 'Isolate' },
  'default-shell': { text: 'The isolated workspace blocks this app.', action: 'Reload normally', short: 'Normal' },
  'own-tab': { text: 'This app gets isolation in its own tab.', action: 'Open in new tab', short: 'Open' },
};

/**
 * Long enough for the session to answer the socket's close, short enough that
 * a lost answer does not hold the reload: the next shell's terminal redials
 * with backoff if the session has not let go yet.
 */
const RELEASE_TERMINAL_MS = 1_500;

export class PreviewIsolation {
  private offer: PreviewPaneOffer = 'none';
  private focusAfterReload: string | null;
  private readonly focusKey: string;

  constructor(private readonly host: PreviewIsolationHost) {
    this.focusKey = `nimbus.preview.focus:${host.sessionId}`;
    this.focusAfterReload = sessionStorage.getItem(this.focusKey);
    sessionStorage.removeItem(this.focusKey);
    host.action.addEventListener('click', () => { void this.act(); });
  }

  /** Whether a newly appeared tab may take focus: not while a reload is landing on another. */
  claimsFocus(tabId: string): boolean {
    return this.focusAfterReload === null || this.focusAfterReload === tabId;
  }

  /** The tab the last mode switch was made for, once; null after. */
  takeFocusAfterReload(): string | null {
    const focus = this.focusAfterReload;
    this.focusAfterReload = null;
    return focus;
  }

  show(target: PreviewTarget | null): void {
    const shell = new URL(location.href);
    this.offer = target?.document
      ? planPreviewPane(target.document, previewRelation(new URL(target.url, shell), shell), {
        requested: isIsolatedShellUrl(shell),
        isolated: self.crossOriginIsolated === true,
        topLevel: window.parent === window,
      })
      : 'none';
    const { bar, text, action } = this.host;
    bar.dataset.tab = target?.document ? target.id : '';
    bar.dataset.offer = this.offer;
    const offer = this.offer === 'none' ? null : OFFERS[this.offer];
    bar.hidden = offer === null;
    if (offer === null) return;
    text.textContent = offer.text;
    this.host.actionLabel.textContent = offer.action;
    this.host.actionShort.textContent = offer.short;
    // The name the compact button is known by, and its tooltip.
    action.setAttribute('aria-label', `${offer.action}: ${offer.text}`);
    action.title = `${offer.action}: ${offer.text}`;
  }

  private async act(): Promise<void> {
    if (this.offer === 'none') return;
    if (this.offer === 'own-tab') {
      await this.host.openInNewTab();
      return;
    }
    const unsaved = this.host.unsavedPath();
    if (unsaved !== null && !window.confirm(`Reloading discards unsaved changes to ${unsaved}. Reload anyway?`)) return;
    const target = this.host.bar.dataset.tab;
    if (target) sessionStorage.setItem(this.focusKey, target);
    await this.host.releaseTerminal(RELEASE_TERMINAL_MS);
    location.replace(shellUrlInMode(location.href, this.offer === 'isolate-shell'));
  }
}

let controller: PreviewIsolation | null = null;

/** The page's one controller: the strip, its button and the pending focus exist once. */
export function previewIsolation(host: PreviewIsolationHost): PreviewIsolation {
  controller ??= new PreviewIsolation(host);
  return controller;
}
