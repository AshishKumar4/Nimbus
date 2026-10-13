import { z } from 'zod/v4';
import { Connections, connections, type ConnectionSocket, type ConnectionsContext } from '../src/connections.js';

const schema = z.object({ device: z.string() });

export function sendToDevice(ctx: DurableObjectState, key: string, frame: string): void {
  const hub = connections(ctx, schema);
  const socket: WebSocket | null = hub.get(key);
  socket?.send(frame);
  const sockets: WebSocket[] = hub.list(key);
  for (const live of sockets) live.send(frame);
}

export function typedHost(ctx: ConnectionsContext<WebSocket>): Connections<{ device: string }, WebSocket> {
  return new Connections(ctx, schema);
}

export function minimalHost(ctx: ConnectionsContext): Connections<{ device: string }> {
  const hub = connections(ctx, schema);
  const socket: ConnectionSocket | null = hub.get('device');
  socket?.close();
  return hub;
}
