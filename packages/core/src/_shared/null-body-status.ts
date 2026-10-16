/**
 * _shared/null-body-status.ts — the statuses whose response has no body, as
 * Fetch names them (a "null body status"), for every layer that relays a
 * response into a Response: the Response constructor refuses a body for any
 * of them, an empty one included.
 */

export function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
}
