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
import type { GitHttp } from './transport.js';
/** Why a request to the git server failed. */
export type RemoteFailure = 
/** No answer: the connection, DNS, TLS or the stream failed. `detail` says how. */
{
    kind: 'transport';
    detail: string;
}
/** An answer with a failing status; `message` is its body when that is text/plain (show_http_message). */
 | {
    kind: 'status';
    status: number;
    message?: string;
};
/**
 * transport_anonymize_url: `url` without the user name and password its
 * authority may carry.
 */
export declare function anonymizeUrl(url: string): string;
/**
 * git's lines for `failure` of the repository at `url` (as configured or
 * given), `credentials` whether any were offered: the server's plain-text
 * message as `remote:` lines, then git's own.
 */
export declare function remoteFailureText(url: string, failure: RemoteFailure, credentials: boolean): string;
/** The message of an answer's body, when its type is text/plain (show_http_message); the body is read. */
export declare function plainTextMessage(contentType: string | null, body: ReadableStream<Uint8Array> | null): Promise<string | undefined>;
/**
 * What `error`, the facet's failure, says failed at the git server: an
 * UploadPackError's (a clone's own requests), or cf-git's through `http`;
 * undefined when it is not the server's failure.
 */
export declare function remoteFailureOf(error: unknown, http?: ObservedGitHttp): RemoteFailure | undefined;
/** cf-git's HTTP client, with the failure of its last request kept (`failureOf`). */
export interface ObservedGitHttp extends GitHttp {
    /** What `error` (thrown by cf-git) says failed at the server, or undefined when it is not a server's failure. */
    failureOf(error: unknown): RemoteFailure | undefined;
}
/**
 * `http` with each failure kept: a request that threw (the transport: that
 * error), and an answer with a failing status (its status, and its body when
 * plain text, which cf-git still reads after). cf-git's HttpError for that
 * status, or the transport's own error, is then known for what it is.
 */
export declare function observedGitHttp(http: GitHttp): ObservedGitHttp;
//# sourceMappingURL=remote-failure.d.ts.map