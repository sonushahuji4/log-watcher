import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { LogWatcher } from "./logWatcher";
import { FsWatchTailer, PollingTailer, type ITailer } from "./tailer";
import { createSocketHub } from "./socketHub";
import { UploadService } from "./uploadService";
import { createRoutes, errorMiddleware } from "./routes";
import { ShutdownManager } from "./shutdownManager";

async function bootstrap(): Promise<void> {
    const config = loadConfig();

    fs.mkdirSync(config.uploadDir, { recursive: true });
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });

    const tailer: ITailer = config.tailerStrategy === "poll"
        ? new PollingTailer(config.pollIntervalMs)
        : new FsWatchTailer();

    const watcher = new LogWatcher(config.logFile, tailer);
    await watcher.start();

    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);

    createSocketHub(io, watcher);

    const uploadService = new UploadService(watcher, io);
    app.use(createRoutes({
        watcher,
        uploadService,
        config,
        getSocketClientCount: () => io.engine.clientsCount,
    }));
    app.use(errorMiddleware);

    httpServer.listen(config.port, () => {
        console.log(`Server running  → http://localhost:${config.port}`);
        console.log(`Log viewer      → http://localhost:${config.port}/log`);
        console.log(`Watching        → ${watcher.getFilePath()} (${config.tailerStrategy})`);
    });

    const shutdown = new ShutdownManager();
    shutdown.register("watcher", () => watcher.stop());
    shutdown.register("socket.io", () => { io.close(); });
    shutdown.register("http", () => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    shutdown.listen();
}

bootstrap().catch((err) => {
    console.error("Bootstrap failed:", err);
    process.exit(1);
});
