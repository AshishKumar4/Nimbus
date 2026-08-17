export class ParallelError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ParallelError';
    }
}
export class SerializationError extends ParallelError {
    constructor(message) {
        super(message);
        this.name = 'SerializationError';
    }
}
export class ExecutionError extends ParallelError {
    remoteMessage;
    remoteStack;
    constructor(message, remoteStack) {
        super(message);
        this.name = 'ExecutionError';
        this.remoteMessage = message;
        this.remoteStack = remoteStack;
    }
}
export class TimeoutError extends ParallelError {
    deadlineMs;
    constructor(deadlineMs) {
        super(`Task exceeded ${deadlineMs}ms deadline`);
        this.name = 'TimeoutError';
        this.deadlineMs = deadlineMs;
    }
}
export class RetryExhaustedError extends ParallelError {
    lastError;
    attempts;
    constructor(attempts, lastError) {
        super(`Task failed after ${attempts} attempt(s): ${lastError.message}`);
        this.name = 'RetryExhaustedError';
        this.attempts = attempts;
        this.lastError = lastError;
    }
}
export class BindingError extends ParallelError {
    constructor(message) {
        super(message);
        this.name = 'BindingError';
    }
}
