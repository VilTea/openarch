import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCommand } from "../../src/commands/scan";
import { checkCommand } from "../../src/commands/check";

/**
 * `check --report` 必须提示"测试文件未入 baseline"（校准 2026-09-25）。
 *
 * 缺陷：只有 `openarch test` 报 `test_files_missing_from_baseline`，
 * 不主动跑 test 的使用方就会漏掉新增测试文件未纳入基线这件事。
 * 提示只报告、不改变裁决；判据与 `openarch test` 共用 `unbaselinedTestFiles`。
 */

const temporaryDirectories: string[] = [];
let previousBase: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousBase === undefined) delete process.env.OPENARCH_BASE_DIR;
  else process.env.OPENARCH_BASE_DIR = previousBase;
  previousBase = undefined;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tempProject = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-check-tests-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [typescript]\n");
  writeFileSync(join(cwd, "src", "a.ts"), "export function a(x?: string) { if (!x) return; }\n");
  previousBase = process.env.OPENARCH_BASE_DIR;
  process.env.OPENARCH_BASE_DIR = join(cwd, ".openarch");
  return cwd;
};

const runAndCapture = async (run: () => Promise<number>): Promise<string> => {
  const chunks: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => { chunks.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await run();
  return chunks.join("\n");
};

describe("check --report 的测试文件基线提示", () => {
  it("新增测试文件未入 baseline 时给出报告级提示（不影响退出码）", async () => {
    const cwd = tempProject();
    await runAndCapture(() => scanCommand([], { cwd, rawArgv: [], locale: "zh" }));
    // scan 之后新增测试文件：它必然不在 baseline 的 test 总体里。
    writeFileSync(join(cwd, "src", "b.test.ts"), "import { a } from './a';\nit('works', () => { a('x'); });\n");

    const text = await runAndCapture(() => checkCommand(["--report"], { cwd, rawArgv: [], locale: "zh" }));
    expect(text).toContain("测试文件未入 baseline: 1");
    expect(text).toContain("src/b.test.ts");
    expect(text).toContain("仅报告，不影响裁决");
  });

  it("没有未入基线的测试文件时不输出该提示", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "src", "b.test.ts"), "import { a } from './a';\nit('works', () => { a('x'); });\n");
    await runAndCapture(() => scanCommand([], { cwd, rawArgv: [], locale: "zh" }));

    const text = await runAndCapture(() => checkCommand(["--report"], { cwd, rawArgv: [], locale: "zh" }));
    expect(text).not.toContain("测试文件未入 baseline");
  });
});
