import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { isLoopbackHost, type Kernel } from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';
import { NIMBUS_AI_TOKEN_ENV, requestCarriesSessionAiToken } from '../../../../_shared/ai-egress.js';
import { NIMBUS_AI_GATEWAY_PORT } from '../../../../constants.js';

type CurlOptions = {
  method: string;
  headers: Record<string, string>;
  /** Request-body operands in argument order, resolved just before the request. */
  dataParts: CurlDataPart[];
  data?: string;
  outputFile?: string;
  /** -D/--dump-header target: response headers go to this file, or to stdout when it is '-'. */
  dumpHeaders?: string;
  silent: boolean;
  showError: boolean;
  followRedirects: boolean;
  fail: boolean;
  headOnly: boolean;
  writeOut?: string;
  traceAscii?: string;
  progressBar: boolean;
  maxTimeSeconds?: number;
  url?: string;
};

/**
 * One `-d` / `--data*` operand. curl reads `@path` from a file (`@-` from
 * stdin) and only `--data-raw` takes the `@` literally; `--data`/`--data-ascii`
 * additionally strip newlines, while `--data-binary` keeps the bytes as they
 * are. Sending the literal string `@/path/to/file` is never correct.
 */
type CurlDataPart = {
  readonly value: string;
  readonly fromFile: boolean;
  readonly stripNewlines: boolean;
};

type CurlBody = string | Uint8Array | ReadableStream<Uint8Array>;

type CurlResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: CurlBody;
  url: string;
};

type VirtualCurlResult =
  | { kind: 'response'; response: CurlResponse }
  | { kind: 'external'; url: string }
  | { kind: 'error'; exitCode: number };

type VirtualResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  _donePromise?: Promise<void>;
};

const SHORT_VALUE_OPTIONS = new Set(['X', 'H', 'd', 'o', 'w', 'D']);

/** What a header dump needs from a response — native Response or shaped. */
type CurlHeaderSource = {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string>;
};
const MAX_REDIRECTS = 20;

/** curl's exit code for local write failures (-o/-D targets). */
const CURL_WRITE_ERROR_EXIT = 23;

/**
 * A dump-target failure is a local write problem, not a transport error: it
 * must surface as exit 23 with the precise cause, never as a rejected
 * virtual call or a generic connection-failure exit 7.
 */
class CurlHeaderWriteError extends Error {
  constructor(action: string, target: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${action} dump-header file '${target}': ${detail}`);
  }
}

/**
 * Transfer-scoped sink for -D/--dump-header, opened once per command before
 * the request. '-' streams straight to stdout with no init; a VFS path is
 * truncated into existence up front — an empty file is the truthful record
 * of a response that never arrived — and every received header block is
 * persisted on arrival, before any body drain. With no -D flag at all the
 * sink is inert; an empty-string target is still a target — it resolves to
 * the cwd, the write is attempted up front, and failing it exits 23.
 */
class CurlHeaderSink {
  private readonly ctx: Parameters<Command>[0];
  private readonly target: string | null;
  private contents: string[] = [];

  constructor(ctx: Parameters<Command>[0], target: string | null) {
    this.ctx = ctx;
    this.target = target;
  }

  /** True when no -D was given: every sink method is a no-op. */
  get inert(): boolean {
    return this.target === null;
  }

  /** Truncate/create the file target up front; '-' needs no init, no -D skips. */
  async open(): Promise<void> {
    if (this.target === null || this.target === '-') return;
    try {
      this.ctx.vfs.writeFile(resolve(this.ctx.cwd, this.target), '');
    } catch (error) {
      throw new CurlHeaderWriteError('create', this.target, error);
    }
  }

  /** Persist one received response's header block, in arrival order. */
  async writeBlock(response: CurlHeaderSource): Promise<void> {
    if (this.target === null) return;
    const block = curlHeaderBlock(response);
    try {
      if (this.target === '-') {
        this.ctx.stdout.write(block);
        return;
      }
      this.contents.push(block);
      this.ctx.vfs.writeFile(resolve(this.ctx.cwd, this.target), this.contents.join(''));
    } catch (error) {
      throw new CurlHeaderWriteError('write', this.target, error);
    }
  }
}

function reportCurlWriteError(ctx: Parameters<Command>[0], error: CurlHeaderWriteError): number {
  ctx.stderr.write(`curl: (${CURL_WRITE_ERROR_EXIT}) Failed ${error.message}\n`);
  return CURL_WRITE_ERROR_EXIT;
}

/**
 * Persist one arrived response block; a failing dump target cancels the
 * undrained body before the write error surfaces, so the abandoned
 * transfer leaks no stream on its way to exit 23.
 */
async function writeHeaderDump(sink: CurlHeaderSink, response: Response): Promise<void> {
  try {
    await sink.writeBlock(response);
  } catch (error) {
    cancelStreamBody(response.body);
    throw error;
  }
}

function createCurlImpl(kernel?: Kernel): Command {
  return async (ctx) => {
    const options = parseCurlArgs(ctx.args);
    let url = options.url;

    if (!url) {
      ctx.stderr.write('curl: no URL specified\n');
      ctx.stderr.write('Usage: curl [-fsSLI#] [-X method] [-H header] [-d data] [-o file] [-D file] [-w format] url\n');
      return 1;
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      options.data = await resolveCurlData(ctx, options.dataParts);
    } catch (error) {
      ctx.stderr.write(`curl: ${error instanceof Error ? error.message : String(error)}\n`);
      return 26;
    }

    const headers = new CurlHeaderSink(ctx, options.dumpHeaders ?? null);
    try {
      const requestSignal = createRequestSignal(ctx.signal, options.maxTimeSeconds);
      try {
        await headers.open();

        if (kernel?.portRegistry) {
          const virtual = await resolveVirtualCurlResponse(kernel, ctx, options, url, headers);
          if (virtual?.kind === 'response') {
            return handleCurlResponse(ctx, options, virtual.response);
          }
          if (virtual?.kind === 'external') {
            url = virtual.url;
          }
          if (virtual?.kind === 'error') {
            return virtual.exitCode;
          }
        }

        // -L with a dump target needs every hop's headers, so redirects are
        // followed manually here; without -D the fetch-native follow keeps
        // its proven semantics.
        if (options.followRedirects && !headers.inert) {
          return await followExternalWithDump(ctx, options, url, headers, requestSignal.signal);
        }

        const response = await fetch(url, {
          method: options.method,
          headers: Object.keys(options.headers).length > 0 ? options.headers : undefined,
          body: options.data,
          redirect: options.followRedirects ? 'follow' : 'manual',
          signal: requestSignal.signal,
        });
        // Headers are dumped on arrival — before any arrayBuffer()/body drain.
        await writeHeaderDump(headers, response);
        return await handleCurlResponse(ctx, options, await drainCurlResponse(options, response, response.url || url));
      } finally {
        requestSignal.cleanup();
      }
    } catch (error) {
      if (error instanceof CurlHeaderWriteError) {
        return reportCurlWriteError(ctx, error);
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === CURL_TIMEOUT_ERROR) {
        ctx.stderr.write(`curl: operation timed out after ${options.maxTimeSeconds} seconds\n`);
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
        ctx.stderr.write(`curl: (7) Failed to connect to ${url}\n`);
        ctx.stderr.write(`Note: This may be a CORS restriction. The target server must allow cross-origin requests.\n`);
      } else {
        ctx.stderr.write(`curl: ${msg}\n`);
      }
      return 7;
    }
  };
}

/** Request headers fetch-follow strips when a redirect crosses origins. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2'];

/** Content headers that only make sense on a request that carries a body. */
const CONTENT_HEADERS = ['content-type', 'content-length', 'transfer-encoding', 'expect'];

/**
 * Bounded manual redirect walk for external -L with a dump target: every
 * hop's header block is written on arrival, and the final response goes
 * through normal handling; exceeding the cap reports curl's redirect error.
 * Request mutation mirrors fetch-follow: 301/302 collapse only POST to a
 * bodyless GET, 303 collapses everything but HEAD, 307/308 preserve method
 * and body; content headers go with the body, and credential headers are
 * stripped when a hop crosses origins.
 */
async function followExternalWithDump(
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  startUrl: string,
  headers: CurlHeaderSink,
  signal: AbortSignal,
): Promise<number> {
  let current = new URL(startUrl);
  let method = options.method;
  let data = options.data;
  let requestHeaders = new Headers(Object.keys(options.headers).length > 0 ? options.headers : {});
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      method,
      headers: [...requestHeaders.keys()].length > 0 ? requestHeaders : undefined,
      body: data,
      redirect: 'manual',
      signal,
    });
    // Dump on arrival — before any drain of this hop's body.
    await writeHeaderDump(headers, response);
    const record = headersToRecord(response.headers);

    if (!isRedirectStatus(response.status)) {
      return await handleCurlResponse(
        ctx,
        options,
        await drainCurlResponse(options, response, response.url || current.toString()),
      );
    }
    const location = getHeader(record, 'location');
    if (!location) {
      // Redirect status without a target: nothing to follow, handle as final.
      return await handleCurlResponse(
        ctx,
        options,
        await drainCurlResponse(options, response, response.url || current.toString()),
      );
    }
    if (redirects === MAX_REDIRECTS) {
      cancelStreamBody(response.body);
      break;
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      // Unusable Location: this hop is as final as it gets — the body must
      // still be drainable, so it is only released once we decide to follow.
      return await handleCurlResponse(
        ctx,
        options,
        await drainCurlResponse(options, response, current.toString()),
      );
    }
    // Follow decision made: this hop's body is no longer needed.
    cancelStreamBody(response.body);
    if ([301, 302].includes(response.status) && method === 'POST') {
      method = 'GET';
      data = undefined;
    } else if (response.status === 303 && method !== 'HEAD') {
      method = 'GET';
      data = undefined;
    }
    if (data === undefined) {
      for (const name of CONTENT_HEADERS) requestHeaders.delete(name);
    }
    if (next.origin !== current.origin) {
      for (const name of CREDENTIAL_HEADERS) requestHeaders.delete(name);
    }
    current = next;
  }
  ctx.stderr.write(`curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed\n`);
  return 47;
}

/**
 * Shape a native Response for response handling. Body streams to stdout as
 * they arrive (SSE/chunked responses flow live); an -o file needs the whole
 * payload for a single VFS write.
 */
async function drainCurlResponse(
  options: CurlOptions,
  response: Response,
  url: string,
): Promise<CurlResponse> {
  const body = options.outputFile
    ? new Uint8Array(await response.arrayBuffer())
    : response.body ?? '';
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    body,
    url,
  };
}

const CURL_TIMEOUT_ERROR = 'curl request timeout';

function parseCurlArgs(args: string[]): CurlOptions {
  const options: CurlOptions = {
    method: 'GET',
    headers: {},
    dataParts: [],
    silent: false,
    showError: false,
    followRedirects: false,
    fail: false,
    headOnly: false,
    progressBar: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      if (args[i + 1] !== undefined) options.url = args[i + 1];
      break;
    }

    if (arg.startsWith('--')) {
      const consumed = parseLongOption(options, arg, args, i);
      i += consumed;
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      const consumed = parseShortOptions(options, arg, args, i);
      i += consumed;
      continue;
    }

    options.url = arg;
  }

  return options;
}

function parseLongOption(options: CurlOptions, arg: string, args: string[], index: number): number {
  const eqIdx = arg.indexOf('=');
  const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
  const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
  const readValue = (): { value: string; consumed: number } => {
    if (inlineValue !== undefined) return { value: inlineValue, consumed: 0 };
    return { value: args[index + 1] ?? '', consumed: 1 };
  };

  switch (name) {
    case '--request': {
      const { value, consumed } = readValue();
      options.method = value || 'GET';
      return consumed;
    }
    case '--header': {
      const { value, consumed } = readValue();
      addHeader(options, value);
      return consumed;
    }
    case '--data':
    case '--data-ascii':
    case '--data-raw':
    case '--data-binary': {
      const { value, consumed } = readValue();
      addDataPart(options, value, {
        allowFile: name !== '--data-raw',
        stripNewlines: name === '--data' || name === '--data-ascii',
      });
      return consumed;
    }
    case '--output': {
      const { value, consumed } = readValue();
      options.outputFile = value;
      return consumed;
    }
    case '--dump-header': {
      const { value, consumed } = readValue();
      options.dumpHeaders = value;
      return consumed;
    }
    case '--write-out': {
      const { value, consumed } = readValue();
      options.writeOut = value;
      return consumed;
    }
    case '--trace-ascii': {
      const { value, consumed } = readValue();
      options.traceAscii = value;
      return consumed;
    }
    case '--max-time':
    case '--connect-timeout': {
      const { value, consumed } = readValue();
      options.maxTimeSeconds = parsePositiveNumber(value);
      return consumed;
    }
    case '--silent':
      options.silent = true;
      return 0;
    case '--show-error':
      options.showError = true;
      return 0;
    case '--location':
      options.followRedirects = true;
      return 0;
    case '--fail':
      options.fail = true;
      return 0;
    case '--head':
      options.headOnly = true;
      options.method = 'HEAD';
      return 0;
    case '--progress-bar':
      options.progressBar = true;
      return 0;
    default:
      return 0;
  }
}

function parseShortOptions(options: CurlOptions, arg: string, args: string[], index: number): number {
  const chars = arg.slice(1);
  for (let j = 0; j < chars.length; j++) {
    const flag = chars[j];
    if (!flag) continue;

    if (SHORT_VALUE_OPTIONS.has(flag)) {
      const rest = chars.slice(j + 1);
      const value = rest || args[index + 1] || '';
      applyShortValueOption(options, flag, value);
      return rest ? 0 : 1;
    }

    applyShortBooleanOption(options, flag);
  }
  return 0;
}

function applyShortBooleanOption(options: CurlOptions, flag: string): void {
  switch (flag) {
    case 's':
      options.silent = true;
      break;
    case 'S':
      options.showError = true;
      break;
    case 'L':
      options.followRedirects = true;
      break;
    case 'f':
      options.fail = true;
      break;
    case 'I':
      options.headOnly = true;
      options.method = 'HEAD';
      break;
    case '#':
      options.progressBar = true;
      break;
  }
}

function applyShortValueOption(options: CurlOptions, flag: string, value: string): void {
  switch (flag) {
    case 'X':
      options.method = value || 'GET';
      break;
    case 'H':
      addHeader(options, value);
      break;
    case 'd':
      addDataPart(options, value, { allowFile: true, stripNewlines: true });
      break;
    case 'o':
      options.outputFile = value;
      break;
    case 'w':
      options.writeOut = value;
      break;
    case 'D':
      options.dumpHeaders = value;
      break;
  }
}

/**
 * Turns `-d` operands into the request body: `@path` becomes that file's
 * contents, `@-` becomes stdin, and multiple operands join with `&` the way
 * curl assembles a form body. Returns undefined when no body was requested.
 */
async function resolveCurlData(
  ctx: Parameters<Command>[0],
  parts: CurlDataPart[],
): Promise<string | undefined> {
  if (parts.length === 0) return undefined;

  const resolved: string[] = [];
  for (const part of parts) {
    let value = part.value;
    if (part.fromFile) {
      if (value === '-') {
        value = ctx.stdin ? await ctx.stdin.readAll() : '';
      } else {
        try {
          value = ctx.vfs.readFileString(resolve(ctx.cwd, value));
        } catch (error) {
          throw new Error(`Failed to open ${part.value}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    resolved.push(part.stripNewlines ? value.replace(/[\r\n]/g, '') : value);
  }
  return resolved.join('&');
}

function addDataPart(
  options: CurlOptions,
  value: string,
  spec: { allowFile: boolean; stripNewlines: boolean },
): void {
  const fromFile = spec.allowFile && value.startsWith('@');
  options.dataParts.push({
    value: fromFile ? value.slice(1) : value,
    fromFile,
    stripNewlines: spec.stripNewlines,
  });
  if (options.method === 'GET') options.method = 'POST';
}

function addHeader(options: CurlOptions, header: string): void {
  const colonIdx = header.indexOf(':');
  if (colonIdx === -1) return;
  options.headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
}

async function resolveVirtualCurlResponse(
  kernel: Kernel,
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  startUrl: string,
  headers: CurlHeaderSink,
): Promise<VirtualCurlResult | null> {
  let currentUrl = startUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchVirtualCurlResponse(kernel, ctx, options, currentUrl, headers);
    if (!response) {
      return redirects === 0 ? null : { kind: 'external', url: currentUrl };
    }
    if ('exitCode' in response) {
      return { kind: 'error', exitCode: response.exitCode };
    }

    if (options.followRedirects && isRedirectStatus(response.status)) {
      const location = getHeader(response.headers, 'location');
      if (location) {
        try {
          currentUrl = new URL(location, currentUrl).toString();
          cancelStreamBody(response.body);
          continue;
        } catch {
          return { kind: 'response', response };
        }
      }
    }

    return { kind: 'response', response };
  }

  ctx.stderr.write(`curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed\n`);
  return { kind: 'error', exitCode: 47 };
}

/**
 * Hand one curl request to the supervisor's loopback router and shape the
 * answer as curl sees it. Null when nothing is listening on `port`.
 */
async function routeCurlOverLoopback(
  kernel: Kernel,
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  requestUrl: URL,
  url: string,
  port: number,
  headers: CurlHeaderSink,
): Promise<CurlResponse | null> {
  if (!kernel.routeLoopback) return null;
  const hasBody = options.method !== 'GET' && options.method !== 'HEAD' && options.data !== undefined;
  const response = await kernel.routeLoopback(port, new Request(requestUrl, {
    method: options.method,
    headers: options.headers,
    body: hasBody ? options.data : undefined,
    signal: ctx.signal,
  }));
  if (!response) return null;
  // Dump on arrival — before the optional arrayBuffer() drain below.
  await writeHeaderDump(headers, response);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    // Stream to stdout as bytes arrive (a facet's SSE flows live);
    // an -o file needs the whole payload for a single VFS write.
    body: options.outputFile
      ? new Uint8Array(await response.arrayBuffer())
      : response.body ?? '',
    url: response.url || url,
  };
}

async function fetchVirtualCurlResponse(
  kernel: Kernel,
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  url: string,
  headers: CurlHeaderSink,
): Promise<CurlResponse | { exitCode: number } | null> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(url);
  } catch {
    return null;
  }

  let host = requestUrl.hostname;
  const port = requestUrl.port ? Number(requestUrl.port) : (requestUrl.protocol === 'http:' ? 80 : 443);
  if (kernel.networkStack && !isLoopbackHost(host)) {
    host = kernel.networkStack.getDNS().lookup(host)?.value ?? host;
  }

  // Off-box, but possibly still ours: a request that presents this session's
  // AI capability token is inference the session owns, and is served by the
  // session's gateway wherever it was addressed — which is how `curl
  // https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`
  // answers with the session's models. Anything carrying a different
  // credential is not ours and goes to the network. See _shared/ai-egress.ts.
  if (!isLoopbackHost(host)) {
    if (!requestCarriesSessionAiToken(new Headers(options.headers), ctx.env[NIMBUS_AI_TOKEN_ENV] || '')) {
      return null;
    }
    return routeCurlOverLoopback(kernel, ctx, options, requestUrl, url, NIMBUS_AI_GATEWAY_PORT, headers);
  }

  const handler = kernel.portRegistry.get(port);
  if (handler) {
    const vReq = {
      method: options.method,
      url: requestUrl.pathname + requestUrl.search,
      headers: options.headers,
      body: options.data || '',
    };
    const vRes: VirtualResponse = {
      statusCode: 200,
      headers: {},
      body: '',
    };

    handler(vReq, vRes);

    if (vRes._donePromise) {
      const result = await waitForSignalOrTimeout(vRes._donePromise, ctx.signal, 30_000);
      if (result.type === 'aborted') {
        return { exitCode: 130 };
      }
      if (result.type === 'timeout') {
        ctx.stderr.write('curl: request timeout after 30s\n');
        return { exitCode: 7 };
      }
    }

    await headers.writeBlock({
      status: vRes.statusCode,
      statusText: statusText(vRes.statusCode),
      headers: vRes.headers,
    });
    return {
      status: vRes.statusCode,
      statusText: statusText(vRes.statusCode),
      headers: vRes.headers,
      body: vRes.body,
      url,
    };
  }

  const routed = await routeCurlOverLoopback(kernel, ctx, options, requestUrl, url, port, headers);
  if (routed) return routed;

  ctx.stderr.write(`curl: (7) Failed to connect to ${requestUrl.hostname} port ${port}\n`);
  return { exitCode: 7 };
}

async function handleCurlResponse(ctx: Parameters<Command>[0], options: CurlOptions, response: CurlResponse): Promise<number> {
  const failed = options.fail && response.status >= 400;

  if (options.headOnly) {
    cancelStreamBody(response.body);
    if (!failed) {
      await writeCurlOutput(ctx, options, curlHeaderBlock(response));
    }
    writeCurlFailure(ctx, options, response);
    writeCurlWriteOut(ctx, options, response);
    return curlExitCode(options, response.status);
  }

  if (!failed) {
    await writeCurlOutput(ctx, options, response.body);
    if (options.outputFile && !options.silent) {
      const size = bodySize(response.body);
      ctx.stderr.write(`  % Total    % Received\n`);
      ctx.stderr.write(`  ${size}    ${size}\n`);
    }
  } else {
    cancelStreamBody(response.body);
  }

  writeCurlFailure(ctx, options, response);
  writeCurlWriteOut(ctx, options, response);
  return curlExitCode(options, response.status);
}

function cancelStreamBody(body: CurlBody | ReadableStream<unknown> | null): void {
  if (body instanceof ReadableStream) {
    body.cancel().catch(() => {});
  }
}

/**
 * --fail diagnostic: curl's own wording pairs its exit code with the
 * offending HTTP status.
 */
function writeCurlFailure(ctx: Parameters<Command>[0], options: CurlOptions, response: CurlResponse): void {
  if (options.fail && options.showError && response.status >= 400) {
    ctx.stderr.write(`curl: (22) The requested URL returned error: ${response.status}\n`);
  }
}

function curlExitCode(options: CurlOptions, status: number): number {
  return options.fail && status >= 400 ? 22 : 0;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

async function writeCurlOutput(ctx: Parameters<Command>[0], options: CurlOptions, body: CurlBody): Promise<void> {
  if (!options.outputFile) {
    if (typeof body === 'string') {
      ctx.stdout.write(body);
      if (!body.endsWith('\n')) ctx.stdout.write('\n');
    } else if (body instanceof Uint8Array) {
      ctx.stdout.write(new TextDecoder().decode(body));
    } else {
      await streamCurlBodyToStdout(ctx, body);
    }
    return;
  }
  if (options.outputFile === '/dev/null') {
    cancelStreamBody(body);
    return;
  }
  if (body instanceof ReadableStream) {
    // Streams reach here only via the no-outputFile construction paths;
    // fail loud rather than silently writing a broken file.
    cancelStreamBody(body);
    throw new Error('curl: internal error — streaming body cannot be written to an output file');
  }
  ctx.vfs.writeFile(resolve(ctx.cwd, options.outputFile), body);
}

/**
 * Relay a streaming body to stdout chunk-by-chunk as bytes arrive — this is
 * what lets `curl -N` against an SSE/chunked endpoint display live instead of
 * flushing everything at stream end. Ctrl-C (ctx.signal) cancels the read.
 */
async function streamCurlBodyToStdout(ctx: Parameters<Command>[0], body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (ctx.signal.aborted) {
    onAbort();
    return;
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let tail = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) {
        ctx.stdout.write(text);
        tail = text;
      }
    }
    const flushed = decoder.decode();
    if (flushed) {
      ctx.stdout.write(flushed);
      tail = flushed;
    }
    if (tail && !tail.endsWith('\n')) ctx.stdout.write('\n');
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function writeCurlWriteOut(
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  response: { status: number; url: string },
): void {
  if (!options.writeOut) return;
  ctx.stdout.write(formatWriteOut(options.writeOut, response));
}

function formatWriteOut(template: string, response: { status: number; url: string }): string {
  return template
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/%\{http_code\}/g, String(response.status))
    .replace(/%\{response_code\}/g, String(response.status))
    .replace(/%\{url_effective\}/g, response.url);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
function curlHeaderEntries(headers: Headers | Record<string, string>): [string, string][] {
  if (!(headers instanceof Headers)) return Object.entries(headers);
  // TS's Headers lib type predates getSetCookie; the runtime has it.
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const pairs: [string, string][] = [];
  for (const [name, value] of headers.entries()) {
    if (typeof getSetCookie === 'function' && name.toLowerCase() === 'set-cookie') continue;
    pairs.push([name, value]);
  }
  if (typeof getSetCookie === 'function') {
    for (const value of getSetCookie.call(headers)) pairs.push(['set-cookie', value]);
  }
  return pairs;
}
/**
 * The received response as an HTTP/1.1 header block: status line plus each
 * header terminated CRLF, closed by the blank CRLF line that ends every
 * header section. fetch exposes no negotiated wire version, so HTTP/1.1 is
 * the explicit compatibility representation — a bare `HTTP/<code>` is not
 * valid status-line syntax. Both -I's stdout display and -D's dump share
 * this one serializer so the two surfaces cannot drift.
 */
function curlHeaderBlock(response: CurlHeaderSource): string {
  const reason = response.statusText;
  const statusLine = reason
    ? `HTTP/1.1 ${response.status} ${reason}`
    : `HTTP/1.1 ${response.status}`;
  const lines = [statusLine, ...curlHeaderEntries(response.headers).map(([n, v]) => `${n}: ${v}`)];
  return lines.map((line) => `${line}\r\n`).join('') + '\r\n';
}
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function bodySize(body: CurlBody): number {
  if (typeof body === 'string') return body.length;
  return body instanceof Uint8Array ? body.byteLength : 0;
}

function statusText(status: number): string {
  switch (status) {
    case 200: return 'OK';
    case 201: return 'Created';
    case 204: return 'No Content';
    case 301: return 'Moved Permanently';
    case 302: return 'Found';
    case 303: return 'See Other';
    case 307: return 'Temporary Redirect';
    case 308: return 'Permanent Redirect';
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 500: return 'Internal Server Error';
    default: return '';
  }
}

function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createRequestSignal(parent: AbortSignal, timeoutSeconds: number | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  if (timeoutSeconds === undefined) {
    return { signal: parent, cleanup: () => {} };
  }

  const controller = new AbortController();
  let parentListenerAdded = false;
  const timeout = setTimeout(() => {
    controller.abort(new Error(CURL_TIMEOUT_ERROR));
  }, timeoutSeconds * 1000);

  const abortFromParent = () => {
    controller.abort(parent.reason);
  };

  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener('abort', abortFromParent, { once: true });
    parentListenerAdded = true;
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parentListenerAdded) parent.removeEventListener('abort', abortFromParent);
    },
  };
}

export function createCurlCommand(kernel: Kernel): Command {
  return createCurlImpl(kernel);
}

// Default command (no kernel -- always uses fetch)
const command: Command = createCurlImpl();

export default command;
