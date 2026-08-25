// Task query actions.
import { getTaskDetail, listTasks } from "@openarch/core";
import { parseOptionValue } from "../runtime";
import type { CommandHandler } from "../runtime";
import { requireAvailable, requireConfigured } from "./coordinationHelpers";

export const taskListAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const tasks = await listTasks(url, repositoryId);
  if (tasks.length === 0) {
    console.log("当前没有任务。");
    return 0;
  }
  for (const task of tasks) {
    const scope = `${task.task.repositoryId}/${task.task.serviceId}/${task.task.taskId}`;
    const claimedBy = task.status.claimedBy ? ` claimedBy=${task.status.claimedBy}` : "";
    const completedBy = task.status.completedBy ? ` completedBy=${task.status.completedBy}` : "";
    console.log(`${scope}  state=${task.status.state}${claimedBy}${completedBy}  title=${task.title}`);
  }
  return 0;
};

export const taskShowAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  if (!repositoryId || !serviceId || !taskId) {
    console.error("用法: openarch coordination task show --repository-id <id> --service-id <id> --task-id <id>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const detail = await getTaskDetail(url, { repositoryId, serviceId, taskId });
  console.log(`${detail.task.repositoryId}/${detail.task.serviceId}/${detail.task.taskId}`);
  console.log(`  状态: ${detail.status.state}`);
  console.log(`  标题: ${detail.title}`);
  console.log(`  假设: ${detail.hypothesis}`);
  console.log(`  发起人: ${detail.requestedBy}`);
  console.log(`  proposalSha256: ${detail.proposalSha256}`);
  if (detail.dependsOn?.length) {
    console.log(`  依赖: ${detail.dependsOn.map((ref) => `${ref.repositoryId}/${ref.serviceId}/${ref.taskId}`).join(", ")}`);
  }
  if (detail.goal) console.log(`  目标: ${detail.goal}`);
  if (detail.scope?.length) console.log(`  范围: ${detail.scope.join(", ")}`);
  if (detail.constraints?.length) console.log(`  约束: ${detail.constraints.join(", ")}`);
  if (detail.verification?.length) console.log(`  验证: ${detail.verification.join(", ")}`);
  if (detail.deliverable) console.log(`  交付: ${detail.deliverable}`);
  if (detail.status.claimedBy) console.log(`  claimedBy: ${detail.status.claimedBy}`);
  if (detail.status.completedBy) console.log(`  completedBy: ${detail.status.completedBy}`);
  if (detail.status.completedHeadSHA) console.log(`  completedHeadSHA: ${detail.status.completedHeadSHA}`);
  console.log("  事件链:");
  for (const event of detail.events) {
    const extra = event.type === "claimed"
      ? ` claimedBy=${event.claimedBy ?? ""}`
      : event.type === "completed_local"
        ? ` completedBy=${event.completedBy ?? ""}`
        : event.type === "completed"
          ? ` completedBy=${event.completedBy ?? ""}`
          : "";
    console.log(`    #${event.sequence} ${event.type}${extra}`);
    console.log(`      eventHash=${event.eventHash}`);
    console.log(`      prevEventHash=${event.prevEventHash}`);
    console.log(`      recordedAt=${event.recordedAt} signerKeyId=${event.signerKeyId}`);
  }
  return 0;
};
