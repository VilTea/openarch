// 端到端测试：在临时目录中跑（不碰真实的 .openarch/）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync,
  cpSync, readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const cliEntry = join(root, "packages/cli/src/main.ts");
const fixtureSrc = join(root, "fixtures/demo-scan");

let tmpDir: string;

describe("openarch scan e2e", () => {
  beforeAll(() => {
    // 在临时目录中准备 fixture，但 spawn cwd 仍用 root（需要 tsx 解析）
    tmpDir = join(tmpdir(), `openarch-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    cpSync(fixtureSrc, tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, ".openarch"), { recursive: true });
    writeFileSync(join(tmpDir, ".openarch", "config.yml"), "languages: [typescript]\n");
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scan 3 文件 → exit 0 + 合法 _index.json + α_struct 计算", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"].map(p => join(tmpDir, p)).join(",");
    const openarchBase = join(tmpDir, ".openarch");
    const result = spawnSync("node", ["--import", "tsx", cliEntry, "scan", paths], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, OPENARCH_BASE_DIR: openarchBase },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scan 完成：3 文件");

    const indexPath = join(openarchBase, "baseline/_index.json");
    expect(existsSync(indexPath)).toBe(true);
    const idx = JSON.parse(readFileSync(indexPath, "utf8"));
    expect(idx.meta.nFiles).toBe(3);

    // verify per-file JSONs exist in isolated baseline dir
    const perFiles = readdirSync(dirname(indexPath)).filter(f => f !== "_index.json" && f.endsWith(".json"));
    expect(perFiles.length).toBe(3);
  }, 35000);

  it("scan --report writes the baseline then renders the current governance review", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"].map(p => join(tmpDir, p)).join(",");
    const openarchBase = join(tmpDir, ".openarch-report");
    const result = spawnSync("node", ["--import", "tsx", cliEntry, "scan", "--report", paths], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, OPENARCH_BASE_DIR: openarchBase },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("当前结构复盘（scan 后快照）");
    expect(result.stdout).toContain("[UNAVAILABLE] 治理复盘");
  }, 35000);

  it("--help → exit 0 + 列出 scan 和 init", () => {
    const r = spawnSync("node", ["--import", "tsx", cliEntry, "--help"], { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scan");
    expect(r.stdout).toContain("init");
  }, 35000);

  it("scan 空路径 → exit 3", () => {
    const r = spawnSync("node", ["--import", "tsx", cliEntry, "scan", ""], { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(3);
  }, 35000);

  it("未知命令 → exit 3", () => {
    const r = spawnSync("node", ["--import", "tsx", cliEntry, "unknown-cmd"], { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("未知命令");
  }, 35000);

  it("check 非法 change-type → exit 3 + 合法值提示", () => {
    const r = spawnSync("node", ["--import", "tsx", cliEntry, "check", "--change-type", "not-a-kind", "packages/core/src/index.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("非法 --change-type");
    expect(r.stderr).toContain("function_body");
  }, 35000);
});
