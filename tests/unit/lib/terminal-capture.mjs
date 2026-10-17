export async function bounded(promise, label, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function captureTerminal(Terminal, { shown = (text) => text, timeoutMs = 2000 } = {}) {
  const chunks = [];
  const listeners = new Set();
  const terminal = new Terminal(null, (text) => {
    chunks.push(text);
    for (const listener of listeners) listener();
  });
  const text = () => { terminal.flushNow(); return shown(chunks.join('')); };
  return {
    terminal,
    text,
    reset() { terminal.flushNow(); chunks.length = 0; },
    async seen(expected, label = 'terminal output') {
      const matches = typeof expected === 'string' ? (value) => value.includes(expected) : expected;
      if (matches(text())) return;
      let listener;
      try {
        await bounded(new Promise((resolve) => {
          listener = () => { if (matches(text())) resolve(); };
          listeners.add(listener);
        }), `missing ${label}`, timeoutMs);
      } finally { listeners.delete(listener); }
    },
  };
}
