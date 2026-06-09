export declare class EventEmitter {
    private _events;
    private _maxListeners;
    on(event: string, listener: (...args: unknown[]) => void): this;
    addListener(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    removeAllListeners(event?: string): this;
    listenerCount(event: string): number;
    listeners(event: string): Array<(...args: unknown[]) => void>;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    eventNames(): string[];
    prependListener(event: string, listener: (...args: unknown[]) => void): this;
}
export default EventEmitter;
//# sourceMappingURL=events.d.ts.map