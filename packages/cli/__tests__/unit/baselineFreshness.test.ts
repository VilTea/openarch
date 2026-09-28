import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCommand } from "../../src/commands/scan";
import { contextCommand } from "../../src/commands/context";

/**
 * baseline 新鲜度闭环（校准 2026-09-25）。
 *
 * 缺陷：`sourceSnapshotSha256` 此前只在增量路径写入，于是 `scan --rebuild`
 * （以及因 config.yml 变化自动退化全量）写出的 index 没有该字段，
 * `baseline.freshness` 按构造永久为 `unknown` —— 而发行版技能恰好规定
 * "改了 structural_policies/file_kinds 必须 scan --rebuild"。
 * 即"按文档做正确的事"会永久抹掉新鲜度信号。
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
  const cwd = mkdtempSync(join(tmpdir(), "openarch-freshness-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [typescript]\n");
  writeFileSync(join(cwd, "src", "a.ts"), "export function a(x?: string) { if (!x) return; }\n");
  previousBase = process.env.OPENARCH_BASE_DIR;
  process.env.OPENARCH_BASE_DIR = join(cwd, ".openarch");
  return cwd;
};

const indexOf = (cwd: string): { meta: { sourceSnapshotSha256?: string } } =>
  JSON.parse(readFileSync(join(cwd, ".openarch", "baseline", "_index.json"), "utf8"));

const contextJson = async (cwd: string): Promise<{ baseline: { freshness: string; freshnessReason?: string } }> => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await contextCommand(["--json"], { cwd, rawArgv: [], locale: "zh" });
  const json = JSON.parse(String(output.mock.calls[0]![0]));
  output.mockRestore();
  return json;
};

describe("scan 写入 baseline 内容身份，freshness 才有结论", () => {
  it("完整 scan 与 scan --rebuild 都写入 sourceSnapshotSha256", async () => {
    const cwd = tempProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await scanCommand([], { cwd, rawArgv: [], locale: "zh" });
    const first = indexOf(cwd).meta.sourceSnapshotSha256;
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    // rebuild 是"改了配置后必须执行"的路径——它也必须留下身份，否则抹掉新鲜度。
    await scanCommand(["--rebuild"], { cwd, rawArgv: [], locale: "zh" });
    expect(indexOf(cwd).meta.sourceSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scan --rebuild 之后 freshness 是 current，而不是 unknown", async () => {
    const cwd = tempProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await scanCommand(["--rebuild"], { cwd, rawArgv: [], locale: "zh" });

    const json = await contextJson(cwd);
    expect(json.baseline.freshness).toBe("current");
    expect(json.baseline.freshnessReason).toBeUndefined();
  });

  it("改动源码后 freshness 变 stale（说明身份真的在比对，而不是恒 current）", async () => {
    const cwd = tempProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await scanCommand([], { cwd, rawArgv: [], locale: "zh" });
    writeFileSync(join(cwd, "src", "a.ts"), "export function a(x?: string) { if (!x) { return; } }\n");

    const json = await contextJson(cwd);
    expect(json.baseline.freshness).toBe("stale");
  });

  it("baseline 写入时没有身份 → unknown 并给出原因（不静默）", async () => {
    const cwd = tempProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await scanCommand([], { cwd, rawArgv: [], locale: "zh" });
    // 模拟 0.1.5 及更早的 rebuild 产物：删掉身份字段。
    const indexPath = join(cwd, ".openarch", "baseline", "_index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    delete index.meta.sourceSnapshotSha256;
    writeFileSync(indexPath, JSON.stringify(index));

    const json = await contextJson(cwd);
    expect(json.baseline.freshness).toBe("unknown");
    expect(json.baseline.freshnessReason).toBe("baseline_missing_snapshot_identity");
  });

  it("没有 baseline 时 unknown 的原因是 no_readable_index", async () => {
    const cwd = tempProject();
    const json = await contextJson(cwd);
    expect(json.baseline.freshness).toBe("unknown");
    expect(json.baseline.freshnessReason).toBe("no_readable_index");
  });
});
