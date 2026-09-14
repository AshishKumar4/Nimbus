/**
 * public-directory-do.ts — the NimbusPublicDirectory Durable Object class.
 *
 * Lives apart from `public-directory.ts` so the session-side helpers and
 * the router-side stub stay importable outside workerd — this file alone
 * needs `cloudflare:workers` for `DurableObject`. The wrangler binding
 * name and migration entry are `NimbusPublicDirectory`.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  PublicDirectoryStore,
  type PublicDirectoryEntry,
} from './public-directory.js';

export class NimbusPublicDirectory extends DurableObject {
  private store = new PublicDirectoryStore(this.ctx);

  bind(capability: string, entry: PublicDirectoryEntry) { return this.store.bind(capability, entry); }
  unbind(capability: string) { return this.store.unbind(capability); }
  resolve(capability: string) { return this.store.resolve(capability); }
}
