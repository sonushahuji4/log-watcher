import fs from "fs/promises";
import { createReadStream } from "fs";
import { StringDecoder } from "string_decoder";
import { TypedEventEmitter } from "./typedEmitter";
import type { ITailer } from "./tailer";

export type LogWatcherEvents = {
    lines: [string[]];
    error: [Error];
    swapped: [string];
};

type State = "idle" | "running" | "stopping" | "swapping";

/**
 * Tails a log file and emits new lines as they arrive. Composes an ITailer
 * for change notifications, so the swap between fs.watch and polling is
 * just a different constructor arg.
 *
 * Lifecycle is an explicit state machine:
 *   idle ──start──▶ running
 *   running ──stop──▶ stopping ──▶ idle
 *   running ──setFile──▶ swapping ──▶ running
 * Rejects start() from non-idle and setFile() from non-running so concurrent
 * calls can't tangle lastSize / tailBuffer.
 */
export class LogWatcher extends TypedEventEmitter<LogWatcherEvents> {
    private filePath: string;
    private lastSize: number = 0;
    private tailBuffer: string = "";
    private state: State = "idle";
    private readonly tailer: ITailer;
    private pendingChange: Promise<void> = Promise.resolve();
    private readonly onChangeBound = () => {
        this.pendingChange = this.pendingChange
            .then(() => this.onChange())
            .catch((err) => { this.emit("error", err as Error); });
    };
    private readonly onTailerErrorBound = (err: Error) => { this.emit("error", err); };

    constructor(filePath: string, tailer: ITailer) {
        super();
        this.filePath = filePath;
        this.tailer = tailer;
        this.tailer.on("change", this.onChangeBound);
        this.tailer.on("error", this.onTailerErrorBound);
    }

    getFilePath(): string {
        return this.filePath;
    }

    getLastSize(): number {
        return this.lastSize;
    }

    getState(): State {
        return this.state;
    }

    /** Resolves once any in-flight change handler has finished. Useful in tests. */
    async waitIdle(): Promise<void> {
        await this.pendingChange;
    }

    async start(): Promise<void> {
        if (this.state !== "idle") {
            throw new Error(`Cannot start LogWatcher from state '${this.state}'`);
        }
        try {
            this.lastSize = await this.currentSizeOrZero();
            await this.tailer.start(this.filePath);
            this.state = "running";
        } catch (err) {
            this.state = "idle";
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (this.state === "idle" || this.state === "stopping") return;
        this.state = "stopping";
        try {
            await this.tailer.stop();
        } finally {
            this.state = "idle";
        }
    }

    async setFile(newPath: string): Promise<void> {
        if (this.state !== "running") {
            throw new Error(`Cannot swap file from state '${this.state}'`);
        }
        this.state = "swapping";
        try {
            await this.tailer.stop();
            this.filePath = newPath;
            this.tailBuffer = "";
            this.lastSize = await this.currentSizeOrZero();
            await this.tailer.start(newPath);
            this.state = "running";
            this.emit("swapped", newPath);
        } catch (err) {
            this.state = "idle";
            throw err;
        }
    }

    async getLastNLines(n: number): Promise<string[]> {
        if (n <= 0) return [];
        const CHUNK = 4096;
        let file: Awaited<ReturnType<typeof fs.open>>;
        try {
            file = await fs.open(this.filePath, "r");
        } catch (err: any) {
            if (err?.code === "ENOENT") return [];
            throw err;
        }

        try {
            const { size } = await file.stat();
            if (size === 0) return [];

            let position = size;
            const chunks: Buffer[] = [];
            let newlineCount = 0;

            while (position > 0 && newlineCount <= n) {
                const readSize = Math.min(CHUNK, position);
                position -= readSize;

                const buf = Buffer.alloc(readSize);
                const { bytesRead } = await file.read(buf, 0, readSize, position);
                const slice = buf.subarray(0, bytesRead);

                chunks.unshift(Buffer.from(slice));
                for (const byte of slice) {
                    if (byte === 0x0a) newlineCount++;
                }
            }

            const text = Buffer.concat(chunks).toString("utf8");
            return text.split("\n").filter((l) => l.length > 0).slice(-n);
        } finally {
            await file.close();
        }
    }

    private async onChange(): Promise<void> {
        if (this.state !== "running") return;

        let currentSize: number;
        try {
            ({ size: currentSize } = await fs.stat(this.filePath));
        } catch {
            return;
        }

        if (currentSize < this.lastSize) {
            this.lastSize = 0;
            this.tailBuffer = "";
        }
        if (currentSize === this.lastSize) return;

        const start = this.lastSize;
        const length = currentSize - start;
        this.lastSize = currentSize;

        try {
            await this.readDelta(start, length);
        } catch (err) {
            this.emit("error", err as Error);
        }
    }

    private async readDelta(start: number, length: number): Promise<void> {
        const stream = createReadStream(this.filePath, {
            start,
            end: start + length - 1,
            highWaterMark: 64 * 1024,
        });
        const decoder = new StringDecoder("utf8");
        const newLines: string[] = [];

        for await (const chunk of stream) {
            this.tailBuffer += decoder.write(chunk as Buffer);
            const parts = this.tailBuffer.split("\n");
            this.tailBuffer = parts.pop() ?? "";
            for (const line of parts) {
                if (line.length > 0) newLines.push(line);
            }
        }
        this.tailBuffer += decoder.end();

        if (newLines.length > 0) this.emit("lines", newLines);
    }

    private async currentSizeOrZero(): Promise<number> {
        try {
            const { size } = await fs.stat(this.filePath);
            return size;
        } catch (err: any) {
            if (err?.code === "ENOENT") return 0;
            throw err;
        }
    }
}
