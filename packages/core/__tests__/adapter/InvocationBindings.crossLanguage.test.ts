import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { invocationBindingsTs } from "../../src/adapter/parser/TsStrategy";
import { invocationBindingsGo } from "../../src/adapter/parser/GoStrategy";
import { invocationBindingsRust } from "../../src/adapter/parser/RustStrategy";
import { invocationBindingsJava } from "../../src/adapter/parser/JavaStrategy";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

describe("cross-language invocation bindings", () => {
  it("keeps the same parameter binding contract", () => withTemporaryDirectory("binding-contract", async (dir) => {
    const fixtures = [
      { name: "worker.ts", source: "function run(bus: EventBus) { bus.publish(value); }", provider: invocationBindingsTs },
      { name: "worker.go", source: "package worker\nfunc Run(bus EventBus) { bus.Publish(value) }", provider: invocationBindingsGo },
      { name: "worker.rs", source: "fn run(bus: EventBus) { bus.publish(value); }", provider: invocationBindingsRust },
      { name: "Worker.java", source: "class Worker { void run(EventBus bus) { bus.publish(value); } }", provider: invocationBindingsJava },
    ];
    for (const fixture of fixtures) {
      const path = join(dir, fixture.name);
      writeFileSync(path, fixture.source);
      const bindings = await Effect.runPromise(fixture.provider(path));
      expect(bindings).toEqual(expect.arrayContaining([expect.objectContaining({ target: "EventBus" })]));
    }
  }));
});
