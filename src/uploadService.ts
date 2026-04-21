import path from "path";
import type { Server } from "socket.io";
import type { LogWatcher } from "./logWatcher";

export interface UploadResult {
    name: string;
    storedAs: string;
    size: number;
    watching: string;
}

/**
 * Domain service: takes an already-persisted uploaded file and swaps the
 * LogWatcher to point at it, then broadcasts reset+init so every connected
 * client snaps to the new file.
 *
 * The HTTP controller stays thin — parse, call swap(), render.
 */
export class UploadService {
    constructor(private readonly watcher: LogWatcher, private readonly io: Server) {}

    async swap(file: Express.Multer.File): Promise<UploadResult> {
        await this.watcher.setFile(file.path);

        const last10 = await this.watcher.getLastNLines(10);
        this.io.emit("reset");
        this.io.emit("init", last10);

        return {
            name: file.originalname,
            storedAs: path.basename(file.path),
            size: file.size,
            watching: this.watcher.getFilePath(),
        };
    }
}
