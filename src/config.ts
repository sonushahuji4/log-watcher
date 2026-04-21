import "dotenv/config";

export type TailerStrategy = "watch" | "poll";

export interface Config {
    readonly port: number;
    readonly logFile: string;
    readonly uploadDir: string;
    readonly maxUploadMB: number;
    readonly tailerStrategy: TailerStrategy;
    readonly pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const cfg: Config = {
        port: parseInt(env, "PORT", 3000, { min: 1, max: 65535 }),
        logFile: env.LOG_FILE || "src/data/logs.txt",
        uploadDir: env.UPLOAD_DIR || "src/data/uploads",
        maxUploadMB: parseInt(env, "MAX_UPLOAD_MB", 50, { min: 1 }),
        tailerStrategy: env.TAILER_STRATEGY === "poll" ? "poll" : "watch",
        pollIntervalMs: parseInt(env, "POLL_INTERVAL_MS", 500, { min: 50 }),
    };
    return Object.freeze(cfg);
}

function parseInt(
    env: NodeJS.ProcessEnv,
    name: string,
    dflt: number,
    bounds: { min?: number; max?: number } = {},
): number {
    const raw = env[name];
    if (!raw) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`Invalid ${name}: ${raw} (expected integer)`);
    }
    if (bounds.min !== undefined && n < bounds.min) {
        throw new Error(`Invalid ${name}: ${n} (min ${bounds.min})`);
    }
    if (bounds.max !== undefined && n > bounds.max) {
        throw new Error(`Invalid ${name}: ${n} (max ${bounds.max})`);
    }
    return n;
}
