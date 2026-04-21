export type ShutdownHook = () => Promise<void> | void;

/**
 * Registers async cleanup hooks and runs them in reverse order on SIGINT /
 * SIGTERM. A 5-second safety net forces process exit if any hook hangs.
 */
export class ShutdownManager {
    private readonly hooks: Array<{ name: string; hook: ShutdownHook }> = [];
    private shuttingDown: boolean = false;

    register(name: string, hook: ShutdownHook): void {
        this.hooks.push({ name, hook });
    }

    listen(): void {
        const handle = (signal: string) => {
            if (this.shuttingDown) return;
            this.shuttingDown = true;
            console.log(`\n${signal} received, shutting down...`);
            setTimeout(() => {
                console.error("Shutdown timed out after 5s, forcing exit");
                process.exit(1);
            }, 5000).unref();

            this.run()
                .then(() => process.exit(0))
                .catch((err) => {
                    console.error("Shutdown failed:", err);
                    process.exit(1);
                });
        };

        process.on("SIGINT", () => handle("SIGINT"));
        process.on("SIGTERM", () => handle("SIGTERM"));
    }

    async run(): Promise<void> {
        for (const { name, hook } of [...this.hooks].reverse()) {
            try {
                await hook();
            } catch (err) {
                console.error(`Shutdown hook '${name}' failed:`, err);
            }
        }
    }
}
