import fs from "fs/promises";
import { createReadStream } from "fs";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";

export class LogWatcher extends EventEmitter {

    private filePath: string;
    private lastSize: number = 0;
    private tailBuffer: string = "";
    private abortController: AbortController | null = null;
    private runningPromise: Promise<void> | null = null;

    constructor(filePath: string) {
        super();
        this.filePath = filePath;
    }

    public getFilePath(): string {
        return this.filePath;
    }

    public getLastSize(): number {
        return this.lastSize;
    }

    public getLastNLines = async (n: number): Promise<string[]> => {
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

            // Read backwards in CHUNK-sized slices, accumulating raw bytes at the
            // correct offset. Decode once at the end so multi-byte UTF-8 chars
            // that straddle a chunk boundary aren't corrupted.
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
    };

    public start(): void {
        if (this.runningPromise) return;
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        this.runningPromise = this.watchFile(signal).catch((err) => {
            if (err?.name !== "AbortError") this.emit("error", err);
        });
    }

    public async stop(): Promise<void> {
        this.abortController?.abort();
        this.abortController = null;
        if (this.runningPromise) {
            await this.runningPromise;
            this.runningPromise = null;
        }
    }

    public setFile = async (newPath: string): Promise<void> => {
        await this.stop();
        this.filePath = newPath;
        this.lastSize = 0;
        this.tailBuffer = "";
        this.start();
    };

    private watchFile = async (signal: AbortSignal): Promise<void> => {
        try {
            const { size } = await fs.stat(this.filePath);
            this.lastSize = size;
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                await fs.writeFile(this.filePath, "");
                this.lastSize = 0;
            } else {
                throw err;
            }
        }

        const watcher = fs.watch(this.filePath, { signal });

        for await (const event of watcher) {
            if (event.eventType !== "change") continue;

            let currentSize: number;
            try {
                ({ size: currentSize } = await fs.stat(this.filePath));
            } catch {
                continue;
            }

            // Rotation or truncation: restart from the top of the new file.
            if (currentSize < this.lastSize) {
                this.lastSize = 0;
                this.tailBuffer = "";
            }

            if (currentSize === this.lastSize) continue;

            const start = this.lastSize;
            const length = currentSize - start;
            this.lastSize = currentSize;

            await this.readDelta(start, length);
        }
    };

    private readDelta = async (start: number, length: number): Promise<void> => {
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
    };
}
