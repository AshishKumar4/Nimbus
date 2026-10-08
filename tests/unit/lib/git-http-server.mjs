// A real git smart-HTTP server for unit tests: `git http-backend` as a CGI
// behind Bun.serve, serving the bare repositories under one root, with
// filter and wants-by-id enabled as GitHub has them (`plain: true` keeps
// http-backend's defaults, neither; a repository's own config can still
// enable one). Counts requests by path. `refuse(path, body)`: a request it
// says so of is answered 403, as a server that stops serving answers.

import { spawn } from 'node:child_process';

export function startGitHttpServer(projectRoot, { plain = false, refuse = null } = {}) {
  const config = plain ? [] : ['-c', 'uploadpack.allowFilter=true', '-c', 'uploadpack.allowAnySHA1InWant=true'];
  const requests = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
      if (refuse !== null && refuse(url.pathname, body)) return new Response('refused', { status: 403 });
      const child = spawn('git', [...config, 'http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      child.stdin.end(body);
      const chunks = [];
      for await (const chunk of child.stdout) chunks.push(chunk);
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      const headerText = output.subarray(0, split).toString('latin1');
      const headers = new Headers();
      let status = 200;
      for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers.set(name, value);
      }
      return new Response(output.subarray(split + 4), { status, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
