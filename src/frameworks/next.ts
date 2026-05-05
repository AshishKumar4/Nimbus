/**
 * frameworks/next.ts — Next.js loud-block stub.
 *
 * Next.js dev is BLOCKED in W11 / Phase 1 substrate. The framework's
 * `next dev` binary spawns child workers via `child_process.fork` with
 * v8-serialized IPC channels (not the JSON projection W8 ships), runs
 * webpack/Turbopack as the bundler (Turbopack is a Rust binary;
 * webpack works inside Node but Nimbus's pre-bundle pipeline doesn't
 * know how to feed it), and expects a long-lived `http.Server.listen()`
 * with full TCP semantics that our facet substrate can't fully emulate.
 *
 * Rather than letting `npm run dev` hang silently, this module surfaces
 * a deterministic loud-block message with exact next-step pointers.
 *
 * Tracked: W11-retro.md §6 (W11.5 candidates) — Next.js full support
 * needs (a) v8-serializer fork IPC, (b) webpack-aware pre-bundle path
 * or webpack-in-facet, (c) Cloudchamber container-in-DO when SHIP-10537
 * GA's.
 */

export const description =
  "Next.js — BLOCKED in Phase 1 (custom server, child_process v8-IPC, webpack/Turbopack). See W11-retro §6 for W11.5 plan.";

export const BLOCK_MESSAGE = (
  '\x1b[31m\u2718\x1b[0m \x1b[1mNext.js dev server is BLOCKED in Phase 1\x1b[0m of Nimbus.\n' +
  '   Specific blockers:\n' +
  "     1. \x1b[2mchild_process.fork\x1b[0m IPC uses v8-serializer (Nimbus' W8 facets ship JSON projection).\n" +
  '     2. webpack/Turbopack bundlers are not yet integrated with the pre-bundle pipeline.\n' +
  '     3. Custom \x1b[2mhttp.Server\x1b[0m semantics (keep-alive, raw sockets) are facet-incompatible.\n' +
  '\n' +
  '   Tracked for W11.5 — see audit/sections/W11-retro.md §6.\n' +
  '   Workaround: deploy with \x1b[36mnext build\x1b[0m + \x1b[36mvercel\x1b[0m / hosted.\n'
);

/** Returns the loud-block lines as a string for terminal output. */
export function blockMessage(): string {
  return BLOCK_MESSAGE;
}

/**
 * Returns the exit code the supervisor should report when next dev is
 * attempted. 127 ("command not found"-class) chosen so it integrates
 * with shell pipelines that test exit status.
 */
export const BLOCK_EXIT_CODE = 127;
