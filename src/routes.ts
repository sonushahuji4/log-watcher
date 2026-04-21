import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import type { Config } from "./config";
import type { LogWatcher } from "./logWatcher";
import type { UploadService } from "./uploadService";

export interface RouteDeps {
    watcher: LogWatcher;
    uploadService: UploadService;
    config: Config;
    getSocketClientCount: () => number;
}

export function createRoutes(deps: RouteDeps): Router {
    const { watcher, uploadService, config, getSocketClientCount } = deps;
    const router = Router();

    // Source-tree path works for both ts-node (__dirname = src/) and compiled
    // (__dirname = dist/) runs without copying the HTML into dist/.
    const HTML_PATH = path.resolve(__dirname, "..", "src", "client.html");

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, config.uploadDir),
        filename: (_req, file, cb) => {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
            cb(null, `${Date.now()}-${safe}`);
        },
    });
    const upload = multer({
        storage,
        limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
    });

    router.get("/", (_req: Request, res: Response) => {
        res.redirect("/log");
    });

    router.get("/log", (_req: Request, res: Response) => {
        res.sendFile(HTML_PATH);
    });

    router.get("/health", (_req: Request, res: Response) => {
        res.json({
            status: "ok",
            socketClients: getSocketClientCount(),
            watching: watcher.getFilePath(),
            lastSize: watcher.getLastSize(),
            state: watcher.getState(),
            tailerStrategy: config.tailerStrategy,
        });
    });

    router.post("/upload", upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.file) {
                res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
                return;
            }
            const result = await uploadService.swap(req.file);
            res.json({ ok: true, file: result });
        } catch (err) {
            next(err);
        }
    });

    return router;
}

export function errorMiddleware(err: any, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof multer.MulterError) {
        res.status(400).json({ error: err.message });
        return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
}
