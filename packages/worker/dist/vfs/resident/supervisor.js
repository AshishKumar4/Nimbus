/**
 * The session calls a process's store makes (session/supervisor-calls.ts),
 * as the store asks them: each may be missing from a supervisor (an older
 * one, a test's), and the store then does without it. Answers are read
 * defensively, field by field, as an answer over RPC may be anything.
 */
export {};
