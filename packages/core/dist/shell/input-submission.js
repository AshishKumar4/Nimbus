/** One client's input batch, including its queued lines and command status. */
export class ShellInputSubmission {
    id;
    publish;
    pending = 1;
    atPrompt = false;
    status = null;
    ended = false;
    constructor(id, publish) {
        this.id = id;
        this.publish = publish;
    }
    retain() {
        this.pending++;
        return () => this.release();
    }
    release() {
        this.pending--;
        if (this.pending === 0 && this.atPrompt)
            this.end(this.status);
    }
    start() {
        this.atPrompt = false;
        this.publish({ type: 'shell-integration', event: 'start', submissionId: this.id });
        return new ShellInputExecution(this);
    }
    finish(status) {
        this.status = status;
        this.publish({ type: 'shell-integration', event: 'finish', submissionId: this.id, exitCode: status });
    }
    inherit(status) { this.status = status; }
    prompt() {
        this.atPrompt = true;
        if (this.pending === 0)
            this.end(this.status);
    }
    end(status) {
        if (this.ended)
            return;
        this.ended = true;
        this.publish({ type: 'shell-integration', event: 'end', submissionId: this.id, exitCode: status });
    }
}
/** A foreground execution finishes its stdin users before its batch's next line. */
export class ShellInputExecution {
    owner;
    status = null;
    inputs = [];
    constructor(owner) {
        this.owner = owner;
    }
    bind(submission) {
        if (submission !== this.owner)
            this.inputs.push({ submission, release: submission.retain() });
    }
    finish(status) {
        this.status = status;
        this.owner?.finish(status);
    }
    prompt() {
        for (const { submission, release } of this.inputs) {
            submission.inherit(this.status);
            submission.prompt();
            release();
        }
    }
}
