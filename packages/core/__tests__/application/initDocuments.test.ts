import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureInitDocuments } from "../../src/application/initDocuments";

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = join(tmpdir(), `openarch-init-documents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configureInitDocuments", () => {
  it("associates an existing local document store and reports the association", () => {
    const project = temporaryRoot();
    const docs = temporaryRoot();
    mkdirSync(project, { recursive: true });
    mkdirSync(docs, { recursive: true });

    const result = configureInitDocuments({ cwd: project, docsRepo: docs });

    expect(result).toMatchObject({ code: 0 });
    expect(result?.messages.join("\n")).toContain("✓ 关联");
    expect(existsSync(join(project, ".openarch", ".docs-repo-config.json"))).toBe(true);
  });

  it("does not invent a shared scope without an explicit document repository", () => {
    expect(configureInitDocuments({ cwd: temporaryRoot(), documentScope: "service=projects/service" }))
      .toEqual({ code: 3, messages: ["--docs-scope 只能与 --docs-repo 一起使用"] });
  });
});
