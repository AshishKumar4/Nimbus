/**
 * _shared/http.ts — Tiny Response builders for HTTP handlers.
 *
 * Reduces the `new Response(JSON.stringify(...), { status, headers: {
 * 'Content-Type': 'application/json' }})` boilerplate that appears
 * dozens of times across the request handlers in nimbus-session.ts and
 * its smaller siblings. Centralizes header policy for future evolution
 * (CORS, request-id propagation, error envelope shape, etc.).
 *
 * Phase-2 scope: helpers exported, no per-call-site migration yet.
 * Per-site migration is a follow-on cleanup once the helpers are
 * proven against a few hot paths.
 */

const JSON_HEADERS: HeadersInit = {
  'Content-Type': 'application/json; charset=utf-8',
};

/**
 * Build a JSON response. Equivalent to `Response.json(data, init)` but
 * lets us evolve the default header set (e.g. add CORS, request-id) in
 * one place.
 */
export function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * Build a JSON error response. Standardizes the `{ error: string }`
 * shape used across Nimbus handlers. Future error-envelope migration
 * (see REFACTOR-PLAN.md Phase 7) will swap this for the richer
 * { code, message, httpStatus, ... } envelope without changing call
 * sites.
 */
export function errJson(message: string, status: number = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}
