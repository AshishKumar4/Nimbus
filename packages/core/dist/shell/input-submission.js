/** One client's input batch, including its queued lines and command status. */
export class ShellInputSubmission {
    id;
    publish;
    pending = 1;
    atPrompt = false;
    status = null;
    ended = false;
    resolveCompletion = () => { };
    completion;
    constructor(id, publish) {
        this.id = id;
        this.publish = publish;
        this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
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
    bind(owner) {
        if (owner === this)
            return;
        void owner.completion.then((status) => this.end(status));
    }
    start() {
        this.atPrompt = false;
        this.publish({ type: 'shell-integration', event: 'start', submissionId: this.id });
    }
    finish(status) {
        this.status = status;
        this.publish({ type: 'shell-integration', event: 'finish', submissionId: this.id, exitCode: status });
    }
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
        this.resolveCompletion(status);
    }
}
