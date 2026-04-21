import fs from "fs/promises";
import { TypedEventEmitter } from "./typedEmitter";

export type TailerEvents = {
    change: [];
    error: [Error];
};

/**
 * Notifies listeners when a file changes on disk. Pure signal layer — no
 * concept of offsets, lines, or content. LogWatcher composes a Tailer to
 * stay decoupled from the specific kernel notification mechanism.
 */
export interface ITailer {
    start(filePath: string): Promise<void>;
    stop(): Promise<void>;
    on<K extends keyof TailerEvents & string>(event: K, listener: (...args: TailerEvents[K]) => void): this;
    off<K extends keyof TailerEvents & string>(event: K, listener: (...args: TailerEvents[K]) => void): this;
    once<K extends keyof TailerEvents & string>(event: K, listener: (...args: TailerEvents[K]) => void): this;
    removeAllListeners(event?: string): this;
}

/**
 * Uses fs.watch (inotify / FSEvents / ReadDirectoryChangesW under the hood).
 * Low overhead but misses some atomic-save patterns where editors rename
 * the file instead of writing in place.
 */
export class FsWatchTailer extends TypedEventEmitter<TailerEvents> implements ITailer {
    private abortController: AbortController | null = null;
    private loopPromise: Promise<void> | null = null;

    async start(filePath: string): Promise<void> {
        if (this.loopPromise) return;

        try {
            await fs.stat(filePath);
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                await fs.writeFile(filePath, "");
            } else {
                throw err;
            }
        }

        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.loopPromise = this.loop(filePath, signal).catch((err) => {
            if (err?.name !== "AbortError") this.emit("error", err as Error);
        });
    }

    async stop(): Promise<void> {
        this.abortController?.abort();
        this.abortController = null;
        if (this.loopPromise) {
            await this.loopPromise;
            this.loopPromise = null;
        }
    }

    private async loop(filePath: string, signal: AbortSignal): Promise<void> {
        const watcher = fs.watch(filePath, { signal });
        for await (const event of watcher) {
            if (event.eventType === "change") {
                this.emit("change");
            }
        }
    }
}

/**
 * Polls fs.stat on a fixed interval and emits `change` whenever size or mtime
 * moves. Catches atomic-save renames that fs.watch misses, at the cost of
 * a stat syscall per interval.
 */
export class PollingTailer extends TypedEventEmitter<TailerEvents> implements ITailer {
    private timer: NodeJS.Timeout | null = null;
    private lastMtime: number = 0;
    private lastSize: number = 0;

    constructor(private readonly intervalMs: number) {
        super();
    }

    async start(filePath: string): Promise<void> {
        if (this.timer) return;

        try {
            const stat = await fs.stat(filePath);
            this.lastMtime = stat.mtimeMs;
            this.lastSize = stat.size;
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                await fs.writeFile(filePath, "");
                this.lastMtime = 0;
                this.lastSize = 0;
            } else {
                throw err;
            }
        }

        this.timer = setInterval(() => { this.poll(filePath); }, this.intervalMs);
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async poll(filePath: string): Promise<void> {
        try {
            const stat = await fs.stat(filePath);
            if (stat.mtimeMs !== this.lastMtime || stat.size !== this.lastSize) {
                this.lastMtime = stat.mtimeMs;
                this.lastSize = stat.size;
                this.emit("change");
            }
        } catch (err) {
            this.emit("error", err as Error);
        }
    }
}
