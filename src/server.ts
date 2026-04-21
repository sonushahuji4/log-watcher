import "dotenv/config";
import express, { Application, Request, Response, NextFunction } from "express";
import { Server, Socket } from "socket.io";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import multer from "multer";
import { LogWatcher } from "./logWatcher";

const app: Application = express();
const port = Number(process.env.PORT) || 3000;
const LOG_FILE = process.env.LOG_FILE || "src/data/logs.txt";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "src/data/uploads";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

// Resolve client.html relative to the source tree so it works whether we run
// via ts-node (__dirname = src/) or compiled (__dirname = dist/).
const HTML_PATH = path.resolve(__dirname, "..", "src", "client.html");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const httpServer = createServer(app);
const io = new Server(httpServer);

const watcher = new LogWatcher(LOG_FILE);
watcher.start();

watcher.on("lines", (newLines: string[]) => {
    io.emit("update", newLines);
});

watcher.on("error", (err: Error) => {
    console.error("Watcher error:", err);
    io.emit("watcher-error", { message: err?.message || "Unknown watcher error" });
});

io.on("connection", async (socket: Socket) => {
    console.log(`Socket connected:    ${socket.id}  (total: ${io.engine.clientsCount})`);

    try {
        const last10 = await watcher.getLastNLines(10);
        socket.emit("init", last10);
    } catch (err) {
        console.error("Failed to read initial lines:", err);
    }

    socket.on("disconnect", (reason) => {
        console.log(`Socket disconnected: ${socket.id}  reason: ${reason}  (total: ${io.engine.clientsCount})`);
    });
});

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, `${Date.now()}-${safeName}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.get("/", (_req: Request, res: Response) => {
    res.redirect("/log");
});

app.get("/log", (_req: Request, res: Response) => {
    res.sendFile(HTML_PATH);
});

app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        socketClients: io.engine.clientsCount,
        watching: watcher.getFilePath(),
        lastSize: watcher.getLastSize(),
    });
});

app.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
    if (!req.file) {
        res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
        return;
    }
    try {
        const newPath = req.file.path;
        await watcher.setFile(newPath);

        const last10 = await watcher.getLastNLines(10);
        io.emit("reset");
        io.emit("init", last10);

        res.json({
            ok: true,
            file: {
                name: req.file.originalname,
                storedAs: path.basename(newPath),
                size: req.file.size,
                watching: watcher.getFilePath(),
            },
        });
    } catch (err: any) {
        res.status(500).json({ error: err?.message || "Upload failed" });
    }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
        res.status(400).json({ error: err.message });
        return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});

httpServer.listen(port, () => {
    console.log(`Server running  → http://localhost:${port}`);
    console.log(`Log viewer      → http://localhost:${port}/log`);
    console.log(`Watching        → ${watcher.getFilePath()}`);
});

const shutdown = async (sig: string) => {
    console.log(`\n${sig} received, shutting down...`);
    try {
        await watcher.stop();
        io.close();
        httpServer.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    } catch (err) {
        console.error("Shutdown error:", err);
        process.exit(1);
    }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
