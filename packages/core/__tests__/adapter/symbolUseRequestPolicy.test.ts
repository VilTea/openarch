import { describe, expect, it } from "vitest";
import { nonLspProviderLanguages, symbolUseRequestPolicy } from "../../src/adapter/symbol-use/requestPolicy";
import { PROVIDERS } from "../../src/adapter/symbol-use/SymbolUseServiceLive";
import type { SemanticFileProfile } from "../../src/application/semanticDiff";

const profile = (file: string): SemanticFileProfile => ({
  file,
  changes: [],
  beforeState: "git",
});

describe("symbolUseRequestPolicy（能力声明驱动）", () => {
  it("covers typescript/javascript without LSP (compiler provider capability)", () => {
    const nonLsp = new Set(nonLspProviderLanguages());
    expect(nonLsp.has("typescript")).toBe(true);
    expect(nonLsp.has("javascript")).toBe(true);
  });

  it("requests symbol use for non-LSP provider languages even without --semantic", () => {
    expect(symbolUseRequestPolicy([profile("src/a.ts")], { semantic: false })).toBe(true);
    expect(symbolUseRequestPolicy([profile("src/a.js")], { semantic: false })).toBe(true);
  });

  it("does not request for LSP-only languages without --semantic", () => {
    // go 的 provider 是 LSP（gopls）——能力声明不含它
    const nonLsp = new Set(nonLspProviderLanguages());
    const lspOnly = PROVIDERS.filter((p) => p.languages.every((l) => !nonLsp.has(l))).flatMap((p) => p.languages);
    expect(lspOnly.length).toBeGreaterThan(0);
    if (lspOnly.length > 0) {
      // 用 LSP-only 语言的变更文件：无 --semantic 不请求
      const file = lspOnly[0] === "go" ? "src/a.go" : "src/a.java";
      expect(symbolUseRequestPolicy([profile(file)], { semantic: false })).toBe(false);
    }
  });

  it("--semantic always requests", () => {
    expect(symbolUseRequestPolicy([profile("src/a.go")], { semantic: true })).toBe(true);
  });

  it("all providers declare evidenceSource and languages (capability contract)", () => {
    for (const provider of PROVIDERS) {
      expect(provider.evidenceSource).toBeTruthy();
      expect(provider.languages.length).toBeGreaterThan(0);
    }
  });
});
