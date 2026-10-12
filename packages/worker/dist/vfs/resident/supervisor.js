/**
 * The session calls a process's store makes, as the session declares them:
 * the filesystem's (core runtime/filesystem-methods.ts) and the session's own
 * reads (session/supervisor-calls.ts). Each is optional, as a supervisor may
 * lack one (a test's) and the store then does without it, and each answer is
 * awaited whether or not it is a promise. What an answer holds crossed an
 * RPC, so the store reads it field by field.
 */
export {};
