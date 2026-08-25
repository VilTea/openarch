#!/usr/bin/env node
// 验证 Agent 遇到语义锁时的两种正确行为：
//   W: 等待锁释放后获取（客户端 --wait 轮询，服务端仍快速失败）
//   D: 先搁置该任务去做其他事，稍后重试获取
//
// 用法：
//   node scripts/lock-wait-defer-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(repoRoot, "packages", "cli", "bin", "openarch.js");
const goBin = process.env.GO_BIN
  || (process.platform === "win32" && existsSync("E:\\workspace\\llm\\.tools\\go\\bin\\go.exe")
    ? "E:\\workspace\\llm\\.tools\\go\\bin\\go.exe"
    : "go");
const port = Number(process.env.OPENARCH_COORD_PORT || 39323);
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

function cli(cwd, args, options = {}) {
  return runOk(process.execPath, [cliBin, ...args], { cwd, ...options });
}

function cliAllowFail(cwd, args, options = {}) {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: "utf8", windowsHide: true, ...options });
  return result;
}

async function waitForService(service) {
  for (let i = 0; i < 60; i += 1) {
    if (service.exitCode !== null) throw new Error("coordination service exited early");
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error("coordination service did not become ready");
}

function parseLeaseCredential(output) {
  const leaseId = output.match(/leaseId=(\S+)/)?.[1];
  const fencingToken = Number(output.match(/fencingToken=(\d+)/)?.[1]);
  const coordinatorEpoch = Number(output.match(/epoch=(\d+)/)?.[1]);
  if (!leaseId || !Number.isFinite(fencingToken) || !Number.isFinite(coordinatorEpoch)) {
    throw new Error(`cannot parse lease credential from: ${output}`);
  }
  return { leaseId, fencingToken, coordinatorEpoch };
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "oa-lock-wait-defer-"));
  const docsRepo = path.join(work, "docs-repo");
  const project = path.join(work, "project");
  const binDir = path.join(work, "bin");
  let service;
  let failures = 0;
  const check = (condition, label, detail = "") => {
    if (condition) {
      console.log(`  ✓ ${label}`);
    } else {
      failures += 1;
      console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  try {
    console.log(`### 语义锁等待/搁置验证工作区: ${work}`);
    mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, process.platform === "win32" ? "openarch-coordination.exe" : "openarch-coordination");
    runOk(goBin, ["build", "-o", binPath, "./cmd/openarch-coordination"], { cwd: path.join(repoRoot, "services", "coordination") });

    mkdirSync(docsRepo);
    runOk("git", ["init", "--initial-branch=main"], { cwd: docsRepo });
    runOk("git", ["config", "user.name", "Lock Test"], { cwd: docsRepo });
    runOk("git", ["config", "user.email", "lock@example.invalid"], { cwd: docsRepo });
    writeFileSync(path.join(docsRepo, "README.md"), "# docs\n");
    runOk("git", ["add", "README.md"], { cwd: docsRepo });
    runOk("git", ["commit", "-m", "bootstrap docs-repo"], { cwd: docsRepo });

    service = spawn(binPath, [
      "--docs-repo", docsRepo,
      "--git-branch", "main",
      "--listen", `127.0.0.1:${port}`,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let serviceLog = "";
    service.stdout.on("data", (chunk) => { serviceLog += chunk.toString(); });
    service.stderr.on("data", (chunk) => { serviceLog += chunk.toString(); });
    await waitForService(service);

    mkdirSync(project);
    cli(project, ["init", "--docs-repo", docsRepo, "--coordination-url", baseUrl, "--lang", "zh"]);

    console.log("== 场景 W：Agent B 等待锁释放 ==");
    const acquireA = cli(project, ["coordination", "lease", "acquire", "--repository-id", "repo-openarch", "--target", "file:src/wait.ts", "--owner", "agent-a", "--ttl", "60"]);
    const leaseA = parseLeaseCredential(acquireA.stdout);
    const waitB = spawn(process.execPath, [cliBin, "coordination", "lease", "acquire", "--repository-id", "repo-openarch", "--target", "file:src/wait.ts", "--owner", "agent-b", "--ttl", "60", "--wait", "15"], {
      cwd: project,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let waitBOut = "";
    waitB.stdout.on("data", (chunk) => { waitBOut += chunk.toString(); });
    waitB.stderr.on("data", (chunk) => { waitBOut += chunk.toString(); });
    await sleep(2000);
    cli(project, ["coordination", "lease", "release", "--lease-id", leaseA.leaseId, "--owner", "agent-a", "--fencing-token", String(leaseA.fencingToken), "--epoch", String(leaseA.coordinatorEpoch)]);
    const waitBCode = await new Promise((resolve) => waitB.on("close", resolve));
    check(waitBCode === 0 && waitBOut.includes("已获取语义锁"), "等待后成功获取锁", `exit=${waitBCode} out=${waitBOut}`);

    console.log("== 场景 D：Agent B 先搁置做其他任务，再重试 ==");
    const acquireA2 = cli(project, ["coordination", "lease", "acquire", "--repository-id", "repo-openarch", "--target", "file:src/defer.ts", "--owner", "agent-a", "--ttl", "60"]);
    const leaseA2 = parseLeaseCredential(acquireA2.stdout);
    const deferFail = cliAllowFail(project, ["coordination", "lease", "acquire", "--repository-id", "repo-openarch", "--target", "file:src/defer.ts", "--owner", "agent-b", "--ttl", "60"]);
    check(deferFail.status !== 0, "冲突时快速失败（不阻塞）", `exit=${deferFail.status}`);
    // Agent B 搁置该任务，先做一件不依赖锁的事。
    writeFileSync(path.join(project, "other-task.txt"), "agent-b did other work\n");
    check(existsSync(path.join(project, "other-task.txt")), "搁置期间完成其他任务");
    cli(project, ["coordination", "lease", "release", "--lease-id", leaseA2.leaseId, "--owner", "agent-a", "--fencing-token", String(leaseA2.fencingToken), "--epoch", String(leaseA2.coordinatorEpoch)]);
    const deferRetry = cli(project, ["coordination", "lease", "acquire", "--repository-id", "repo-openarch", "--target", "file:src/defer.ts", "--owner", "agent-b", "--ttl", "60"]);
    check(deferRetry.status === 0, "释放后重试成功");

    console.log();
    if (failures === 0) {
      console.log("### 语义锁等待/搁置验证全部通过");
      return 0;
    }
    console.log(`### 语义锁等待/搁置验证失败 ${failures} 项`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (service && service.exitCode === null) {
      service.kill();
      await sleep(500);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
