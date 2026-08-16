import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextCommand } from "../../src/commands/context";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tempProject = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-context-"));
  temporaryDirectories.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
};

const tempDirectory = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-context-no-git-"));
  temporaryDirectories.push(cwd);
  return cwd;
};

describe("context command", () => {
  it("reports missing foundation as facts rather than routing to an action", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contextCommand([], { cwd: tempProject(), rawArgv: [], locale: "zh" })).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("配置: 缺失"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("不代表唯一下一步"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("未配置协调服务"));
  });

  it("renders all context presentation through the selected locale", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contextCommand([], { cwd: tempProject(), rawArgv: [], locale: "en" })).resolves.toBe(0);

    const rendered = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(rendered).toContain("## OpenArch Project Context");
    expect(rendered).toContain(".openarch/config.yml is missing");
    expect(rendered).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("reports fresh pending worktree evidence without asking for another measurement", async () => {
    const cwd = tempProject();
    const source = "export const sample = 1;\n";
    mkdirSync(join(cwd, ".openarch", "baseline"), { recursive: true });
    mkdirSync(join(cwd, ".openarch", "pending"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [typescript]\n");
    writeFileSync(join(cwd, ".openarch", "baseline", "_index.json"), JSON.stringify({ meta: { nFiles: 1 } }));
    writeFileSync(join(cwd, "sample.ts"), source);
    writeFileSync(join(cwd, ".openarch", "pending", "diff.json"), JSON.stringify({
      evidence: [{ file: "sample.ts", sha256: createHash("sha256").update(source).digest("hex") }],
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contextCommand([], { cwd, rawArgv: [], locale: "zh" })).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("待封存语义证据=当前"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("架构策略: UNCONFIGURED（0 条已声明规则）"));
  });

  it("provides the same facts as JSON for an Agent host", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cwd = tempProject();

    await expect(contextCommand(["--json"], { cwd, rawArgv: [], locale: "zh" })).resolves.toBe(0);
    const chinese = String(output.mock.calls[0][0]);
    output.mockClear();
    await expect(contextCommand(["--json"], { cwd, rawArgv: [], locale: "en" })).resolves.toBe(0);
    expect(String(output.mock.calls[0][0])).toBe(chinese);

    expect(JSON.parse(chinese)).toMatchObject({
      configuration: "missing", baseline: { available: false }, architecturePolicy: { state: "unavailable" },
    });
    expect(JSON.parse(chinese).readiness[0]).toHaveProperty("reason.code");
  });

  it("exposes machine-readable languages, baseline identity, and policy populations in context --json", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cwd = tempProject();
    mkdirSync(join(cwd, ".openarch", "baseline"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), [
      "languages: [typescript]",
      "structural_policies:",
      "  - id: alpha-ts",
      "    mode: enforce",
      "    languages: [typescript]",
      "    rules_warn:",
      "      - name: branch",
      "        condition: max_func_branch > 6",
    ].join("\n"));
    writeFileSync(join(cwd, ".openarch", "baseline", "_index.json"), JSON.stringify({
      meta: {
        nFiles: 9,
        languages: ["typescript"],
        snapshotSha256: "snapshot-abc",
        metricContractVersion: "metric-contract-v4",
        policyCalibrations: { "alpha-ts": { gate: { id: "sealed-1" } } },
        policyPopulations: { "alpha-ts": 38 },
      },
    }));
    writeFileSync(join(cwd, ".openarch", "scan-status.json"), JSON.stringify({
      status: "failed", phase: "parsing", completed: 1, total: 3, reason: "ParseError",
    }));

    await expect(contextCommand(["--json"], { cwd, rawArgv: [], locale: "zh" })).resolves.toBe(0);
    const json = JSON.parse(String(output.mock.calls[0][0]));

    expect(json.schema).toBe("context-json-v1");
    expect(json.contract).toEqual({ id: "context-json", version: "context-json-v1" });
    expect(json.languages).toEqual(["typescript"]);
    expect(json.baseline).toMatchObject({
      languages: ["typescript"],
      snapshotSha256: "snapshot-abc",
      metricContractVersion: "metric-contract-v4",
      policyPopulations: [{ id: "alpha-ts", productionFiles: 38, calibration: "sealed" }],
    });
    expect(json.architecturePolicy.policies).toEqual([
      { id: "alpha-ts", mode: "enforce", languages: ["typescript"], rules: 1 },
    ]);
    expect(json.scan.status).toMatchObject({ status: "failed", phase: "parsing", reason: "ParseError" });
    expect(json.scan.exclusions.segments).toContain("/node_modules/");
    expect(json.scan.exclusions.directoryNames).toContain("target");
    const coordination = json.readiness.find((item: { id: string }) => item.id === "coordination-service");
    expect(coordination).toMatchObject({ state: "not_configured", kind: "optional" });
    const codeHook = json.readiness.find((item: { id: string }) => item.id === "code-hook");
    expect(codeHook?.kind).toBe("enforcing");
  });

  it("reports an explicitly configured coordinator without claiming connectivity", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "coordination.json"), JSON.stringify({ version: 1, url: "https://coordination.example.test/api" }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contextCommand([], { cwd, rawArgv: [], locale: "en" })).resolves.toBe(0);

    const rendered = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(rendered).toContain("Coordination service is explicitly configured: https://coordination.example.test/api");
    expect(rendered).toContain("connectivity is not yet verified");
  });

  it("keeps local context readable outside a Git worktree", async () => {
    const cwd = tempDirectory();
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: []\n");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contextCommand([], { cwd, rawArgv: [], locale: "en" })).resolves.toBe(0);

    const rendered = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(rendered).toContain("Git change set: UNAVAILABLE");
  });
});
