// Runs inside the case's PID namespace. Preserve wait status independently
// of bubblewrap, which maps both SIGTERM and a normal exit143 to 143.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [statusFile, command, ...args] = process.argv.slice(2);
let recorded = false;
function record(code, signal, error = '') {
  if (recorded) return;
  recorded = true;
  writeFileSync(statusFile, JSON.stringify({ code, signal, error }));
  // bubblewrap's PID1 reaper tears down any detached descendants afterward.
  process.exit(code ?? 1);
}
const child = spawn(command, args, { stdio: 'inherit' });
child.once('error', (error) => record(null, null, error.message));
child.once('exit', (code, signal) => record(code, signal));
