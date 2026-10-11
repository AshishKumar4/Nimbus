import { homedir } from 'node:os';
import { join } from 'node:path';

export const NIMBUS_STATE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'nimbus');
export const PUBLISH_ARTIFACTS = process.env.NIMBUS_PUBLISH_ARTIFACTS ?? join(NIMBUS_STATE, 'publish');
