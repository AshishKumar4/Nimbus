// Joins, then never yields: its host is gone before it starts.
import { joinRealm } from './join.mjs';

await joinRealm();
for (;;) { /* never yields */ }
