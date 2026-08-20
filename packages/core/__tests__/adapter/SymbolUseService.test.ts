import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { Language } from "../../src/domain/ast";
import { SemanticToolchainDiscovery } from "../../src/port/SemanticToolchainDiscovery";
import { SymbolUseService } from "../../src/port/SymbolUseService";
import { SymbolUseServiceLive } from "../../src/adapter/symbol-use/SymbolUseServiceLive";

const collect = (cwd: string, languages: readonly Language[]) =>
  Effect.gen(function* () {
    const service = yield* SymbolUseService;
    return yield* service.collect({ cwd, languages });
  });

describe("SymbolUseServiceLive", () => {
  it("reports a registered language as unavailable when its external provider prerequisite is absent", async () => {
    // Deterministic mock: pyright is available so the provider is selected, and
    // the missing ParserService path becomes observable on every platform.
    const pyrightAvailable = Layer.succeed(SemanticToolchainDiscovery, {
      discover: () => Effect.succeed([{
        language: "python" as const,
        availability: "available" as const,
        tools: [{ id: "pyright", kind: "lsp" as const, availability: "available" as const }],
      }]),
    });
    const reports = await Effect.runPromise(collect(process.cwd(), ["python"]).pipe(Effect.provide(SymbolUseServiceLive), Effect.provide(pyrightAvailable)));
    expect(reports).toEqual([expect.objectContaining({
      origin: expect.objectContaining({ language: "python", providerId: "python-pyright-symbol-use" }),
      state: expect.objectContaining({ availability: "unavailable", reason: expect.stringContaining("ParserService is required"), coverage: { declarations: "unavailable", repositoryReferences: "unavailable" } }),
    })]);
  });

  it("does not run a provider when its declared toolchain prerequisite is unavailable", async () => {
    const discovery = Layer.succeed(SemanticToolchainDiscovery, {
      discover: () => Effect.succeed([{
        language: "typescript" as const,
        availability: "unavailable" as const,
        tools: [{ id: "typescript-compiler", kind: "compiler" as const, availability: "unavailable" as const, reason: "not resolvable" }],
      }]),
    });
    const reports = await Effect.runPromise(collect(process.cwd(), ["typescript"]).pipe(Effect.provide(SymbolUseServiceLive), Effect.provide(discovery)));

    expect(reports).toEqual([expect.objectContaining({
      origin: expect.objectContaining({ language: "typescript" }),
      state: expect.objectContaining({ availability: "unavailable", reason: expect.stringContaining("typescript-symbol-use prerequisites unavailable: typescript-compiler") }),
    })]);
  });
});
