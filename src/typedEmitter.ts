import { EventEmitter } from "events";

export type EventMap = Record<string, any[]>;

export class TypedEventEmitter<T extends EventMap> extends EventEmitter {
    override on<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    override off<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }

    override once<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
        return super.once(event, listener as (...args: unknown[]) => void);
    }

    override emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean {
        return super.emit(event, ...args);
    }
}
