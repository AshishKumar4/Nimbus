// Starts a process of its own (which inherits the realm's pipes), says its
// pid, then never yields. Started with the payload 'escape', the process
// leaves for a session of its own.
import { spawn } from 'node:child_process';
import { joinRealm } from './join.mjs';

const realm = await joinRealm();
const child = realm.payload === 'escape'
  ? spawn('/usr/bin/setsid', ['/usr/bin/sleep', '30'], { stdio: 'ignore' })
  : spawn('/usr/bin/sleep', ['30'], { stdio: 'ignore' });
realm.post({ child: child.pid });
setTimeout(() => { for (;;) { /* never yields */ } }, 50);
