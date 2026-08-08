import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSymbolVersionPair, collectTypeScriptSymbolVersionPair } from "../../src/application/symbolVersionPair";

const directories: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const project = (): string => {
  const cwd = join(tmpdir(), `openarch-symbol-version-pair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directories.push(cwd);
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [typescript]\n");
  writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "openarch@example.test"]);
  git(cwd, ["config", "user.name", "OpenArch test"]);
  return cwd;
};

const commit = (cwd: string, message: string): void => {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
};

const multiProject = (): string => {
  const cwd = project();
  mkdirSync(join(cwd, "packages", "contracts", "src"), { recursive: true });
  mkdirSync(join(cwd, "packages", "app", "src"), { recursive: true });
  writeFileSync(join(cwd, "packages", "contracts", "tsconfig.json"), JSON.stringify({
    compilerOptions: { composite: true, declaration: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ESNext", rootDir: "src", outDir: "dist" },
    include: ["src/**/*.ts"],
  }));
  writeFileSync(join(cwd, "packages", "app", "tsconfig.json"), JSON.stringify({
    compilerOptions: { composite: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ESNext", rootDir: "src", outDir: "dist" },
    references: [{ path: "../contracts" }], include: ["src/**/*.ts"],
  }));
  return cwd;
};

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("TypeScript version-paired symbol facts", () => {
  it("keeps a common Git population and pairs a unique declaration across line movement", () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "api.ts"), [
      "function internalRun(): number { return 1; }",
      "export function serve(): number { return internalRun(); }",
    ].join("\n"));
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "api.ts"), [
      "// A comment deliberately moves the declaration line.",
      "function internalRun(): number { return 2; }",
      "export function serve(): number { return internalRun(); }",
    ].join("\n"));
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);

    expect(report).toMatchObject({
      availability: "available",
      population: { files: ["src/api.ts"] },
      before: { state: { coverage: { declarations: "complete", repositoryReferences: "complete" } } },
      after: { state: { coverage: { declarations: "complete", repositoryReferences: "complete" } } },
    });
    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "matched", before: expect.objectContaining({ declaration: expect.objectContaining({ name: "internalRun", line: 1 }) }),
      after: expect.objectContaining({ declaration: expect.objectContaining({ name: "internalRun", line: 2 }) }),
    }));
  });

  it("keeps rename/removal as a durable negative calibration sample instead of inferring identity", () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "api.ts"), "function oldInternal(): number { return 1; }\nexport const serve = () => oldInternal();\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "api.ts"), "function renamedInternal(): number { return 1; }\nexport const serve = () => renamedInternal();\n");
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);

    expect(report.availability).toBe("available");
    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "removed", before: expect.objectContaining({ declaration: expect.objectContaining({ name: "oldInternal" }) }),
    }));
    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "added", after: expect.objectContaining({ declaration: expect.objectContaining({ name: "renamedInternal" }) }),
    }));
  });

  it("keeps a declaration moved to another file as removed plus added", () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "before.ts"), "function moved(): number { return 1; }\nexport const serve = () => moved();\n");
    commit(cwd, "before");
    git(cwd, ["mv", "src/before.ts", "src/after.ts"]);
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);

    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "removed", before: expect.objectContaining({ declaration: expect.objectContaining({ file: "src/before.ts", name: "moved" }) }),
    }));
    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "added", after: expect.objectContaining({ declaration: expect.objectContaining({ file: "src/after.ts", name: "moved" }) }),
    }));
  });

  it("retains project-reference source redirection and a cross-project consumer in both snapshots", () => {
    const cwd = multiProject();
    writeFileSync(join(cwd, "packages", "contracts", "src", "index.ts"), "export function contractWorker(): number { return 1; }\n");
    writeFileSync(join(cwd, "packages", "app", "src", "consumer.ts"), [
      'import { contractWorker } from "../../contracts/src/index.js";',
      "export const consume = () => contractWorker();",
    ].join("\n"));
    commit(cwd, "before");
    writeFileSync(join(cwd, "packages", "contracts", "src", "index.ts"), "export function contractWorker(): number { return 2; }\n");
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "contractWorker");

    expect(report).toMatchObject({ availability: "available", population: { files: expect.arrayContaining([
      "packages/contracts/src/index.ts", "packages/app/src/consumer.ts",
    ]) } });
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "packages/app/src/consumer.ts", line: 1 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "packages/app/src/consumer.ts", line: 1 }));
  });

  it("retains tsconfig path aliases and barrel re-exports in both snapshots", () => {
    const cwd = project();
    writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, baseUrl: ".", module: "NodeNext", moduleResolution: "NodeNext", paths: { "@contracts/*": ["src/contracts/*"] } },
      include: ["src/**/*.ts"],
    }));
    mkdirSync(join(cwd, "src", "contracts"), { recursive: true });
    writeFileSync(join(cwd, "src", "contracts", "worker.ts"), "export function aliasedWorker(): number { return 1; }\n");
    writeFileSync(join(cwd, "src", "public.ts"), 'export { aliasedWorker } from "./contracts/worker.js";\n');
    writeFileSync(join(cwd, "src", "consumer.ts"), [
      'import { aliasedWorker } from "@contracts/worker";',
      'import { aliasedWorker as publicWorker } from "./public.js";',
      "export const consume = () => aliasedWorker() + publicWorker();",
    ].join("\n"));
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "contracts", "worker.ts"), "export function aliasedWorker(): number { return 2; }\n");
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "aliasedWorker");

    expect(report.availability).toBe("available");
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/consumer.ts", line: 1 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/consumer.ts", line: 2 }));
  });

  it("includes a repository-local tsconfig extends chain in both snapshots", () => {
    const cwd = project();
    mkdirSync(join(cwd, "config"), { recursive: true });
    writeFileSync(join(cwd, "config", "base.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json", include: ["src/**/*.ts"] }));
    writeFileSync(join(cwd, "src", "api.ts"), "function inheritedConfigWorker(): number { return 1; }\nexport const serve = () => inheritedConfigWorker();\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "api.ts"), "function inheritedConfigWorker(): number { return 2; }\nexport const serve = () => inheritedConfigWorker();\n");
    commit(cwd, "after");

    const report = collectTypeScriptSymbolVersionPair(cwd);

    expect(report).toMatchObject({ availability: "available", before: { state: { availability: "available" } }, after: { state: { availability: "available" } } });
    expect(report.declarations).toContainEqual(expect.objectContaining({
      status: "matched", after: expect.objectContaining({ declaration: expect.objectContaining({ name: "inheritedConfigWorker" }) }),
    }));
  });

  it("reports non-compiler historical providers as unavailable instead of fabricating Git-era LSP facts", () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "api.py"), "def worker():\n    return 1\n");
    writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [python]\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "api.py"), "def worker():\n    return 2\n");
    commit(cwd, "after");

    expect(collectSymbolVersionPair(cwd, "HEAD", "python")).toMatchObject({
      availability: "unavailable", language: "python", declarations: [],
      reason: expect.stringContaining("LSP provider analyzes a worktree"),
    });
  });
});
