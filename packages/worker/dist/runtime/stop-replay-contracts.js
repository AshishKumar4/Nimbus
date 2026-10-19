/** What an abort's reason starts with when it is a stop record, before the run's nonce. */
export const STOP_RECORD_PREFIX = 'NIMBUS_STOP ';
/** How many times one process may stop before its read fails instead. */
export const STOP_LIMIT = 64;
/**
 * The most output per stream a run may have printed and still be replayed:
 * the next run is checked against all of it, so the session keeps it.
 */
export const REPLAY_PREFIX_MAX_BYTES = 1024 * 1024;
/** The most clock readings, stdin reads and random bytes a replayable run may draw. */
export const REPLAY_TAPE_MAX_READINGS = 65_536;
export const REPLAY_TAPE_MAX_RANDOM_BYTES = 1024 * 1024;
/** The most answers the session journals for one run; past it the run cannot be replayed. */
export const REPLAY_JOURNAL_MAX_ENTRIES = 65_536;
/** Joined reads keep their actual answers until the run ends, including lost-response resends. */
export const REPLAY_READ_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
/** The most response bytes the session records for one process's runs; past it, unreplayable. */
export const REPLAY_FETCH_MAX_BYTES = 8 * 1024 * 1024;
/**
 * How long a run after a stop may go without asking for the next thing the
 * run before it was answered, while something it asked for waits behind it,
 * before it is taken to have strayed.
 */
export const REPLAY_STALL_MS = 15_000;
/** The longest stop record the session reads; a longer one is not a stop. */
export const STOP_RECORD_MAX_CHARS = 16 * 1024 * 1024;
