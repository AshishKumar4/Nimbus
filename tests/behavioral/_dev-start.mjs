// One command launch and terminal-ownership boundary. Callers choose their
// readiness policy; real-framework proofs add sustained accepted requests.
import { BASE, stripAnsi } from './_driver.mjs';

export const LONG_RUNNING = /\[(?:bin|facet) started \(long-running\): pid=(\d+)/;
export const frameworkProxyHost = new URL(BASE).hostname;

export async function startDevCommand({ terminal, cwd, command, ready = text => LONG_RUNNING.test(text), budgetMs = 180_000 }) {
  terminal.reset();
  terminal.cmd(`cd ${cwd} && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${frameworkProxyHost} ${command}`);
  const submission = terminal.submission;
  let reached = false;
  try {
    await terminal.waitFor(text => ready(text) || submission.end !== null, budgetMs, 'dev startup or command completion');
    reached = ready(terminal.buf);
  } catch { /* the caller owns whether an unready launch is an assertion */ }
  const output = stripAnsi(terminal.buf);
  return { output, ready: reached, pid: Number(output.match(LONG_RUNNING)?.[1] || 0) };
}
