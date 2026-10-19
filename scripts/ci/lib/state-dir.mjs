import { homedir } from 'node:os';
import { join } from 'node:path';

export const NIMBUS_STATE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'nimbus');
/** Each CI run's own files (run-dir.mjs), deleted when it ends. */
export const RUNS = join(NIMBUS_STATE, 'runs');
