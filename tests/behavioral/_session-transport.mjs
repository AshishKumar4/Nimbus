// Public session protocol and credential ownership, scoped to one target.
// Policies (readiness, ledgers, retries, browser exchange) compose this data.
export function redactCredentials(text) {
  return String(text)
    .replace(/([?&#](?:nimbus_token|access_token|token)=)[^&#\s"'<>]+/gi, '$1…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1…');
}

export async function deletionResult(response) {
  const body = await response.text().catch(() => '');
  let document;
  try { document = JSON.parse(body); } catch { /* not a destroy result */ }
  const result = document?.result;
  const json = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
  const confirmed = response.ok && json && document?.ok === true && result?.ok === true
    && Number.isSafeInteger(result.killed) && result.killed >= 0
    && Number.isSafeInteger(result.destroyedAt) && result.destroyedAt >= 0
    && (result.reason === null || typeof result.reason === 'string');
  return { ok: Boolean(confirmed), status: response.status, body };
}

export async function deleteProbeSession(session, { reason, signal, request = globalThis.fetch } = {}) {
  const response = await request(`${session.base}/s/${encodeURIComponent(session.sessionId)}/`, {
    method: 'DELETE', headers: { ...session.headers, ...(reason ? { 'X-Nimbus-Cleanup-Reason': reason } : {}) }, signal,
  });
  return { ...await deletionResult(response), versionId: response.headers.get('x-nimbus-probe-version'), retryAfter: response.headers.get('retry-after') };
}

export function createProbeTarget({ base, token = '', cookie = '', request = globalThis.fetch }) {
  const targetHeaders = Object.freeze({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) });
  const sessions = new Map();
  const session = (sid) => sessions.get(sid) ?? { sessionId: sid, base, headers: targetHeaders, attachPath: `/s/${sid}/` };
  return {
    base,
    session,
    headers(extra = {}, sid) { return { ...(sid ? session(sid).headers : targetHeaders), ...extra }; },
    async create({ signal, anonymous = false } = {}) {
      const response = await request(`${base}/new`, { method: 'POST', redirect: 'manual', headers: targetHeaders, signal });
      const location = response.headers.get('location');
      const attach = location ? new URL(location, base) : null;
      const match = response.status === 302 && attach?.origin === new URL(base).origin ? /^\/s\/([^/]+)/.exec(attach.pathname) : null;
      let created;
      if (match) {
        created = { sessionId: match[1], base, headers: targetHeaders, attachPath: attach.pathname + attach.search + attach.hash, status: response.status,
          versionId: response.headers.get('x-nimbus-probe-version') };
      } else {
        const text = await response.text().catch(() => '');
        let code;
        try { code = JSON.parse(text)?.code; } catch { /* ordinary error response */ }
        if (anonymous && response.status === 401 && code === 'E_DEMO_LOGIN_REQUIRED' && !token && !cookie) {
          const opened = await request(`${base}/api/demo/anon-session`, { method: 'POST', signal });
          const body = await opened.json().catch(() => ({}));
          if (!opened.ok) throw new Error(`anon session ${opened.status}: ${redactCredentials(JSON.stringify(body))}`);
          const ws = body.wsUrl ? new URL(body.wsUrl, base) : null;
          const attachToken = ws?.searchParams.get('nimbus_token');
          const expectedWsOrigin = new URL(base).origin.replace(/^http/, 'ws');
          if (!body.sessionId || !attachToken || ![expectedWsOrigin, new URL(base).origin].includes(ws.origin)
            || !ws.pathname.startsWith(`/s/${encodeURIComponent(body.sessionId)}/`)) {
            throw new Error(`anon session gave no target/session-matching sid/token: ${redactCredentials(JSON.stringify(body))}`);
          }
          created = { sessionId: body.sessionId, base, headers: Object.freeze({ Authorization: `Bearer ${attachToken}` }),
            attachPath: `/s/${encodeURIComponent(body.sessionId)}/?nimbus_token=${encodeURIComponent(attachToken)}`,
            status: opened.status, versionId: opened.headers.get('x-nimbus-probe-version'), reap: 'ttl' };
        } else {
          const detail = redactCredentials(text.trim().split('\n')[0].slice(0, 200));
          const why = response.status === 401 || response.status === 403
            ? token ? 'the target rejected this probe\'s bearer token: JWT_SECRET rotated or the token expired; re-mint for this BASE with bun tests/behavioral/_staging-target.mjs token or bun tests/behavioral/_throwaway-target.mjs token --name <name>'
              : 'no probe credential was sent; supply NIMBUS_PROBE_TOKEN or NIMBUS_PROBE_COOKIE'
            : location ? `unexpected Location: ${redactCredentials(location)}` : `no Location${detail ? ': ' + detail : ''}`;
          throw new Error(`POST ${base}/new → ${response.status}: ${why}`);
        }
      }
      Object.freeze(created);
      sessions.set(created.sessionId, created);
      return created;
    },
    delete(sid, options) { return deleteProbeSession(session(sid), { ...options, request }); },
  };
}
