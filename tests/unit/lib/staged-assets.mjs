/**
 * An `env.ASSETS` stand-in that serves @nimbus-sh/worker's public/ directory
 * by pathname, as the deployed assets binding does: the staged sources the
 * supervisor fetches (public/_assets/runtime/*) and a 404 for anything absent.
 */
import { readFile } from 'node:fs/promises';

const publicRoot = new URL('../../../packages/worker/public/', import.meta.url);

export const stagedAssets = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try {
      return new Response(await readFile(new URL(`.${pathname}`, publicRoot)));
    } catch (e) {
      if (e?.code === 'ENOENT') return new Response('not found', { status: 404 });
      throw e;
    }
  },
};

/** An `env.ASSETS` with nothing staged: every fetch is a 404. */
export const missingAssets = {
  async fetch() {
    return new Response('not found', { status: 404 });
  },
};
