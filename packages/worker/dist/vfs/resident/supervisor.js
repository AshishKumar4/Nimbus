/**
 * The session calls a process's store makes, as the session declares them
 * (session/supervisor-calls.ts): each optional, as a supervisor may lack one
 * (a test's) and the store then does without it, and each answer awaited
 * whether or not it is a promise. What an answer holds crossed an RPC, so the
 * store reads it field by field.
 */
export {};
