export class ParallelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParallelError';
  }
}

export class SerializationError extends ParallelError {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

export class ExecutionError extends ParallelError {
  readonly remoteMessage: string;
  readonly remoteStack?: string;

  constructor(message: string, remoteStack?: string) {
    super(message);
    this.name = 'ExecutionError';
    this.remoteMessage = message;
    this.remoteStack = remoteStack;
  }
}

export class TimeoutError extends ParallelError {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`Task exceeded ${deadlineMs}ms deadline`);
    this.name = 'TimeoutError';
    this.deadlineMs = deadlineMs;
  }
}

export class RetryExhaustedError extends ParallelError {
  readonly lastError: Error;
  readonly attempts: number;

  constructor(attempts: number, lastError: Error) {
    super(
      `Task failed after ${attempts} attempt(s): ${lastError.message}`,
    );
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class BindingError extends ParallelError {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}
