// Typed fixtures for the loom suites: a real subclass, decorator syntax and
// all, compiled by bun exactly as an embedder would write it.

import { Actor } from '../../../packages/loom/src/actor.ts';
import { callable } from '../../../packages/loom/src/callable.ts';
import type { StreamingResponse } from '../../../packages/loom/src/rpc.ts';
import type { ScheduleInvocation } from '../../../packages/loom/src/schedules.ts';

export interface CounterState {
  count: number;
}

export class FixtureActor extends Actor<Cloudflare.Env, CounterState> {
  static options = { hibernate: true };

  events: string[] = [];
  lastInvocation: ScheduleInvocation | undefined;
  initialState: CounterState = { count: 0 };

  override onStart(): void {
    this.events.push('onStart');
  }

  @callable()
  greet(name: string): string {
    return `hello ${name}`;
  }

  @callable({ streaming: true, description: 'counts to n' })
  async countTo(stream: StreamingResponse, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) stream.send(i);
    stream.end('done');
  }

  hidden(): string {
    return 'not for the wire';
  }

  remind(payload: unknown, invocation: ScheduleInvocation): void {
    this.events.push(`remind:${JSON.stringify(payload) ?? 'undefined'}`);
    this.lastInvocation = invocation;
  }
}
