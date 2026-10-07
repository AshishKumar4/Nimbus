// Ends its process with the signal its payload names.
import { joinRealm } from './join.mjs';

const realm = await joinRealm();
process.kill(process.pid, realm.payload);
setInterval(() => {}, 1000);
