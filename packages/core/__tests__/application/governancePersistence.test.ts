import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGovernancePersistence, readHistoryRetentionPolicy, setGovernancePersistence, syncGovernancePersistence } from "../../src/application/governancePersistence";

const directories: string[] = [];

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-persistence-"));
  directories.push(cwd);
  execFileSync("git", ["init", "--quiet"], { cwd });
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [python]\n");
  return cwd;
};

afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("governance persistence", () => {
  it("treats legacy config as tracked until an explicit migration", async () => {
    const cwd = project();

    expect(await readGovernancePersistence(cwd)).toBe("tracked");

    const first = await syncGovernancePersistence(cwd, "local");
    const second = await syncGovernancePersistence(cwd, "local");
    const config = readFileSync(join(cwd, ".openarch", "config.yml"), "utf8");
    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");

    expect(first).toMatchObject({ persistence: "local", configChanged: true, exclude: "updated" });
    expect(second).toMatchObject({ persistence: "local", configChanged: false, exclude: "unchanged" });
    expect(config).toContain("governance:\n  persistence: local");
    expect(exclude).toContain("# OpenArch local persistence\n.openarch/");
    expect(existsSync(join(cwd, ".openarch", "config.yml"))).toBe(true);
  });

  it("removes only its managed local exclude block when returning to tracked", async () => {
    const cwd = project();
    const exclude = join(cwd, ".git", "info", "exclude");
    writeFileSync(exclude, "custom-cache/\n# OpenArch local persistence\n.openarch/\n");

    const result = await syncGovernancePersistence(cwd, "tracked");

    expect(result).toMatchObject({ persistence: "tracked", exclude: "updated" });
    expect(readFileSync(exclude, "utf8")).toContain("custom-cache/");
    expect(readFileSync(exclude, "utf8")).not.toContain("OpenArch local persistence");
  });

  it("reports tracked OpenArch files without removing them", async () => {
    const cwd = project();
    execFileSync("git", ["add", "-f", ".openarch/config.yml"], { cwd });

    const result = await syncGovernancePersistence(cwd, "local");

    expect(result.trackedPaths).toEqual([".openarch/config.yml"]);
    expect(execFileSync("git", ["ls-files", "--", ".openarch/config.yml"], { cwd, encoding: "utf8" }).trim()).toBe(".openarch/config.yml");
  });

  it("uses an explicit history raw window when configured and a stable default for legacy projects", async () => {
    const cwd = project();
    expect(await readHistoryRetentionPolicy(cwd)).toEqual({ rawWindowDays: 180 });

    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  history:\n    raw_window_days: 14\n");
    expect(await readHistoryRetentionPolicy(cwd)).toEqual({ rawWindowDays: 14 });

    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  history:\n    raw_window_days: 0\n");
    await expect(readHistoryRetentionPolicy(cwd)).rejects.toThrow("integer from 1 through 3650");
  });

  it("updates only governance.persistence, not an unrelated top-level key", async () => {
    const cwd = project();
    writeFileSync(join(cwd, ".openarch", "config.yml"), "persistence: legacy\nproject: demo\ngovernance:\n  history:\n    raw_window_days: 14\n");
    await syncGovernancePersistence(cwd, "local");
    const config = readFileSync(join(cwd, ".openarch", "config.yml"), "utf8");
    expect(config).toContain("persistence: legacy");
    expect(config).toContain("governance:\n  persistence: local");
  });

  // D7 回归：跨行 flow mapping 曾同时逃过"单行守卫"与"块定位"，于是被追加出第二个顶层 governance:，
  // 而 js-yaml 对重复键抛错 ⇒ 用户的 config.yml 变成无法解析。
  // 该 flow mapping 的值已等于目标：报错必须说明"展开后无需改动"，但仍必须拒绝落盘。
  it("fails closed on a multi-line flow governance mapping instead of appending a duplicate key", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    // 合法 YAML 的跨行 flow mapping：flow 续行必须缩进，js-yaml 才接受（`}` 顶格是 deficient indentation）。
    const flow = "version: 1\ngovernance: {\n  persistence: local\n  }\n";
    writeFileSync(configPath, flow);

    await expect(syncGovernancePersistence(cwd, "local")).rejects.toThrow(
      "flow-style governance mapping already sets persistence: local; expand it to a block mapping and no change is required",
    );

    // 文件逐字节不变，且仍可解析（既没有重复键，也没有被改写成别的形态）。
    expect(readFileSync(configPath, "utf8")).toBe(flow);
    expect(readFileSync(configPath, "utf8").match(/^governance:/gm)).toHaveLength(1);
    expect(await readGovernancePersistence(cwd)).toBe("local");
    expect(await readHistoryRetentionPolicy(cwd)).toEqual({ rawWindowDays: 180 });
  });

  it("keeps the expand-first error when a multi-line flow mapping holds a different value", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const flow = "version: 1\ngovernance: {\n  persistence: local\n  }\n";
    writeFileSync(configPath, flow);

    await expect(setGovernancePersistence(cwd, "tracked")).rejects.toThrow(
      "inline governance mapping cannot be migrated; expand it before setting persistence",
    );

    expect(readFileSync(configPath, "utf8")).toBe(flow);
    expect(await readGovernancePersistence(cwd)).toBe("local");
  });

  it("keeps the expand-first error for a single-line inline flow governance mapping", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const inline = "governance: { persistence: tracked }\n";
    writeFileSync(configPath, inline);

    await expect(setGovernancePersistence(cwd, "local")).rejects.toThrow(
      "inline governance mapping cannot be migrated; expand it before setting persistence",
    );

    expect(readFileSync(configPath, "utf8")).toBe(inline);
    expect(await readGovernancePersistence(cwd)).toBe("tracked");
  });

  it("says no change is required for a single-line inline flow mapping that already holds the target", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const inline = "governance: { persistence: tracked }\n";
    writeFileSync(configPath, inline);

    await expect(setGovernancePersistence(cwd, "tracked")).rejects.toThrow(
      "flow-style governance mapping already sets persistence: tracked; expand it to a block mapping and no change is required",
    );

    expect(readFileSync(configPath, "utf8")).toBe(inline);
    expect(await readGovernancePersistence(cwd)).toBe("tracked");
  });

  // 守卫的旧实现用"文本像不像单行 governance: {...}"预测可迁移性；新判据来自解析结果：
  // 只有 js-yaml 确认顶层 governance 键不存在时才允许追加，且追加后必须再解析验证。
  it("never writes a second top-level governance key when the key already exists in a nested block", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const nested = "governance:\n  history:\n    persistence: tracked\n";
    writeFileSync(configPath, nested);

    const changed = await setGovernancePersistence(cwd, "local");

    expect(changed).toBe(true);
    const after = readFileSync(configPath, "utf8");
    expect(after).toBe("governance:\n  persistence: local\n  history:\n    persistence: tracked\n");
    expect(await readGovernancePersistence(cwd)).toBe("local");
    // 既有的 governance.history 未被覆盖。
    expect(after).toContain("    persistence: tracked");
  });

  it("rejects a scalar governance value before touching the file", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const scalar = "governance: local\n";
    writeFileSync(configPath, scalar);

    await expect(setGovernancePersistence(cwd, "local")).rejects.toThrow("governance must be a mapping");

    expect(readFileSync(configPath, "utf8")).toBe(scalar);
  });

  it("keeps CRLF configs on CRLF line endings", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    writeFileSync(configPath, "version: 1\r\ngovernance:\r\n  history:\r\n    raw_window_days: 14\r\n");

    await setGovernancePersistence(cwd, "local");

    expect(readFileSync(configPath, "utf8")).toBe("version: 1\r\ngovernance:\r\n  persistence: local\r\n  history:\r\n    raw_window_days: 14\r\n");
  });

  // 审计 D7 反例的逐字形态（`}` 顶格）：js-yaml 5.2.1 判为 deficient indentation，
  // 因此它在当前依赖下到不了"末尾追加"分支；真正可达的是上一条缩进续行版。
  // 两种形态都必须拒绝且不动文件——这里记录的是"解析失败即拒绝"这一事实边界。
  it("refuses a config that js-yaml cannot parse without touching it", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const flushLeft = "version: 1\ngovernance: {\n  persistence: local\n}\n";
    writeFileSync(configPath, flushLeft);

    await expect(setGovernancePersistence(cwd, "local")).rejects.toThrow();

    expect(readFileSync(configPath, "utf8")).toBe(flushLeft);
  });

  // 写入后校验不是死代码：就地改写可能把一个合法的块标量变成非法缩进，此时必须拒绝落盘。
  it("fails closed when the in-place rewrite would invalidate the document", async () => {
    const cwd = project();
    const configPath = join(cwd, ".openarch", "config.yml");
    const blockScalar = "governance:\n  persistence: |\n    local\n";
    writeFileSync(configPath, blockScalar);

    await expect(setGovernancePersistence(cwd, "local")).rejects.toThrow("inline governance mapping cannot be migrated");

    expect(readFileSync(configPath, "utf8")).toBe(blockScalar);
  });
});
