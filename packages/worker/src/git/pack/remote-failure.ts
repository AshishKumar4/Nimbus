/**
 * git/pack/remote-failure.ts — a git server that could not be reached, or
 * refused, as git says it (remote-curl.c discover_refs, http.c
 * handle_curl_result).
 *
 * The facet records what failed (remoteFailureOf): the transport (no
 * answer), or the HTTP status the server answered with, and the text it
 * sent with it when that is plain text. The command says it in git's words
 * (remoteFailureText), and exits as git does (128; a pull, whose fetch is
 * git's child, 1).
 */

import type { GitHttp, GitHttpResponse } from './transport.js';

/** Why a request to the git server failed. */
export type RemoteFailure =
  /** No answer: the connection, DNS, TLS or the stream failed. `detail` says how. */
  | { kind: 'transport'; detail: string }
  /** An answer with a failing status; `message` is its body when that is text/plain (show_http_message). */
  | { kind: 'status'; status: number; message?: string };

/** The most of a failing answer's body kept for its message. */
const MESSAGE_BYTES = 64 * 1024;

/**
 * transport_anonymize_url: `url` without the user name and password its
 * authority may carry.
 */
export function anonymizeUrl(url: string): string {
  const scheme = url.indexOf('://');
  if (scheme < 0) return url;
  const start = scheme + 3;
  const slash = url.indexOf('/', start);
  const end = slash < 0 ? url.length : slash;
  const at = url.lastIndexOf('@', end - 1);
  return at < start ? url : url.slice(0, start) + url.slice(at + 1);
}

/** credential_describe: the protocol and host of `url`, as a credential prompt names them. */
function credentialDescription(url: string): string {
  const scheme = url.indexOf('://');
  if (scheme < 0) return url;
  const start = scheme + 3;
  const slash = url.indexOf('/', start);
  return anonymizeUrl(url.slice(0, slash < 0 ? url.length : slash));
}

/**
 * git's lines for `failure` of the repository at `url` (as configured or
 * given), `credentials` whether any were offered: the server's plain-text
 * message as `remote:` lines, then git's own.
 */
export function remoteFailureText(url: string, failure: RemoteFailure, credentials: boolean): string {
  // remote-curl.c: the repository's URL ends with a slash, its credentials taken out.
  const shown = anonymizeUrl(url.endsWith('/') ? url : url + '/');
  if (failure.kind === 'transport') return `fatal: unable to access '${shown}': ${failure.detail}\n`;
  // A 401 with nothing offered is a prompt for a user name, and there is no terminal to ask at.
  if (failure.status === 401 && !credentials) {
    return `fatal: could not read Username for '${credentialDescription(url)}': terminal prompts disabled\n`;
  }
  const remote = (failure.message ?? '').trim();
  const lines = remote === '' ? '' : remote.split('\n').map((line) => `remote: ${line}\n`).join('');
  if (failure.status === 404) return `${lines}fatal: repository '${shown}' not found\n`;
  if (failure.status === 401) return `${lines}fatal: Authentication failed for '${shown}'\n`;
  return `${lines}fatal: unable to access '${shown}': The requested URL returned error: ${failure.status}\n`;
}

/** The message of an answer's body, when its type is text/plain (show_http_message); the body is read. */
export async function plainTextMessage(contentType: string | null, body: ReadableStream<Uint8Array> | null): Promise<string | undefined> {
  if (body === null) return undefined;
  const plain = (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/plain';
  if (!plain) {
    await body.cancel();
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MESSAGE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, size - at)), at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, Math.min(size, MESSAGE_BYTES)));
}

/**
 * What `error`, the facet's failure, says failed at the git server: an
 * UploadPackError's (a clone's own requests), or cf-git's through `http`;
 * undefined when it is not the server's failure.
 */
export function remoteFailureOf(error: unknown, http?: ObservedGitHttp): RemoteFailure | undefined {
  // An UploadPackError carries its own (upload-pack.ts).
  if (error instanceof Error && error.name === 'UploadPackError') return (error as Error & { failure?: RemoteFailure }).failure;
  return http?.failureOf(error);
}

/** cf-git's HTTP client, with the failure of its last request kept (`failureOf`). */
export interface ObservedGitHttp extends GitHttp {
  /** What `error` (thrown by cf-git) says failed at the server, or undefined when it is not a server's failure. */
  failureOf(error: unknown): RemoteFailure | undefined;
}

/** A body of `bytes` again, as cf-git reads a response body (an async iterable of chunks). */
async function* replay(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Bytes from cf-git's response body (an async iterable), up to MESSAGE_BYTES. */
async function collect(body: GitHttpResponse['body']): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (body && Symbol.asyncIterator in (body as object)) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MESSAGE_BYTES) break;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * `http` with each failure kept: a request that threw (the transport: that
 * error), and an answer with a failing status (its status, and its body when
 * plain text, which cf-git still reads after). cf-git's HttpError for that
 * status, or the transport's own error, is then known for what it is.
 */
export function observedGitHttp(http: GitHttp): ObservedGitHttp {
  let thrown: { error: unknown; failure: RemoteFailure } | null = null;
  let answered: RemoteFailure & { kind: 'status' } | null = null;
  return {
    async request(req) {
      let response: GitHttpResponse;
      try {
        response = await http.request(req);
      } catch (error) {
        thrown = { error, failure: { kind: 'transport', detail: error instanceof Error ? error.message : String(error) } };
        throw error;
      }
      if (response.statusCode < 400) return response;
      const bytes = await collect(response.body);
      const headers = (response.headers ?? {}) as Record<string, string>;
      const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
      const plain = contentType.split(';')[0].trim().toLowerCase() === 'text/plain';
      answered = { kind: 'status', status: response.statusCode, ...(plain ? { message: new TextDecoder().decode(bytes) } : {}) };
      return { ...response, body: replay(bytes) as unknown as GitHttpResponse['body'] };
    },
    failureOf(error) {
      if (thrown !== null && thrown.error === error) return thrown.failure;
      // isomorphic-git's HttpError: the status the server answered.
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      const status = error && typeof error === 'object' ? (error as { data?: { statusCode?: unknown } }).data?.statusCode : undefined;
      if (code === 'HttpError' && typeof status === 'number') {
        return answered !== null && answered.status === status ? answered : { kind: 'status', status };
      }
      return undefined;
    },
  };
}
