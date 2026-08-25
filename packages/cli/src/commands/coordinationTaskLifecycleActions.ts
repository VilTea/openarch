// Task lifecycle actions: submit, claim, complete-local, complete, sync, wait.
import { claimTask, completeLocalTask, completeTask, execFileHidden, getTaskDetail, submitTask } from "@openarch/core";
import { parseOptionValue } from "../runtime";
import type { CommandHandler } from "../runtime";
import { currentBranch, gitRevParse, requireAvailable, requireConfigured } from "./coordinationHelpers";

export const taskSubmitAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const branch = parseOptionValue(args, "--branch");
  const headSha = parseOptionValue(args, "--head-sha");
  if (!repositoryId || !serviceId || !taskId || !branch || !headSha) {
    console.error("用法: openarch coordination task submit --repository-id <id> --service-id <id> --task-id <id> --branch <branch> --head-sha <sha>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const result = await submitTask(url, { repositoryId, serviceId, taskId, branch, headSha });
  console.log(`task ${taskId} ${result.created ? "已创建" : "已存在"}：状态 ${result.status.state}`);
  return 0;
};

export const taskClaimAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const proposalSha256 = parseOptionValue(args, "--proposal-sha256");
  const claimedBy = parseOptionValue(args, "--claimed-by");
  if (!repositoryId || !serviceId || !taskId || !claimedBy) {
    console.error("用法: openarch coordination task claim --repository-id <id> --service-id <id> --task-id <id> [--proposal-sha256 <sha>] --claimed-by <executor>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const resolvedProposal = proposalSha256 ?? (await getTaskDetail(url, { repositoryId, serviceId, taskId })).proposalSha256;
  const result = await claimTask(url, { repositoryId, serviceId, taskId, proposalSha256: resolvedProposal, claimedBy });
  console.log(`task ${taskId} ${result.created ? "已认领" : "已存在"}：状态 ${result.status.state}${result.status.claimedBy ? ` 执行者 ${result.status.claimedBy}` : ""}`);
  return 0;
};

export const taskCompleteLocalAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const proposalSha256 = parseOptionValue(args, "--proposal-sha256");
  const completedBy = parseOptionValue(args, "--completed-by");
  const target = parseOptionValue(args, "--target");
  const leaseId = parseOptionValue(args, "--lease-id");
  if (!repositoryId || !serviceId || !taskId || !completedBy || !target || !leaseId) {
    console.error("用法: openarch coordination task complete-local --repository-id <id> --service-id <id> --task-id <id> [--proposal-sha256 <sha>] --completed-by <executor> --target <target> --lease-id <leaseId>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const resolvedProposal = proposalSha256 ?? (await getTaskDetail(url, { repositoryId, serviceId, taskId })).proposalSha256;
  const localHeadSHA = gitRevParse(context.cwd, "HEAD");
  const result = await completeLocalTask(url, { repositoryId, serviceId, taskId, proposalSha256: resolvedProposal, completedBy, localHeadSHA, target, leaseId });
  console.log(`task ${taskId} ${result.created ? "已本地办结" : "已存在"}：状态 ${result.status.state}${result.status.completedBy ? ` 执行者 ${result.status.completedBy}` : ""}`);
  return 0;
};

export const taskCompleteAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const proposalSha256 = parseOptionValue(args, "--proposal-sha256");
  const completedBy = parseOptionValue(args, "--completed-by");
  const target = parseOptionValue(args, "--target");
  const leaseId = parseOptionValue(args, "--lease-id");
  if (!repositoryId || !serviceId || !taskId || !completedBy || !target || !leaseId) {
    console.error("用法: openarch coordination task complete --repository-id <id> --service-id <id> --task-id <id> [--proposal-sha256 <sha>] --completed-by <executor> --target <target> --lease-id <leaseId>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const branch = currentBranch(context.cwd);
  const localHead = gitRevParse(context.cwd, "HEAD");
  const remoteHead = gitRevParse(context.cwd, `origin/${branch}`);
  if (localHead !== remoteHead) {
    console.error(`最终完成要求本地 HEAD 已 push：本地 ${localHead} != origin/${branch} ${remoteHead}；请先 push 再 complete。`);
    return 3;
  }
  const resolvedProposal = proposalSha256 ?? (await getTaskDetail(url, { repositoryId, serviceId, taskId })).proposalSha256;
  const result = await completeTask(url, { repositoryId, serviceId, taskId, proposalSha256: resolvedProposal, completedBy, completedHeadSHA: remoteHead, target, leaseId });
  console.log(`task ${taskId} ${result.created ? "已完成" : "已存在"}：状态 ${result.status.state}${result.status.completedBy ? ` 执行者 ${result.status.completedBy}` : ""}`);
  return 0;
};

export const taskSyncAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  if (!repositoryId || !serviceId || !taskId) {
    console.error("用法: openarch coordination task sync --repository-id <id> --service-id <id> --task-id <id>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const detail = await getTaskDetail(url, { repositoryId, serviceId, taskId });
  const head = detail.status.completedHeadSHA;
  if (detail.status.state !== "completed" || !head) {
    console.error("任务尚未最终完成，没有可同步的 completedHeadSHA。");
    return 3;
  }
  execFileHidden("git", ["fetch", "origin"], { cwd: context.cwd, stdio: "inherit" });
  execFileHidden("git", ["rev-parse", "--verify", `${head}^{commit}`], { cwd: context.cwd, encoding: "utf8" });
  const current = gitRevParse(context.cwd, "HEAD");
  if (current !== head) {
    execFileHidden("git", ["checkout", head], { cwd: context.cwd, stdio: "inherit" });
  }
  console.log(`task ${taskId} 已同步到 ${head}`);
  return 0;
};

export const taskWaitAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const timeoutSeconds = Number(parseOptionValue(args, "--timeout") ?? "300");
  const intervalSeconds = Number(parseOptionValue(args, "--interval") ?? "5");
  if (!repositoryId || !serviceId || !taskId || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    console.error("用法: openarch coordination task wait --repository-id <id> --service-id <id> --task-id <id> [--timeout <seconds>] [--interval <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const detail = await getTaskDetail(url, { repositoryId, serviceId, taskId });
    const dependencies = detail.dependsOn ?? [];
    const pending: string[] = [];
    for (const dependency of dependencies) {
      const dep = await getTaskDetail(url, dependency);
      if (dep.status.state !== "completed") {
        pending.push(`${dependency.repositoryId}/${dependency.serviceId}/${dependency.taskId}=${dep.status.state}`);
      }
    }
    if (pending.length === 0) {
      console.log(`task ${taskId} 依赖已全部完成，可以认领`);
      return 0;
    }
    if (Date.now() >= deadline) {
      console.error(`等待超时，仍有未完成依赖: ${pending.join(", ")}`);
      return 3;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
};
