// Announces a frame of 4 GiB on the host's pipe, then trickles bytes.
import { writeSync } from 'node:fs';

writeSync(5, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
const piece = new Uint8Array(64 * 1024);
setInterval(() => { try { writeSync(5, piece); } catch { process.exit(0); } }, 5);
