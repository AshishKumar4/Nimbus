import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import type { Kernel } from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';

type CurlOptions = {
  method: string;
  headers: Record<string, string>;
  data?: string;
  outputFile?: string;
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

type CurlResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
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

const SHORT_VALUE_OPTIONS = new Set(['X', 'H', 'd', 'o', 'w']);
const MAX_REDIRECTS = 20;

function createCurlImpl(kernel?: Kernel): Command {
  return async (ctx) => {
    const options = parseCurlArgs(ctx.args);
    let url = options.url;

    if (!url) {
      ctx.stderr.write('curl: no URL specified\n');
      ctx.stderr.write('Usage: curl [-fsSLI#] [-X method] [-H header] [-d data] [-o file] [-w format] url\n');
      return 1;
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    if (kernel?.portRegistry) {
      const virtual = await resolveVirtualCurlResponse(kernel, ctx, options, url);
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

    try {
      const requestSignal = createRequestSignal(ctx.signal, options.maxTimeSeconds);
      const fetchOptions: RequestInit = {
        method: options.method,
        headers: Object.keys(options.headers).length > 0 ? options.headers : undefined,
        body: options.data,
        redirect: options.followRedirects ? 'follow' : 'manual',
        signal: requestSignal.signal,
      };

      try {
        const response = await fetch(url, fetchOptions);
        const effectiveUrl = response.url || url;
        const body = options.outputFile
          ? new Uint8Array(await response.arrayBuffer())
          : await response.text();
        return handleCurlResponse(ctx, options, {
          status: response.status,
          statusText: response.statusText,
          headers: headersToRecord(response.headers),
          body,
          url: effectiveUrl,
        });
      } finally {
        requestSignal.cleanup();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

const CURL_TIMEOUT_ERROR = 'curl request timeout';

function parseCurlArgs(args: string[]): CurlOptions {
  const options: CurlOptions = {
    method: 'GET',
    headers: {},
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
    case '--data-raw':
    case '--data-binary': {
      const { value, consumed } = readValue();
      options.data = value;
      if (options.method === 'GET') options.method = 'POST';
      return consumed;
    }
    case '--output': {
      const { value, consumed } = readValue();
      options.outputFile = value;
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
      options.data = value;
      if (options.method === 'GET') options.method = 'POST';
      break;
    case 'o':
      options.outputFile = value;
      break;
    case 'w':
      options.writeOut = value;
      break;
  }
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
): Promise<VirtualCurlResult | null> {
  let currentUrl = startUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchVirtualCurlResponse(kernel, ctx, options, currentUrl);
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

async function fetchVirtualCurlResponse(
  kernel: Kernel,
  ctx: Parameters<Command>[0],
  options: CurlOptions,
  url: string,
): Promise<CurlResponse | { exitCode: number } | null> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(url);
  } catch {
    return null;
  }

  let host = requestUrl.hostname;
  const port = requestUrl.port ? Number(requestUrl.port) : (requestUrl.protocol === 'http:' ? 80 : 443);
  if (kernel.networkStack && host !== '127.0.0.1' && host !== 'localhost') {
    try {
      host = await kernel.networkStack.resolveHostname(host);
    } catch {
      // Keep the original host; non-virtual names fall through to fetch.
    }
  }

  if (host !== 'localhost' && host !== '127.0.0.1') {
    return null;
  }

  const handler = kernel.portRegistry.get(port);
  if (!handler) {
    return null;
  }

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

  return {
    status: vRes.statusCode,
    statusText: statusText(vRes.statusCode),
    headers: vRes.headers,
    body: vRes.body,
    url,
  };
}

function handleCurlResponse(ctx: Parameters<Command>[0], options: CurlOptions, response: CurlResponse): number {
  const failed = options.fail && response.status >= 400;

  if (options.headOnly) {
    if (!failed) {
      writeCurlOutput(ctx, options, curlHeaders(response));
    }
    writeCurlFailure(ctx, options, response);
    writeCurlWriteOut(ctx, options, response);
    return curlExitCode(options, response.status);
  }

  if (!failed) {
    writeCurlOutput(ctx, options, response.body);
    if (options.outputFile && !options.silent) {
      const size = bodySize(response.body);
      ctx.stderr.write(`  % Total    % Received\n`);
      ctx.stderr.write(`  ${size}    ${size}\n`);
    }
  }

  writeCurlFailure(ctx, options, response);
  writeCurlWriteOut(ctx, options, response);
  return curlExitCode(options, response.status);
}

function writeCurlFailure(ctx: Parameters<Command>[0], options: CurlOptions, response: CurlResponse): void {
  if (options.fail && options.showError && response.status >= 400) {
    ctx.stderr.write(`curl: (${response.status}) The requested URL returned error: ${response.status}\n`);
  }
}

function writeCurlOutput(ctx: Parameters<Command>[0], options: CurlOptions, body: string | Uint8Array): void {
  if (!options.outputFile) {
    if (typeof body === 'string') {
      ctx.stdout.write(body);
      if (!body.endsWith('\n')) ctx.stdout.write('\n');
    } else {
      ctx.stdout.write(new TextDecoder().decode(body));
    }
    return;
  }
  if (options.outputFile === '/dev/null') return;
  ctx.vfs.writeFile(resolve(ctx.cwd, options.outputFile), body);
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

function curlHeaders(response: CurlResponse): string {
  const lines = [`HTTP/${response.status} ${response.statusText}`];
  for (const [key, value] of Object.entries(response.headers)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n') + '\n';
}

function curlExitCode(options: CurlOptions, status: number): number {
  return options.fail && status >= 400 ? 22 : 0;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function bodySize(body: string | Uint8Array): number {
  return typeof body === 'string' ? body.length : body.byteLength;
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
