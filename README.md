# Log Watcher

A real-time log-tailing server with a browser viewer. The server watches a log file, streams new lines to every connected client over Socket.IO, and lets you upload a different file from the UI to hot-swap what it's tailing — no restart needed.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue) ![Express](https://img.shields.io/badge/Express-5.x-lightgrey) ![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-orange)

---

## What it does

- **Tails a log file** (`src/data/logs.txt` by default) and pushes appended lines to all connected clients in real time.
- **Bootstraps** each new client with the **last 10 lines** so the view is never empty on first load.
- **Supports multiple concurrent clients** — new lines are broadcast to everyone, the initial 10-line backfill is sent only to the socket that just connected.
- **Hot-swap uploads**: drop a different file in via the UI and the server immediately starts tailing that one. All connected clients reset and start following the new file.
- **Robust to common log-file quirks**: file rotation / truncation, multi-byte UTF-8 that straddles read boundaries, and writes that land mid-line without a trailing newline.

## Quick start

Requires **Node.js 18+**.

```bash
git clone https://github.com/sonushahuji4/log-watcher.git
cd log-watcher
npm install
npm run dev
```

Open **<http://localhost:3000/log>** in your browser. You'll see the viewer with the last 10 lines of `src/data/logs.txt`.

To see live streaming, append to the file from another terminal:

```bash
echo "hello from the terminal" >> src/data/logs.txt
```

The line should appear in the browser within a fraction of a second.

### Production build

```bash
npm run build   # compiles TS → dist/
npm start       # also runs the build, then node dist/server.js
```

> Run `npm start` from the **repo root** — the server resolves `src/client.html` and `src/data/logs.txt` relative to the current working directory.

## Uploading a file from the browser

The viewer has an **⬆ Watch this file** button in the header. Pick any text/log file and submit — the server:

1. Saves it under `src/data/uploads/<timestamp>-<sanitized-name>`
2. Stops the current watcher, points it at the new file, and restarts it
3. Broadcasts a `reset` event to every connected client so each viewer clears its buffer
4. Broadcasts a fresh `init` with the last 10 lines of the new file

From then on, appends to the uploaded file stream to all clients just like the original.

You can also hit the endpoint directly with `curl`:

```bash
curl -F "file=@./my.log" http://localhost:3000/upload
```

Max upload size defaults to **50 MB**; override with `MAX_UPLOAD_MB`.

## Environment variables

Copy or create a `.env` file in the repo root. All variables are optional.

| Variable        | Default                 | Description                                         |
| --------------- | ----------------------- | --------------------------------------------------- |
| `PORT`          | `3000`                  | HTTP port for the server.                           |
| `LOG_FILE`      | `src/data/logs.txt`     | Initial file to tail. Created if it doesn't exist.  |
| `UPLOAD_DIR`    | `src/data/uploads`      | Where uploaded files are persisted.                 |
| `MAX_UPLOAD_MB` | `50`                    | Upload size limit in megabytes.                     |

## HTTP endpoints

| Method | Path       | Description                                                    |
| ------ | ---------- | -------------------------------------------------------------- |
| GET    | `/`        | 302 redirect to `/log`.                                        |
| GET    | `/log`     | The browser viewer (HTML + Socket.IO client).                  |
| GET    | `/health`  | JSON: `{ status, socketClients, watching, lastSize }`.         |
| POST   | `/upload`  | `multipart/form-data`, field name `file`. Swaps watched file. |

## Socket.IO events

| Event            | Direction        | Payload         | Delivery   | Notes                                                          |
| ---------------- | ---------------- | --------------- | ---------- | -------------------------------------------------------------- |
| `init`           | server → client  | `string[]`      | targeted   | Last 10 lines; sent on connect and after an upload.            |
| `update`         | server → client  | `string[]`      | broadcast  | New lines appended to the watched file.                        |
| `reset`          | server → client  | `—`             | broadcast  | Sent after a file swap; clients clear their log view.          |
| `watcher-error` | server → client  | `{ message }`   | broadcast  | Surfaced when the underlying file watcher errors.              |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         server.ts                           │
│                                                             │
│   Express 5 ──┬── GET /log          → sendFile(client.html) │
│               ├── GET /health       → JSON status           │
│               ├── POST /upload      → multer → setFile()    │
│               └── GET /             → redirect /log         │
│                                                             │
│   Socket.IO ──┬── on 'connection'   → emit 'init' (last 10) │
│               └── on LogWatcher     → emit 'update' (new)   │
│                    'lines' event                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   LogWatcher (EventEmitter)                 │
│                                                             │
│   start()    → fs.watch(filePath) → reads [lastSize, size)  │
│                splits on '\n', emits 'lines'                │
│   stop()     → aborts the watcher cleanly                   │
│   setFile()  → stop, reset, restart on a new path           │
│                                                             │
│   getLastNLines(n) → reverse-chunk read of the file tail    │
└─────────────────────────────────────────────────────────────┘
```

### Key correctness details

- **Partial-line buffering.** Each delta read keeps whatever text follows the last `\n` in a `tailBuffer` that's prepended to the next read — so a write that lands mid-line never gets flushed as two fragmented lines.
- **Rotation / truncation.** If the file's current size is smaller than `lastSize`, the watcher resets `lastSize = 0` and starts reading the rotated file from the top.
- **UTF-8 safety.** `getLastNLines` accumulates raw bytes at their original offset and decodes once at the end, so multi-byte characters straddling a chunk boundary are never corrupted. The live-tail path uses `StringDecoder` across stream chunks for the same reason.
- **Bounded memory.** Live deltas are read through `fs.createReadStream` with a 64 KB high-water mark instead of `Buffer.alloc(length)`, so a single huge append won't balloon the process.
- **Graceful shutdown.** `SIGINT` / `SIGTERM` stop the watcher, close Socket.IO, and close the HTTP server before exit.

## Project layout

```
src/
├── server.ts        # Express + Socket.IO wiring, routes, shutdown
├── logWatcher.ts    # File watcher (EventEmitter): start/stop/setFile/tail
├── client.html      # Single-page viewer served at /log
└── data/
    ├── logs.txt     # Default tailed file (checked in with sample lines)
    └── uploads/     # Uploaded files land here (gitignored)
```

## Scripts

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | `nodemon src/server.ts` — reload on file change.      |
| `npm run build`   | `tsc` — emits to `dist/`.                             |
| `npm start`       | `tsc && node dist/server.js` — production entrypoint. |

## Known limitations

- **Single global watcher.** Every connected client sees whatever file was most recently selected. The upload feature is designed for a personal tool; it's not multi-tenant.
- **No authentication.** Anyone with network access to the port can view logs and upload files. Put it behind something if you expose it.
- **`fs.watch`-based.** A few editors save atomically (write-to-temp then rename) and emit a `rename` event the watcher filters out. For those workflows, swap in `chokidar`.

## License

ISC
