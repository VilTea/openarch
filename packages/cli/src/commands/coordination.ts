// packages/cli/src/commands/coordination.ts
// `openarch coordination` command family: status + bootstrap/refresh/scope/evidence/task.
// Unavailable/not-configured states fail closed (exit 3) with the reason printed.
import { exitCodeFromError } from "../exit-code";
import { collectCoordinationContext } from "../coordinationContext";
import { printAnalysisError } from "../runtime";
import type { CommandHandler } from "../runtime";
import { bootstrapAction, evidenceUploadAction, leaseAcquireAction, leaseReleaseAction, leaseRenewAction, refreshAction, scopeRegisterAction, taskClaimAction, taskCompleteAction, taskSubmitAction } from "./coordinationActions";

const usage = "用法: openarch coordination <status|bootstrap|refresh|scope|evidence|task|claim|complete|lease> [...]";

const statusAction: CommandHandler = async (args, context) => {
  const coordination = await collectCoordinationContext(context.cwd);
  if (args.includes("--json")) {
    console.log(JSON.stringify(coordination, null, 2));
    return coordination.state === "available" ? 0 : 3;
  }
  if (coordination.state !== "available") {
    console.error(`协调服务未配置或不可用：${coordination.detail}`);
    return 3;
  }
  console.log(`协调服务: ${coordination.state}`);
  console.log(`原因: ${coordination.detail}`);
  if (coordination.remoteUrl) console.log(`remoteUrl: ${coordination.remoteUrl}`);
  if (coordination.branch) console.log(`branch: ${coordination.branch}`);
  if (coordination.headSha) console.log(`headSha: ${coordination.headSha}`);
  return 0;
};

const actionHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
  status: statusAction,
  bootstrap: bootstrapAction,
  refresh: refreshAction,
  evidence: evidenceUploadAction,
  task: taskSubmitAction,
  claim: taskClaimAction,
  complete: taskCompleteAction,
};

export const coordinationCommand: CommandHandler = async (args, context) => {
  const [action, ...rest] = args;
  if (action === "scope") {
    const [sub, ...subRest] = rest;
    if (sub !== "register") {
      console.error(usage);
      return 3;
    }
    try {
      return await scopeRegisterAction(subRest, context);
    } catch (error) {
      printAnalysisError(error, context.locale);
      return exitCodeFromError(error);
    }
  }
  if (action === "lease") {
    const [sub, ...subRest] = rest;
    const leaseHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
      acquire: leaseAcquireAction,
      renew: leaseRenewAction,
      release: leaseReleaseAction,
    };
    const leaseHandler = leaseHandlers[sub ?? ""];
    if (!leaseHandler) {
      console.error("用法: openarch coordination lease <acquire|renew|release> [...]");
      return 3;
    }
    try {
      return await leaseHandler(subRest, context);
    } catch (error) {
      printAnalysisError(error, context.locale);
      return exitCodeFromError(error);
    }
  }
  const handler = actionHandlers[action ?? ""];
  if (!handler) {
    console.error(usage);
    return 3;
  }
  try {
    return await handler(rest, context);
  } catch (error) {
    printAnalysisError(error, context.locale);
    return exitCodeFromError(error);
  }
};
