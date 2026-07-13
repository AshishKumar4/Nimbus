// Nimbus build stub: no PTY subsystem in workerd. opencode's TUI runs over the
// Nimbus attached-TTY substrate instead; any direct node-pty use fails loud.
export function spawn() {
  throw new Error("node-pty is unavailable on Nimbus (no PTY subsystem in workerd)")
}
export default { spawn }
