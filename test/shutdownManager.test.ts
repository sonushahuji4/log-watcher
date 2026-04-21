import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ShutdownManager } from "../src/shutdownManager";

describe("ShutdownManager", () => {
    test("runs hooks in reverse registration order", async () => {
        const m = new ShutdownManager();
        const order: string[] = [];
        m.register("a", () => { order.push("a"); });
        m.register("b", () => { order.push("b"); });
        m.register("c", () => { order.push("c"); });
        await m.run();
        assert.deepEqual(order, ["c", "b", "a"]);
    });

    test("continues after a hook throws and logs the failure", async () => {
        const m = new ShutdownManager();
        const order: string[] = [];
        m.register("good1", () => { order.push("good1"); });
        m.register("bad", () => { throw new Error("nope"); });
        m.register("good2", () => { order.push("good2"); });
        await m.run();
        assert.deepEqual(order, ["good2", "good1"]);
    });

    test("awaits async hooks", async () => {
        const m = new ShutdownManager();
        const order: string[] = [];
        m.register("a", async () => {
            await new Promise((r) => setTimeout(r, 10));
            order.push("a-done");
        });
        m.register("b", () => { order.push("b-done"); });
        await m.run();
        assert.deepEqual(order, ["b-done", "a-done"]);
    });
});
