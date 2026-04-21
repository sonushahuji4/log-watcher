import type { Server } from "socket.io";
import type { LogWatcher } from "./logWatcher";

/**
 * Wires a LogWatcher's domain events to Socket.IO broadcasts and handles
 * per-connection bootstrap. Kept small and side-effect-only — no state.
 */
export function createSocketHub(io: Server, watcher: LogWatcher): void {
    watcher.on("lines", (newLines) => {
        io.emit("update", newLines);
    });

    watcher.on("error", (err) => {
        console.error("Watcher error:", err);
        io.emit("watcher-error", { message: err.message || "Unknown watcher error" });
    });

    io.on("connection", async (socket) => {
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
}
