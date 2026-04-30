/**
 * WebSocket-backed terminal matching Nimbus's ITerminal interface.
 * HeadlessTerminal has: write, writeln, onData, sendData, cols, rows, focus, clear
 */
export class WebSocketTerminal {
  public readonly ws: WebSocket;
  private dataCallback: ((data: string) => void) | null = null;
  private _cols: number = 80;
  private _rows: number = 24;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ws: WebSocket) { this.ws = ws; }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  write(data: string): void {
    this.buffer.push(data);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 5);
    }
  }

  writeln(data: string): void { this.write(data + '\r\n'); }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const combined = this.buffer.join('');
    this.buffer = [];
    try { this.ws.send(JSON.stringify({ type: 'output', data: combined })); } catch {}
  }

  onData(callback: (data: string) => void): void { this.dataCallback = callback; }

  handleMessage(msg: { type: string; data?: string; cols?: number; rows?: number }): void {
    switch (msg.type) {
      case 'input':
        if (msg.data) this.sendData(msg.data);
        break;
      case 'resize':
        if (msg.cols) this._cols = msg.cols;
        if (msg.rows) this._rows = msg.rows;
        break;
    }
  }

  sendData(data: string): void {
    if (this.dataCallback) this.dataCallback(data);
  }

  focus(): void {}
  clear(): void { this.write('\x1b[2J\x1b[H'); }
}
