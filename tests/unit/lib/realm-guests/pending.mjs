// A call whose answer waits for a later call of its own: the host answers
// 'pending' only once it has served 'release'.
import { joinRealm } from './join.mjs';

const realm = await joinRealm();
const pending = realm.callAsync('pending');
const released = await realm.callAsync('release');
realm.post({ released, pending: await pending });
