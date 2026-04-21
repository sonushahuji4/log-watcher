import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
    test("applies defaults when env is empty", () => {
        const cfg = loadConfig({});
        assert.equal(cfg.port, 3000);
        assert.equal(cfg.logFile, "src/data/logs.txt");
        assert.equal(cfg.uploadDir, "src/data/uploads");
        assert.equal(cfg.maxUploadMB, 50);
        assert.equal(cfg.tailerStrategy, "watch");
        assert.equal(cfg.pollIntervalMs, 500);
    });

    test("reads env overrides", () => {
        const cfg = loadConfig({
            PORT: "4000",
            LOG_FILE: "/var/log/app.log",
            UPLOAD_DIR: "/tmp/uploads",
            MAX_UPLOAD_MB: "200",
            TAILER_STRATEGY: "poll",
            POLL_INTERVAL_MS: "1000",
        });
        assert.equal(cfg.port, 4000);
        assert.equal(cfg.logFile, "/var/log/app.log");
        assert.equal(cfg.uploadDir, "/tmp/uploads");
        assert.equal(cfg.maxUploadMB, 200);
        assert.equal(cfg.tailerStrategy, "poll");
        assert.equal(cfg.pollIntervalMs, 1000);
    });

    test("rejects non-numeric PORT", () => {
        assert.throws(() => loadConfig({ PORT: "abc" }), /Invalid PORT/);
    });

    test("rejects out-of-range PORT", () => {
        assert.throws(() => loadConfig({ PORT: "70000" }), /Invalid PORT/);
    });

    test("ignores unknown TAILER_STRATEGY (falls back to watch)", () => {
        const cfg = loadConfig({ TAILER_STRATEGY: "nonsense" });
        assert.equal(cfg.tailerStrategy, "watch");
    });

    test("returned config is frozen", () => {
        const cfg = loadConfig({});
        assert.throws(() => {
            (cfg as any).port = 9999;
        });
    });
});
