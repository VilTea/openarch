#!/usr/bin/env node
// 本地协作测试：同一项目两个 worktree + 两个脚本化 Agent
// 验证协调服务完整闭环：scope -> task submit -> claim -> lease -> 编码提交 -> evidence -> complete
// 外加同文件抢锁场景。
//
// 前提：
//   - git 在 PATH
//   - go 在 PATH（或设置 GO_BIN）
//   - 仓库根目录已 pnpm install（CLI 通过 packages/cli/bin/openarch.js 运行）
// 用法：
//   node scripts/local-collaboration-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(repoRoot, "packages", "cli", "bin", "openarch.js");
const goBin = process.env.GO_BIN
  || (process.platform === "win32" && existsSync("E:\\workspace\\llm\\.tools\\go\\bin\\go.exe")
    ? "E:\\workspace\\llm\\.tools\\go\\bin\\go.exe"
    : "go");
const port = Number(process.env.OPENARCH_COORD_PORT || 39321);
const baseUrl = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return runOk("git", args, { cwd, ...options });
}

function cli(cwd, args, options = {}) {
  return runOk(process.execPath, [cliBin, ...args], { cwd, ...options });
}

function cliAllowFail(cwd, args, options = {}) {
  return run(process.execPath, [cliBin, ...args], { cwd, ...options });
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

function evidencePayload(ruleId) {
  return {
    schemaVersion: "2",
    projectToken: "repo-collab",
    observedAt: "2026-08-22T00:00:00Z",
    window: { startedAt: "2026-08-22T00:00:00Z", endedAt: "2026-08-22T01:00:00Z" },
    openarchVersion: "0.1.5",
    languages: ["typescript"],
    provider: { id: "typescript-vitest", version: "1" },
    ruleId,
    authorityId: "collab-e2e",
    findingCount: 1,
    policyVerdict: "WARN",
    confirmedFalsePositiveCount: 0,
    confirmedFalseNegativeCount: 0,
    evidenceLevel: "observed",
  };
}

async function waitForService(service, log) {
  for (let i = 0; i < 60; i += 1) {
    if (service.exitCode !== null) {
      throw new Error(`coordination service exited early\n${log}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`coordination service did not become ready\n${log}`);
}

function docsHead(docsRepo) {
  return git(docsRepo, ["rev-parse", "HEAD"]).stdout.trim();
}

function commitDocs(docsRepo, message) {
  git(docsRepo, ["add", "-A"]);
  git(docsRepo, ["commit", "-m", message]);
  return docsHead(docsRepo);
}

function refresh(wt, repoId, head) {
  cli(wt, ["coordination", "refresh", "--repository-id", repoId, "--branch", "main", "--head-sha", head]);
}

function writeProposal(docsRepo, serviceId, taskId, title, requestedBy, dependsOn = []) {
  const file = path.join(docsRepo, "tasks", "repo-collab", serviceId, taskId, "proposal.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schemaVersion: "1",
    task: { repositoryId: "repo-collab", serviceId, taskId },
    title,
    hypothesis: "local collaboration e2e validates coordination service",
    requestedBy,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  }, null, 2) + "\n");
  return file;
}

function pushWithRebase(wt, message, files) {
  git(wt, ["add", ...files]);
  git(wt, ["commit", "-m", message]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const push = run("git", ["push", "origin", "main"], { cwd: wt, encoding: "utf8" });
    if (push.status === 0) return;
    const pull = run("git", ["pull", "--rebase", "origin", "main"], { cwd: wt, encoding: "utf8" });
    if (pull.status !== 0) {
      throw new Error(`git rebase failed\nstdout: ${pull.stdout}\nstderr: ${pull.stderr}`);
    }
  }
  throw new Error(`git push did not succeed after rebase retries in ${wt}`);
}

function buildService(work) {
  const binDir = path.join(work, "bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, process.platform === "win32" ? "openarch-coordination.exe" : "openarch-coordination");
  runOk(goBin, ["build", "-o", binPath, "./cmd/openarch-coordination"], { cwd: path.join(repoRoot, "services", "coordination") });
  return binPath;
}

function initDocsRepo(work) {
  const docsRepo = path.join(work, "docs-repo");
  mkdirSync(docsRepo);
  git(docsRepo, ["init", "--initial-branch=main"]);
  git(docsRepo, ["config", "user.name", "Collab Test"]);
  git(docsRepo, ["config", "user.email", "collab@example.invalid"]);
  writeFileSync(path.join(docsRepo, "README.md"), "# docs\n");
  git(docsRepo, ["add", "README.md"]);
  git(docsRepo, ["commit", "-m", "bootstrap docs-repo"]);
  return docsRepo;
}

function startService(work, binPath, docsRepo, onLog) {
  const keyPath = path.join(work, "signing.key");
  const seed = createHash("sha256").update(`collab-${Date.now()}`).digest("base64").replace(/=+$/g, "");
  writeFileSync(keyPath, seed);
  const service = spawn(binPath, [
    "--docs-repo", docsRepo,
    "--git-branch", "main",
    "--task-signing-key", keyPath,
    "--listen", `127.0.0.1:${port}`,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  service.stdout.on("data", (chunk) => onLog(chunk.toString()));
  service.stderr.on("data", (chunk) => onLog(chunk.toString()));
  return service;
}

function initProjectRepo(work) {
  const initialProject = path.join(work, "initial-project");
  const projectBare = path.join(work, "project.git");
  const wtA = path.join(work, "wt-a");
  const wtB = path.join(work, "wt-b");
  mkdirSync(initialProject);
  mkdirSync(path.join(initialProject, "src"), { recursive: true });
  writeFileSync(path.join(initialProject, "src", "feature_a.ts"), "export function placeholderA(): void {}\n");
  writeFileSync(path.join(initialProject, "src", "feature_b.ts"), "export function placeholderB(): void {}\n");
  writeFileSync(path.join(initialProject, "src", "shared.ts"), "export const shared = true;\n");
  git(initialProject, ["init", "--initial-branch=main"]);
  git(initialProject, ["config", "user.name", "Initial"]);
  git(initialProject, ["config", "user.email", "initial@example.invalid"]);
  git(initialProject, ["add", "-A"]);
  git(initialProject, ["commit", "-m", "chore: initial project"]);
  runOk("git", ["clone", "--bare", initialProject, projectBare]);
  runOk("git", ["clone", projectBare, wtA]);
  runOk("git", ["clone", projectBare, wtB]);
  for (const wt of [wtA, wtB]) {
    git(wt, ["config", "user.name", wt === wtA ? "Agent A" : "Agent B"]);
    git(wt, ["config", "user.email", wt === wtA ? "agent-a@example.invalid" : "agent-b@example.invalid"]);
  }
  return { projectBare, wtA, wtB };
}

function initAgents(wtA, wtB, docsRepo) {
  cli(wtA, ["init", "--docs-repo", docsRepo, "--coordination-url", baseUrl, "--lang", "zh"]);
  cli(wtB, ["init", "--docs-repo", docsRepo, "--coordination-url", baseUrl, "--lang", "zh"]);
}

function registerScopes(docsRepo, wtA, wtB) {
  cli(wtA, ["coordination", "scope", "register", "--repository-id", "repo-collab", "--service-id", "svc-a"]);
  cli(wtB, ["coordination", "scope", "register", "--repository-id", "repo-collab", "--service-id", "svc-b"]);
  const head = commitDocs(docsRepo, "collab: register svc-a and svc-b");
  refresh(wtA, "repo-collab", head);
}

function submitTasks(docsRepo, wtA, wtB) {
  writeProposal(docsRepo, "svc-a", "task-edit-a", "Implement featureA", "agent-a");
  writeProposal(docsRepo, "svc-b", "task-edit-b", "Implement featureB", "agent-b", [{ repositoryId: "repo-collab", serviceId: "svc-a", taskId: "task-edit-a" }]);
  const head = commitDocs(docsRepo, "collab: add task proposals");
  refresh(wtA, "repo-collab", head);
  cli(wtA, ["coordination", "task", "submit", "--repository-id", "repo-collab", "--service-id", "svc-a", "--task-id", "task-edit-a", "--branch", "main", "--head-sha", head]);
  cli(wtB, ["coordination", "task", "submit", "--repository-id", "repo-collab", "--service-id", "svc-b", "--task-id", "task-edit-b", "--branch", "main", "--head-sha", head]);
}

function runAgent(ctx, serviceId, taskId, agent, targetFile, featureCode, commitMessage, ruleId) {
  const { wt, work } = ctx;
  const leaseTarget = `file:${targetFile}`;
  cli(wt, ["coordination", "task", "wait", "--repository-id", "repo-collab", "--service-id", serviceId, "--task-id", taskId, "--timeout", "30", "--interval", "2"]);
  cli(wt, ["coordination", "claim", "--repository-id", "repo-collab", "--service-id", serviceId, "--task-id", taskId, "--claimed-by", agent]);
  const leaseOut = cli(wt, ["coordination", "lease", "acquire", "--repository-id", "repo-collab", "--target", leaseTarget, "--owner", agent, "--ttl", "60"]).stdout;
  const lease = parseLeaseCredential(leaseOut);
  appendFileSync(path.join(wt, targetFile), featureCode);
  pushWithRebase(wt, commitMessage, [targetFile]);
  const evidence = path.join(work, `evidence-${agent}.json`);
  writeFileSync(evidence, JSON.stringify(evidencePayload(ruleId), null, 2) + "\n");
  cli(wt, ["coordination", "evidence", "upload", evidence]);
  cli(wt, ["coordination", "task", "complete-local", "--repository-id", "repo-collab", "--service-id", serviceId, "--task-id", taskId, "--completed-by", agent, "--target", leaseTarget, "--lease-id", lease.leaseId]);
  cli(wt, ["coordination", "complete", "--repository-id", "repo-collab", "--service-id", serviceId, "--task-id", taskId, "--completed-by", agent, "--target", leaseTarget, "--lease-id", lease.leaseId]);
  cli(wt, ["coordination", "lease", "release", "--lease-id", lease.leaseId, "--owner", agent, "--fencing-token", String(lease.fencingToken), "--epoch", String(lease.coordinatorEpoch)]);
}

function runLockContention(ctx) {
  const { wtA, wtB } = ctx;
  const sharedTarget = "file:src/shared.ts";
  const sharedAOut = cli(wtA, ["coordination", "lease", "acquire", "--repository-id", "repo-collab", "--target", sharedTarget, "--owner", "agent-a", "--ttl", "60"]).stdout;
  const sharedA = parseLeaseCredential(sharedAOut);
  const blocked = cliAllowFail(wtB, ["coordination", "lease", "acquire", "--repository-id", "repo-collab", "--target", sharedTarget, "--owner", "agent-b", "--ttl", "60"]);
  ctx.check(blocked.status !== 0, "冲突 acquire 被拒绝");
  cli(wtA, ["coordination", "lease", "release", "--lease-id", sharedA.leaseId, "--owner", "agent-a", "--fencing-token", String(sharedA.fencingToken), "--epoch", String(sharedA.coordinatorEpoch)]);
  const sharedBOut = cli(wtB, ["coordination", "lease", "acquire", "--repository-id", "repo-collab", "--target", sharedTarget, "--owner", "agent-b", "--ttl", "60"]).stdout;
  const sharedB = parseLeaseCredential(sharedBOut);
  cli(wtB, ["coordination", "lease", "release", "--lease-id", sharedB.leaseId, "--owner", "agent-b", "--fencing-token", String(sharedB.fencingToken), "--epoch", String(sharedB.coordinatorEpoch)]);
  ctx.check(true, "释放后可重获");
}

async function runAssertions(ctx) {
  const { wtA, wtB, docsRepo, projectBare } = ctx;
  const showA = cli(wtA, ["coordination", "task", "show", "--repository-id", "repo-collab", "--service-id", "svc-a", "--task-id", "task-edit-a"]).stdout;
  const showB = cli(wtB, ["coordination", "task", "show", "--repository-id", "repo-collab", "--service-id", "svc-b", "--task-id", "task-edit-b"]).stdout;
  ctx.check(showA.includes("completed"), "task-edit-a completed", showA);
  ctx.check(showB.includes("completed"), "task-edit-b completed", showB);

  const projectLog = run("git", ["--git-dir", projectBare, "log", "--oneline", "main"], { encoding: "utf8" }).stdout;
  ctx.check(projectLog.includes("feat: implement featureA"), "featureA 已进入 project main", projectLog);
  ctx.check(projectLog.includes("feat: implement featureB"), "featureB 已进入 project main", projectLog);

  const eventsA = path.join(docsRepo, "coordination", "tasks", "repo-collab", "svc-a", "task-edit-a", "events.ndjson");
  const eventsB = path.join(docsRepo, "coordination", "tasks", "repo-collab", "svc-b", "task-edit-b", "events.ndjson");
  ctx.check(existsSync(eventsA) && readFileSync(eventsA, "utf8").includes('"type":"completed"'), "svc-a 事件链含 completed");
  ctx.check(existsSync(eventsB) && readFileSync(eventsB, "utf8").includes('"type":"completed"'), "svc-b 事件链含 completed");

  const calA = await fetch(`${baseUrl}/v1/calibrations/${encodeURIComponent("typescript-vitest")}/${encodeURIComponent("collab.e2e-a")}/${encodeURIComponent("collab-e2e")}`);
  const calB = await fetch(`${baseUrl}/v1/calibrations/${encodeURIComponent("typescript-vitest")}/${encodeURIComponent("collab.e2e-b")}/${encodeURIComponent("collab-e2e")}`);
  ctx.check(calA.ok && calB.ok, "evidence 校准可读", `A=${calA.status} B=${calB.status}`);
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "oa-collab-"));
  let service;
  let serviceLog = "";
  const ctx = { work };
  let failures = 0;
  ctx.check = (condition, label, detail = "") => {
    if (condition) {
      console.log(`  ✓ ${label}`);
    } else {
      failures += 1;
      console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  try {
    console.log(`### 本地协作测试工作区: ${work}`);
    const binPath = buildService(work);
    ctx.docsRepo = initDocsRepo(work);
    ctx.wtA = undefined;
    ctx.wtB = undefined;
    ctx.projectBare = undefined;
    console.log("== 构建并启动 coordination 服务 ==");
    service = startService(work, binPath, ctx.docsRepo, (chunk) => { serviceLog += chunk; });
    await waitForService(service, () => serviceLog);

    console.log("== 初始化项目仓库 ==");
    const project = initProjectRepo(work);
    ctx.projectBare = project.projectBare;
    ctx.wtA = project.wtA;
    ctx.wtB = project.wtB;
    ctx.check(true, "project.git + wt-a + wt-b ready");

    console.log("== 初始化两个 OpenArch 项目 ==");
    initAgents(ctx.wtA, ctx.wtB, ctx.docsRepo);
    ctx.check(true, "两个项目已关联 docs-repo 与协调服务");

    console.log("== Scope 登记 ==");
    registerScopes(ctx.docsRepo, ctx.wtA, ctx.wtB);
    ctx.check(true, "scope 已登记并刷新");

    console.log("== Task 提案与提交 ==");
    submitTasks(ctx.docsRepo, ctx.wtA, ctx.wtB);
    ctx.check(true, "两个 task 已 verified");

    console.log("== Agent A 主流程 ==");
    runAgent({ ...ctx, wt: ctx.wtA }, "svc-a", "task-edit-a", "agent-a", "src/feature_a.ts", "export function featureA(): string { return 'A'; }\n", "feat: implement featureA", "collab.e2e-a");
    ctx.check(true, "Agent A 完成");

    console.log("== Agent B 主流程 ==");
    runAgent({ ...ctx, wt: ctx.wtB }, "svc-b", "task-edit-b", "agent-b", "src/feature_b.ts", "export function featureB(): string { return 'B'; }\n", "feat: implement featureB", "collab.e2e-b");
    ctx.check(true, "Agent B 完成");

    console.log("== 同文件抢锁 ==");
    runLockContention(ctx);

    console.log("== 最终断言 ==");
    await runAssertions(ctx);

    console.log();
    if (failures === 0) {
      console.log("### 本地协作测试全部通过");
      return 0;
    }
    console.log(`### 本地协作测试失败 ${failures} 项`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (serviceLog) console.error(`--- coordination service log ---\n${serviceLog}`);
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
