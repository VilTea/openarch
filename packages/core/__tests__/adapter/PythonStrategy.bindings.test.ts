import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { invocationBindingsPython } from "../../src/adapter/parser/PythonStrategy";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

describe("Python invocation bindings", () => {
  it("resolves import aliases, typed parameters and same-scope field aliases", () => withTemporaryDirectory("python-bindings", async (dir) => {
    const path = join(dir, "worker.py");
    writeFileSync(path, [
      "from app.node.base import AgentContext as Ctx",
      "class Worker:",
      "  async def run(self, context: Ctx):",
      "    self.ctx = context",
      "    await self.ctx.publish(message)",
      "    await context.publish(message)",
    ].join("\n"));

    const bindings = await Effect.runPromise(invocationBindingsPython(path));

    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ receiver: "self.ctx", method: "publish", target: "AgentContext", evidence: "field_assignment" }),
      expect.objectContaining({ receiver: "context", method: "publish", target: "AgentContext", evidence: "import_alias" }),
    ]));
  }));
});
