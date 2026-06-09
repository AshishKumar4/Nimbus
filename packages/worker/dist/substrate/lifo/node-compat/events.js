export class EventEmitter {
    _events = new Map();
    _maxListeners = 10;
    on(event, listener) {
        let list = this._events.get(event);
        if (!list) {
            list = [];
            this._events.set(event, list);
        }
        list.push(listener);
        return this;
    }
    addListener(event, listener) {
        return this.on(event, listener);
    }
    once(event, listener) {
        const wrapped = (...args) => {
            this.removeListener(event, wrapped);
            listener.apply(this, args);
        };
        wrapped._original = listener;
        return this.on(event, wrapped);
    }
    emit(event, ...args) {
        const list = this._events.get(event);
        if (!list || list.length === 0)
            return false;
        const copy = [...list];
        for (const fn of copy) {
            fn.apply(this, args);
        }
        return true;
    }
    removeListener(event, listener) {
        const list = this._events.get(event);
        if (!list)
            return this;
        const idx = list.findIndex((fn) => fn === listener || fn._original === listener);
        if (idx !== -1)
            list.splice(idx, 1);
        if (list.length === 0)
            this._events.delete(event);
        return this;
    }
    off(event, listener) {
        return this.removeListener(event, listener);
    }
    removeAllListeners(event) {
        if (event !== undefined) {
            this._events.delete(event);
        }
        else {
            this._events.clear();
        }
        return this;
    }
    listenerCount(event) {
        return this._events.get(event)?.length ?? 0;
    }
    listeners(event) {
        return [...(this._events.get(event) ?? [])];
    }
    setMaxListeners(n) {
        this._maxListeners = n;
        return this;
    }
    getMaxListeners() {
        return this._maxListeners;
    }
    eventNames() {
        return [...this._events.keys()];
    }
    prependListener(event, listener) {
        let list = this._events.get(event);
        if (!list) {
            list = [];
            this._events.set(event, list);
        }
        list.unshift(listener);
        return this;
    }
}
export default EventEmitter;
