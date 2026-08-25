// Task creation action.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { statusDocsRepo } from "@openarch/core";
import type { CommandHandler } from "../runtime";

export const taskCreateAction: CommandHandler = async (args, context) => {
  const specFile = args[0];
  if (!specFile) {
    console.error("用法: openarch coordination task create <task-spec.json>");
    return 3;
  }
  let proposal: any;
  try {
    proposal = JSON.parse(readFileSync(specFile, "utf8"));
  } catch (error) {
    console.error(`无法读取 task spec ${specFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
  const repositoryId = proposal?.task?.repositoryId;
  const serviceId = proposal?.task?.serviceId;
  const taskId = proposal?.task?.taskId;
  if (!repositoryId || !serviceId || !taskId || !proposal?.title || !proposal?.hypothesis || !proposal?.requestedBy) {
    console.error("task spec 必须包含 task.repositoryId/serviceId/taskId、title、hypothesis、requestedBy");
    return 3;
  }
  const docsRepo = statusDocsRepo(context.cwd).config?.target;
  if (!docsRepo) {
    console.error("task create 需要先关联协作文档仓库：`openarch init --docs-repo <url|path>`");
    return 3;
  }
  const normalized = {
    schemaVersion: "1",
    ...proposal,
  };
  const target = join(docsRepo, "tasks", repositoryId, serviceId, taskId, "proposal.json");
  if (existsSync(target)) {
    console.error(`Task proposal 已存在（拒绝覆盖）：${target}`);
    return 3;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(normalized, null, 2) + "\n");
  console.log(`Task proposal 已生成：${target}`);
  console.log("commit + push 后运行 `openarch coordination task submit --repository-id <id> --service-id <id> --task-id <id> --branch <b> --head-sha <sha>`");
  return 0;
};
