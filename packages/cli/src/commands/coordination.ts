// packages/cli/src/commands/coordination.ts
// `openarch coordination` command family: status + bootstrap/refresh/scope/evidence/task.
// Unavailable/not-configured states fail closed (exit 3) with the reason printed.
import { exitCodeFromError } from "../exit-code";
import { collectCoordinationContext } from "../coordinationContext";
import { printAnalysisError } from "../runtime";
import type { CommandHandler } from "../runtime";
import { bootstrapAction, debtListAction, debtRegisterAction, evidenceUploadAction, leaseAcquireAction, leaseListAction, leaseReleaseAction, leaseRenewAction, refreshAction, scopeMigrateAction, scopeRegisterAction, sessionCloseAction, sessionHeartbeatAction, sessionListAction, sessionRegisterAction, taskClaimAction, taskCompleteAction, taskListAction, taskSubmitAction } from "./coordinationActions";

const usage = "用法: openarch coordination <status|bootstrap|refresh|scope|debt|evidence|task|claim|complete|lease|session> [...]";

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
  claim: taskClaimAction,
  complete: taskCompleteAction,
};

export const coordinationCommand: CommandHandler = async (args, context) => {
  const [action, ...rest] = args;
  if (action === "task") {
    const [maybeSub, ...subRest] = rest;
    // 向后兼容 v0.1.2 形态 `task --repository-id ...`（缺省 submit）；显式子命令为 submit/list。
    const sub = maybeSub === "submit" || maybeSub === "list" ? maybeSub : maybeSub === undefined || maybeSub.startsWith("--") ? "submit" : maybeSub;
    const taskArgs = (sub === "submit" && maybeSub !== "submit") ? rest : subRest;
    const taskHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
      submit: taskSubmitAction,
      list: taskListAction,
    };
    const taskHandler = taskHandlers[sub];
    if (!taskHandler) {
      console.error("用法: openarch coordination task <submit|list> [...]（list 支持 --repository-id <id> 过滤）");
      return 3;
    }
    try {
      return await taskHandler(taskArgs, context);
    } catch (error) {
      printAnalysisError(error, context.locale);
      return exitCodeFromError(error);
    }
  }
  if (action === "debt") {
    const [sub, ...subRest] = rest;
    const debtHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
      register: debtRegisterAction,
      list: debtListAction,
    };
    const debtHandler = debtHandlers[sub ?? ""];
    if (!debtHandler) {
      console.error("用法: openarch coordination debt <register|list> [...]（list 支持 --repository-id <id> 过滤）");
      return 3;
    }
    try {
      return await debtHandler(subRest, context);
    } catch (error) {
      printAnalysisError(error, context.locale);
      return exitCodeFromError(error);
    }
  }
  if (action === "scope") {
    const [sub, ...subRest] = rest;
    const scopeHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
      register: scopeRegisterAction,
      "migrate-legacy": scopeMigrateAction,
    };
    const scopeHandler = scopeHandlers[sub ?? ""];
    if (!scopeHandler) {
      console.error("用法: openarch coordination scope <register|migrate-legacy> [...]");
      return 3;
    }
    try {
      return await scopeHandler(subRest, context);
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
      list: leaseListAction,
    };
    const leaseHandler = leaseHandlers[sub ?? ""];
    if (!leaseHandler) {
      console.error("用法: openarch coordination lease <acquire|renew|release|list> [...]（list 支持 --repository-id <id> 过滤）");
      return 3;
    }
    try {
      return await leaseHandler(subRest, context);
    } catch (error) {
      printAnalysisError(error, context.locale);
      return exitCodeFromError(error);
    }
  }
  if (action === "session") {
    const [sub, ...subRest] = rest;
    const sessionHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
      register: sessionRegisterAction,
      heartbeat: sessionHeartbeatAction,
      close: sessionCloseAction,
      list: sessionListAction,
    };
    const sessionHandler = sessionHandlers[sub ?? ""];
    if (!sessionHandler) {
      console.error("用法: openarch coordination session <register|heartbeat|close|list> [...]（list 支持 --repository-id <id> 过滤）");
      return 3;
    }
    try {
      return await sessionHandler(subRest, context);
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
