import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LogWatcher } from "../src/logWatcher";
import { TypedEventEmitter } from "../src/typedEmitter";
import type { ITailer, TailerEvents } from "../src/tailer";

/**
 * Manually-driven Tailer — lets tests trigger `change` events synchronously
 * instead of waiting on the real filesystem watcher.
 */
class MockTailer extends TypedEventEmitter<TailerEvents> implements ITailer {
    started: boolean = false;
    startedPath: string | null = null;
    async start(filePath: string): Promise<void> {
        this.started = true;
        this.startedPath = filePath;
    }
    async stop(): Promise<void> {
        this.started = false;
    }
    fire(): void {
        this.emit("change");
    }
    failWith(err: Error): void {
        this.emit("error", err);
    }
}

function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lw-test-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("LogWatcher.getLastNLines", () => {
    test("returns [] for missing file", async () => {
        const w = new LogWatcher(join(dir, "missing.log"), new MockTailer());
        assert.deepEqual(await w.getLastNLines(10), []);
    });

    test("returns [] for empty file", async () => {
        const f = join(dir, "a.log");
        writeFileSync(f, "");
        const w = new LogWatcher(f, new MockTailer());
        assert.deepEqual(await w.getLastNLines(10), []);
    });

    test("returns all lines when file has fewer than n", async () => {
        const f = join(dir, "a.log");
        writeFileSync(f, "a\nb\nc\n");
        const w = new LogWatcher(f, new MockTailer());
        assert.deepEqual(await w.getLastNLines(10), ["a", "b", "c"]);
    });

    test("returns last n lines when file has more", async () => {
        const f = join(dir, "a.log");
        writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n") + "\n");
        const w = new LogWatcher(f, new MockTailer());
        assert.deepEqual(await w.getLastNLines(3), ["line47", "line48", "line49"]);
    });

    test("preserves multi-byte UTF-8 characters across chunk boundaries", async () => {
        const f = join(dir, "utf8.log");
        // Force a multi-byte char (🔥 = 4 bytes) to straddle the 4096-byte chunk boundary.
        const padding = "x".repeat(4094);
        writeFileSync(f, `${padding}🔥tail-of-emoji-line\nfinal line\n`);
        const w = new LogWatcher(f, new MockTailer());
        const lines = await w.getLastNLines(2);
        assert.equal(lines.length, 2);
        assert.ok(lines[0]!.includes("🔥"), "emoji should survive chunk boundary");
        assert.equal(lines[1], "final line");
    });
});

describe("LogWatcher partial-line buffering", () => {
    test("does not emit a line until a newline arrives", async () => {
        const f = join(dir, "p.log");
        writeFileSync(f, "");

        const tailer = new MockTailer();
        const w = new LogWatcher(f, tailer);
        await w.start();

        const emitted: string[][] = [];
        w.on("lines", (ls) => emitted.push(ls));

        appendFileSync(f, "foo");
        tailer.fire();
        await w.waitIdle();
        assert.equal(emitted.length, 0, "no emit without newline");

        appendFileSync(f, "bar\n");
        tailer.fire();
        await w.waitIdle();

        assert.deepEqual(emitted, [["foobar"]], "partial 'foo' should join 'bar' into one line");

        await w.stop();
    });

    test("emits multiple complete lines in one change", async () => {
        const f = join(dir, "m.log");
        writeFileSync(f, "");

        const tailer = new MockTailer();
        const w = new LogWatcher(f, tailer);
        await w.start();

        const emitted: string[][] = [];
        w.on("lines", (ls) => emitted.push(ls));

        appendFileSync(f, "one\ntwo\nthree\n");
        tailer.fire();
        await w.waitIdle();

        assert.deepEqual(emitted, [["one", "two", "three"]]);
        await w.stop();
    });
});

describe("LogWatcher rotation / truncation", () => {
    test("resets lastSize when the file shrinks", async () => {
        const f = join(dir, "r.log");
        writeFileSync(f, "old-line-1\nold-line-2\n");

        const tailer = new MockTailer();
        const w = new LogWatcher(f, tailer);
        await w.start();

        const emitted: string[][] = [];
        w.on("lines", (ls) => emitted.push(ls));

        // File shrinks (simulating log rotation) and then grows.
        truncateSync(f, 0);
        appendFileSync(f, "rotated\n");
        tailer.fire();
        await w.waitIdle();

        assert.deepEqual(emitted, [["rotated"]], "should read the new file from offset 0");
        await w.stop();
    });
});

describe("LogWatcher lifecycle state machine", () => {
    test("start from idle moves to running", async () => {
        const f = join(dir, "s.log");
        writeFileSync(f, "");
        const w = new LogWatcher(f, new MockTailer());
        assert.equal(w.getState(), "idle");
        await w.start();
        assert.equal(w.getState(), "running");
        await w.stop();
    });

    test("rejects double-start", async () => {
        const f = join(dir, "s.log");
        writeFileSync(f, "");
        const w = new LogWatcher(f, new MockTailer());
        await w.start();
        await assert.rejects(() => w.start(), /from state 'running'/);
        await w.stop();
    });

    test("stop is idempotent", async () => {
        const f = join(dir, "s.log");
        writeFileSync(f, "");
        const w = new LogWatcher(f, new MockTailer());
        await w.start();
        await w.stop();
        await w.stop();
        assert.equal(w.getState(), "idle");
    });

    test("setFile rejects from idle", async () => {
        const f = join(dir, "s.log");
        writeFileSync(f, "");
        const w = new LogWatcher(f, new MockTailer());
        await assert.rejects(() => w.setFile(f), /from state 'idle'/);
    });

    test("setFile swaps to new file and emits 'swapped'", async () => {
        const f1 = join(dir, "a.log");
        const f2 = join(dir, "b.log");
        writeFileSync(f1, "old\n");
        writeFileSync(f2, "new\n");

        const tailer = new MockTailer();
        const w = new LogWatcher(f1, tailer);
        await w.start();

        const swapped: string[] = [];
        w.on("swapped", (p) => swapped.push(p));

        await w.setFile(f2);

        assert.equal(w.getFilePath(), f2);
        assert.equal(w.getState(), "running");
        assert.deepEqual(swapped, [f2]);
        assert.equal(tailer.startedPath, f2);
        await w.stop();
    });
});

describe("LogWatcher error propagation", () => {
    test("forwards tailer errors on its own error event", async () => {
        const f = join(dir, "e.log");
        writeFileSync(f, "");

        const tailer = new MockTailer();
        const w = new LogWatcher(f, tailer);
        await w.start();

        const errors: Error[] = [];
        w.on("error", (e) => errors.push(e));

        tailer.failWith(new Error("boom"));
        await w.waitIdle();

        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.message, "boom");
        await w.stop();
    });
});
