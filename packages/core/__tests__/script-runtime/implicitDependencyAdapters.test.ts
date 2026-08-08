import { describe, expect, it } from "vitest";
import { IMPLICIT_DEPENDENCY_ADAPTERS, implicitDependencyAdapterFor } from "../../src/script-runtime/implicitDependencyAdapters";

describe("implicit dependency language adapters (multi-language entry)", () => {
  it("covers all governed languages with container queries and dynamic reference patterns", () => {
    const languages = ["typescript", "javascript", "java", "python", "go", "rust"];
    for (const language of languages) {
      const adapter = implicitDependencyAdapterFor(language);
      expect(adapter, `adapter for ${language}`).toBeDefined();
      expect(adapter!.containerQuery, `${language} container query`).toBeTruthy();
      expect(adapter!.dynamicReferencePatterns?.length, `${language} dynamic patterns`).toBeGreaterThan(0);
    }
  });

  it("marks class/method/function captures in each container query", () => {
    for (const [language, adapter] of Object.entries(IMPLICIT_DEPENDENCY_ADAPTERS)) {
      const query = adapter.containerQuery ?? "";
      expect(query, `${language} @class capture`).toContain("@class");
      expect(query, `${language} name capture`).toContain("@name");
      // 每种语言至少有一种容器捕获（class/method/function 之一）
      expect(query, `${language} container capture`).toMatch(/@(?:class|method|function)/);
    }
  });

  it("returns undefined for unknown languages (script degrades gracefully)", () => {
    expect(implicitDependencyAdapterFor("cobol")).toBeUndefined();
  });
});
