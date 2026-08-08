import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeAntiPatternRule } from "../../src/anti-patterns/engine";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";
import { createProjectFacts, normalizeRepositoryPath } from "../../src/script-runtime/projectFacts";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const template = (name: string) => {
  const language = name.startsWith("python-") ? "python"
    : name.startsWith("go-") ? "go"
      : name.startsWith("rust-") ? "rust"
        : name.startsWith("typescript-") ? "typescript"
          : name.startsWith("java-") ? "java"
        : "common";
  const file = language === "common" ? name : name.replace(/^(python|go|rust|typescript|java)-/, "");
  return resolve(process.cwd(), "assets", "templates", language, "anti-patterns", `${file}.mjs`);
};

const parser = () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("cross-language placeholder templates", () => {
  it("queries each language grammar through the shared anti-pattern runtime", async () => {
    const fixtures = [
      ["placeholder.ts", "export function pending() {}\n", "typescript-no-empty-function", "no-empty-function"],
      ["placeholder.py", "def pending():\n    pass\n", "python-placeholder-implementation", "placeholder-implementation"],
      ["placeholder.go", "package placeholder\nfunc pending() {}\n", "go-placeholder-implementation", "placeholder-implementation"],
      ["placeholder.rs", "fn pending() {}\n", "rust-placeholder-implementation", "placeholder-implementation"],
      ["Placeholder.java", "class Placeholder { void pending() {} }\n", "java-placeholder-implementation", "placeholder-implementation"],
    ] as const;
    const service = await parser();

    await withTemporaryDirectory("placeholder", async (cwd) => {
      for (const [name, source, asset, ruleId] of fixtures) {
        const file = join(cwd, name);
        writeFileSync(file, source);
        const result = await executeAntiPatternRule(template(asset), [file], service, undefined, {
          facts: createProjectFacts({ files: [file], projectRoot: cwd }),
        });
        expect(result.error).toBeUndefined();
        expect(result.unavailable).toBeUndefined();
        expect(result.hits).toEqual([expect.objectContaining({
          ruleId,
          file: normalizeRepositoryPath(file),
          category: "quality",
          severity: "warning",
          patternFamily: "placeholder-implementation",
          suggestion: expect.any(String),
          ...(asset === "python-placeholder-implementation" ? { line: 2, endLine: 2 } : {}),
        })]);
      }
    });
  });

  it("uses the declared language target before AST execution in a mixed-language project", async () => {
    const service = await parser();

    await withTemporaryDirectory("mixed-language-target", async (cwd) => {
      const goFile = join(cwd, "placeholder.go");
      const tsFile = join(cwd, "placeholder.ts");
      writeFileSync(goFile, "package placeholder\nfunc pending() {}\n");
      writeFileSync(tsFile, "export function pending() {}\n");

      const result = await executeAntiPatternRule(template("go-placeholder-implementation"), [goFile, tsFile], service, undefined, {
        facts: createProjectFacts({ files: [goFile, tsFile], projectRoot: cwd }),
      });
      expect(result.error).toBeUndefined();
      expect(result.unavailable).toBeUndefined();
      expect(result.hits).toEqual([expect.objectContaining({ file: normalizeRepositoryPath(goFile) })]);
      expect(result.stages?.targetFiles).toEqual([normalizeRepositoryPath(goFile)]);
    });
  });

  it("keeps declaration-only Python and Java contracts outside placeholder findings", async () => {
    const service = await parser();

    await withTemporaryDirectory("python-placeholder-boundaries", async (cwd) => {
      const file = join(cwd, "contracts.py");
      writeFileSync(file, `from abc import abstractmethod\nfrom typing import Protocol\n\nclass Contract(Protocol):\n    def required(self) -> None: ...\n\nclass AbstractContract:\n    @abstractmethod\n    def required(self) -> None: ...\n\ndef unfinished() -> None:\n    pass\n`);

      const result = await executeAntiPatternRule(template("python-placeholder-implementation"), [file], service, undefined, {
        facts: createProjectFacts({ files: [file], projectRoot: cwd }),
      });
      expect(result.error).toBeUndefined();
      expect(result.unavailable).toBeUndefined();
      expect(result.hits).toEqual([expect.objectContaining({
        ruleId: "placeholder-implementation", file: normalizeRepositoryPath(file), line: 12, evidence: "pass", category: "quality",
      })]);

      const javaFile = join(cwd, "contracts.java");
      writeFileSync(javaFile, `abstract class AbstractContract {
  abstract void required();
}
interface Contract {
  void required();
}
class Concrete {
  void complete() { return; }
  void unfinished() {}
}
`);
      const javaResult = await executeAntiPatternRule(template("java-placeholder-implementation"), [javaFile], service, undefined, {
        facts: createProjectFacts({ files: [javaFile], projectRoot: cwd }),
      });
      expect(javaResult.error).toBeUndefined();
      expect(javaResult.unavailable).toBeUndefined();
      expect(javaResult.hits).toEqual([expect.objectContaining({
        ruleId: "placeholder-implementation", file: normalizeRepositoryPath(javaFile), evidence: "{}", category: "quality",
      })]);
    });
  });

  it("detects parser-confirmed silent error handling and keeps non-empty alternatives clean", async () => {
    const fixtures = [
      ["silent.ts", "export function run() { try { work(); } catch (error) {} }\n", "export function run() { try { work(); } catch (error) { throw error; } }\n", "typescript-no-empty-catch", "no-empty-catch"],
      ["silent.py", "def run():\n    try:\n        work()\n    except Exception:\n        pass\n", "def run():\n    try:\n        work()\n    except Exception:\n        raise\n", "python-silent-error-handling", "silent-error-handling"],
      ["Silent.java", "class Silent { void run() { try { work(); } catch (Exception error) {} } void work() {} }\n", "class Silent { void run() { try { work(); } catch (Exception error) { throw error; } } void work() {} }\n", "java-silent-error-handling", "silent-error-handling"],
    ] as const;
    const service = await parser();

    await withTemporaryDirectory("silent-error", async (cwd) => {
      for (const [name, violation, legalAlternative, asset, ruleId] of fixtures) {
        const file = join(cwd, name);
        writeFileSync(file, violation);
        const violationResult = await executeAntiPatternRule(template(asset), [file], service, undefined, {
          facts: createProjectFacts({ files: [file], projectRoot: cwd }),
        });
        expect(violationResult.error).toBeUndefined();
        expect(violationResult.unavailable).toBeUndefined();
        expect(violationResult.hits).toEqual([expect.objectContaining({
          ruleId, file: normalizeRepositoryPath(file), category: "correctness", severity: "warning", patternFamily: "silent-error-handling", suggestion: expect.any(String),
        })]);

        writeFileSync(file, legalAlternative);
        const legalResult = await executeAntiPatternRule(template(asset), [file], service, undefined, {
          facts: createProjectFacts({ files: [file], projectRoot: cwd }),
        });
        expect(legalResult.hits).toEqual([]);
      }
    });
  });

  it("keeps parser failure explicit instead of treating Java templates as clean", async () => {
    const fixtures = [
      ["Placeholder.java", "class Placeholder { void pending() {} }\n", "java-placeholder-implementation"],
      ["Silent.java", "class Silent { void run() { try { work(); } catch (Exception error) {} } void work() {} }\n", "java-silent-error-handling"],
    ] as const;

    await withTemporaryDirectory("java-placeholder-unavailable", async (cwd) => {
      const unavailableParser = { query: () => Effect.fail(new Error("grammar unavailable")) } as never;
      for (const [name, source, asset] of fixtures) {
        const file = join(cwd, name);
        writeFileSync(file, source);
        const result = await executeAntiPatternRule(template(asset), [file], unavailableParser, undefined, {
          facts: createProjectFacts({ files: [file], projectRoot: cwd }),
        });
        expect(result.hits).toEqual([]);
        expect(result.unavailable).toContain("AST query unavailable for");
        expect(result.unavailable).toContain("grammar unavailable");
      }
    });
  });

  it("extracts parser-confirmed static imports for authority rules across Go, Rust, and Python", async () => {
    // fixture 放 cwd 内：跨盘符绝对路径会被 normalizeRepositoryPath 保持为绝对、
    // 而 authority protectedPath 拒绝绝对（仓库外文件不属于任何 authority 保护）——
    // 仓库相对路径才是产品语义（校准 2026-08-07）。必须用仓库内目录（process.cwd()），
    // 不能用系统 temp（仓库外）。
    const fixtures = [
      ["authority.go", 'package authority\nimport "os/exec"\n', "os/exec"],
      ["authority.rs", "use std::process::Command;\n", "std::process::Command"],
      ["authority.py", "import subprocess\n", "subprocess"],
    ] as const;
    const service = await parser();
    const cwd = join(process.cwd(), `.tmp-authority-import-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });

    try {
      for (const [name, source, prohibitedImport] of fixtures) {
        const file = join(cwd, name);
        writeFileSync(file, source);
        const result = await executeAntiPatternRule(template("authority-import-bypass"), [file], service, undefined, {
          facts: createProjectFacts({
            files: [normalizeRepositoryPath(file)], projectRoot: cwd,
            authorities: [{ id: "boundary", owner: "src/owner", protectedPaths: [normalizeRepositoryPath(file)], prohibitedImports: [prohibitedImport] }],
          }),
        });
        expect(result.hits).toEqual([expect.objectContaining({ ruleId: "authority-import-bypass", file: normalizeRepositoryPath(file) })]);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("derives changed imports through parseText before a change-set authority rule runs", async () => {
    const service = await parser();
    const fixtures = [
      ["boundary.go", "package boundary\n", 'package boundary\nimport "os/exec"\n', "os/exec"],
      ["boundary.rs", "fn main() {}\n", "use std::process::Command;\nfn main() {}\n", "std::process::Command"],
      ["boundary.py", "", "import subprocess\n", "subprocess"],
    ] as const;

    for (const [path, beforeText, afterText, prohibitedImport] of fixtures) {
      const result = await executeAntiPatternRule(template("authority-boundary"), [], service, undefined, {
        facts: createProjectFacts({
          files: [path],
          authorities: [{ id: "boundary", owner: "src/owner", protectedPaths: [path], prohibitedImports: [prohibitedImport] }],
        }),
        changeSet: { availability: "available", files: [{ path, kind: "modified", beforeText, afterText }] },
      });
      expect(result.hits).toEqual([expect.objectContaining({ ruleId: "authority-boundary-bypass", file: path })]);
    }
  });
});
