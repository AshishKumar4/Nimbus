export function normalizeTerminalNewlines(text) {
    return text.replace(/\r?\n/g, '\r\n');
}
