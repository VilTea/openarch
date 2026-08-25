#!/usr/bin/env node
// 准备 subagent 本地协作 dogfood 环境：
//   - 临时 worktree（当前 OpenArch 仓库的 bare 镜像 + 两个 clone）
//   - local 模式 coordination 服务（detached，脚本退出后继续运行）
//   - 两个 OpenArch 项目已关联 docs-repo 与协调服务
// 不注册 scope/proposal——这些由 subagent 在协调闭环中自行完成。
//
// 用法：
//   node scripts/setup-subagent-collab.mjs
// 输出：
//   state.json 路径（含 work/docsRepo/wt-core/wt-cli/port/pid 等）
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = process.env.OPENARCH_CLI_BIN
  || path.join(repoRoot, "packages", "cli", "bin", "openarch.js");
const goBin = process.env.GO_BIN
  || (process.platform === "win32" && existsSync("E:\\workspace\\llm\\.tools\\go\\bin\\go.exe")
    ? "E:\\workspace\\llm\\.tools\\go\\bin\\go.exe"
    : "go");
const port = Number(process.env.OPENARCH_COORD_PORT || 39322);
const baseUrl = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runOk(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return runOk("git", args, { cwd, ...options });
}

function cli(cwd, args) {
  return cliBin.endsWith(".js")
    ? runOk(process.execPath, [cliBin, ...args], { cwd })
    : runOk(cliBin, args, { cwd });
}

function linkNodeModules(target) {
  const source = path.join(repoRoot, "node_modules");
  const dest = path.join(target, "node_modules");
  if (!existsSync(source)) {
    throw new Error(`主仓库 node_modules 不存在: ${source}（先运行 pnpm install）`);
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  if (!existsSync(dest)) {
    symlinkSync(source, dest, type);
  }
  const packagesDir = path.join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return;
  for (const name of readdirSync(packagesDir)) {
    const pkgSource = path.join(packagesDir, name, "node_modules");
    const pkgDest = path.join(target, "packages", name, "node_modules");
    if (existsSync(pkgSource) && !existsSync(pkgDest)) {
      mkdirSync(path.dirname(pkgDest), { recursive: true });
      symlinkSync(pkgSource, pkgDest, type);
    }
  }
}

async function waitForService(pid) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`coordination service (pid ${pid}) did not become ready`);
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "oa-subagent-"));
  const docsRepo = path.join(work, "docs-repo");
  const openarchGit = path.join(work, "openarch.git");
  const wtCore = path.join(work, "wt-core");
  const wtCli = path.join(work, "wt-cli");
  const binDir = path.join(work, "bin");
  const serviceLog = path.join(work, "coordination-service.log");
  const stateFile = path.join(work, "state.json");

  console.log(`工作区: ${work}`);
  mkdirSync(binDir, { recursive: true });

  // 1. 构建 coordination 服务
  const binPath = path.join(binDir, process.platform === "win32" ? "openarch-coordination.exe" : "openarch-coordination");
  runOk(goBin, ["build", "-o", binPath, "./cmd/openarch-coordination"], { cwd: path.join(repoRoot, "services", "coordination") });

  // 2. 初始化 docs-repo
  mkdirSync(docsRepo);
  git(docsRepo, ["init", "--initial-branch=main"]);
  git(docsRepo, ["config", "user.name", "Subagent Collab"]);
  git(docsRepo, ["config", "user.email", "subagent@example.invalid"]);
  writeFileSync(path.join(docsRepo, "README.md"), "# docs\n");
  git(docsRepo, ["add", "README.md"]);
  git(docsRepo, ["commit", "-m", "bootstrap docs-repo"]);

  // 3. 启动 coordination 服务（detached，脚本退出后继续运行）
  const keyPath = path.join(work, "signing.key");
  const seed = createHash("sha256").update(`subagent-${Date.now()}`).digest("base64").replace(/=+$/g, "");
  writeFileSync(keyPath, seed);
  const service = spawn(binPath, [
    "--docs-repo", docsRepo,
    "--git-branch", "main",
    "--task-signing-key", keyPath,
    "--listen", `127.0.0.1:${port}`,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  service.unref();
  await waitForService(service.pid);
  console.log(`协调服务已就绪: ${baseUrl} (pid ${service.pid})`);

  // 4. 创建 OpenArch bare 镜像 + 两个 worktree
  runOk("git", ["clone", "--bare", repoRoot, openarchGit]);
  runOk("git", ["clone", openarchGit, wtCore]);
  runOk("git", ["clone", openarchGit, wtCli]);
  for (const [wt, name, email] of [
    [wtCore, "Subagent Core", "subagent-core@example.invalid"],
    [wtCli, "Subagent CLI", "subagent-cli@example.invalid"],
  ]) {
    git(wt, ["config", "user.name", name]);
    git(wt, ["config", "user.email", email]);
    linkNodeModules(wt);
  }
  console.log("两个 worktree 已就绪，node_modules 已链接");

  // 5. 初始化两个 OpenArch 项目
  cli(wtCore, ["init", "--docs-repo", docsRepo, "--coordination-url", baseUrl, "--lang", "zh"]);
  cli(wtCli, ["init", "--docs-repo", docsRepo, "--coordination-url", baseUrl, "--lang", "zh"]);
  console.log("两个 OpenArch 项目已初始化并关联协调服务");

  // 6. 写 state 文件供后续 cleanup/验证使用
  const state = {
    work,
    docsRepo,
    openarchGit,
    wtCore,
    wtCli,
    port,
    baseUrl,
    pid: service.pid,
    binPath,
    cliBin,
    serviceLog,
    stateFile,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  console.log(`state: ${stateFile}`);
  console.log(`wt-core: ${wtCore}`);
  console.log(`wt-cli: ${wtCli}`);
  console.log(`docs-repo: ${docsRepo}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
