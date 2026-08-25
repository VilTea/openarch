// packages/cli/src/commands/coordinationActions.ts
// Service-dependent coordination actions. Every action first requires an
// explicit coordination config and an available service (descriptor matching
// the local docs-repo); otherwise they fail closed via CoordinationError.
import type { ScopeDocument } from "@openarch/core";
import {
  acquireLease,
  acquireLeaseWithWait,
  closeSession,
  debtDocument,
  debtDocumentPath,
  fetchDocsRepoDescriptor,
  heartbeatSession,
  listDebts,
  listLeases,
  listSessions,
  postDocsRepoRefresh,
  postEvidence,
  productDocument,
  registerSession,
  releaseLease,
  renewLease,
  repositoryDocument,
  scopeDocumentPath,
  serviceDocument,
  statusDocsRepo,
} from "@openarch/core";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOptionValue, parseOptionValues as parseRepeatedOption } from "../runtime";
import type { CommandHandler } from "../runtime";
import { requireAvailable, requireConfigured } from "./coordinationHelpers";

export const bootstrapAction: CommandHandler = async (args, context) => {
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const descriptor = await fetchDocsRepoDescriptor(url);
  console.log(`docs-repo: ${descriptor.remoteUrl} branch=${descriptor.branch} head=${descriptor.headSha}`);
  console.log("在本地以 `openarch init --docs-repo <url>` 关联该远端，commit + push 后运行 `openarch coordination refresh`。");
  return 0;
};

export const refreshAction: CommandHandler = async (args, context) => {
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const repositoryId = parseOptionValue(args, "--repository-id");
  const branch = parseOptionValue(args, "--branch");
  const headSha = parseOptionValue(args, "--head-sha");
  if (!repositoryId || !branch || !headSha) {
    console.error("用法: openarch coordination refresh --repository-id <id> --branch <branch> --head-sha <sha>");
    return 3;
  }
  const descriptor = await postDocsRepoRefresh(url, { repositoryId, branch, headSha });
  if (descriptor.headSha !== headSha.toLowerCase()) {
    console.log(`refresh 已确认：推送后远端已被其他项目推进，服务 worktree 已快进到 ${descriptor.headSha}`);
  } else {
    console.log("refresh 已确认：服务 worktree 已快进到 " + descriptor.headSha);
  }
  return 0;
};

export const scopeRegisterAction: CommandHandler = (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const productId = parseOptionValue(args, "--product-id");
  const services = parseRepeatedOption(args, "--service");
  if (!repositoryId && !productId) {
    console.error("用法: openarch coordination scope register --repository-id <id> [--service-id <id>] | --product-id <id> --service <repo>/<svc> [...]");
    return 3;
  }
  const docsRepo = statusDocsRepo(context.cwd).config?.target;
  if (!docsRepo) {
    console.error("scope register 需要先关联协作文档仓库：`openarch init --docs-repo <url|path>`");
    return 3;
  }
  const writeScope = (doc: ScopeDocument): void => {
    const target = join(docsRepo, scopeDocumentPath(doc));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
  };
  if (repositoryId) writeScope(repositoryDocument(repositoryId));
  if (repositoryId && serviceId) writeScope(serviceDocument(repositoryId, serviceId));
  if (productId) writeScope(productDocument(productId, services));
  console.log("scope 登记文档已生成（写入协作文档仓库）：git add + commit + push 后运行 `openarch coordination refresh --repository-id <id> --branch <b> --head-sha <sha>`");
  return 0;
};

export const scopeMigrateAction: CommandHandler = (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const legacyPath = parseOptionValue(args, "--legacy-path");
  if (!repositoryId || !legacyPath) {
    console.error("用法: openarch coordination scope migrate-legacy --legacy-path projects/<basename> --repository-id <new-stable-id>");
    return 3;
  }
  // 与协调服务 LegacyProjectRef.Validate 同口径：路径必须是相对
  // projects/<basename>，basename 从不被隐式提升为 repositoryId。
  const canonical = legacyPath.replace(/\\/g, "/").trim();
  if (!canonical.startsWith("projects/") || canonical === "projects/" || canonical.includes("/", "projects/".length) || canonical.split("/")[1] === "." || canonical.split("/")[1] === "..") {
    console.error(`legacy path 必须是 projects/<basename> 形态：${legacyPath}`);
    return 3;
  }
  const docsRepo = statusDocsRepo(context.cwd).config?.target;
  if (!docsRepo) {
    console.error("scope migrate-legacy 需要先关联协作文档仓库：`openarch init --docs-repo <url|path>`");
    return 3;
  }
  const legacyDir = join(docsRepo, ...canonical.split("/"));
  if (!existsSync(legacyDir)) {
    console.error(`legacy 位置不存在于 docs-repo：${canonical}`);
    return 3;
  }
  const document = repositoryDocument(repositoryId);
  const target = join(docsRepo, scopeDocumentPath(document));
  if (existsSync(target)) {
    console.error(`目标 scope 文档已存在（拒绝覆盖）：${scopeDocumentPath(document)}`);
    return 3;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(document, null, 2) + "\n");
  console.log(`已生成迁移登记 ${scopeDocumentPath(document)}（repositoryId 显式提供，不从 basename 推导）。`);
  console.log(`legacy 目录 ${canonical} 未被删除或改名：人工核对后 commit + push，再运行 openarch coordination refresh --repository-id ${repositoryId} --branch <b> --head-sha <sha>。`);
  return 0;
};

export const debtRegisterAction: CommandHandler = (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const debtId = parseOptionValue(args, "--debt-id");
  const title = parseOptionValue(args, "--title");
  const reason = parseOptionValue(args, "--reason");
  const reconsiderCondition = parseOptionValue(args, "--reconsider-condition");
  const acceptanceCriteria = parseOptionValue(args, "--acceptance-criteria");
  const status = parseOptionValue(args, "--status") as "deferred" | "accepted" | "resolved" | "superseded" | undefined;
  if (!repositoryId || !serviceId || !debtId || !title || !reason || !reconsiderCondition) {
    console.error("用法: openarch coordination debt register --repository-id <id> --service-id <id> --debt-id <id> --title <标题> --reason <原因> --reconsider-condition <重审条件> [--acceptance-criteria <验收条件>] [--status deferred]");
    return 3;
  }
  const docsRepo = statusDocsRepo(context.cwd).config?.target;
  if (!docsRepo) {
    console.error("debt register 需要先关联协作文档仓库：`openarch init --docs-repo <url|path>`");
    return 3;
  }
  const document = debtDocument({
    repositoryId, serviceId, debtId, title, reason, reconsiderCondition,
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    ...(status ? { status } : {}),
  });
  const target = join(docsRepo, debtDocumentPath(document));
  if (existsSync(target)) {
    console.error(`Debt 文档已存在（拒绝覆盖）：${debtDocumentPath(document)}`);
    return 3;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(document, null, 2) + "\n");
  console.log(`Debt 已登记（Agent-owned 版本化文档）：${debtDocumentPath(document)}`);
  console.log("commit + push 后运行 `openarch coordination refresh`；服务端 GET /v1/debts 只读投影。");
  return 0;
};

export const debtListAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const debts = await listDebts(url, repositoryId);
  if (debts.length === 0) {
    console.log("当前没有 Debt 文档。");
    return 0;
  }
  for (const debt of debts) {
    console.log(`${debt.debt.repositoryId}/${debt.debt.serviceId}/${debt.debt.debtId}  status=${debt.status}  title=${debt.title}`);
  }
  return 0;
};

export const evidenceUploadAction: CommandHandler = async (args, context) => {
  const file = args[0] === "upload" ? args[1] : args[0];
  if (!file) {
    console.error("用法: openarch coordination evidence upload <evidence.json>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  let record: unknown;
  try { record = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    console.error(`无法读取证据文件 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
  await postEvidence(url, record);
  console.log("evidence 已上传并确认。");
  return 0;
};

export { taskClaimAction, taskCompleteAction, taskCompleteLocalAction, taskCreateAction, taskListAction, taskShowAction, taskSubmitAction, taskSyncAction, taskWaitAction } from "./coordinationTaskActions";
export const leaseAcquireAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const target = parseOptionValue(args, "--target");
  const owner = parseOptionValue(args, "--owner");
  const ttlSeconds = Number(parseOptionValue(args, "--ttl") ?? "30");
  const waitSeconds = Number(parseOptionValue(args, "--wait") ?? "0");
  if (!repositoryId || !target || !owner || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || !Number.isFinite(waitSeconds) || waitSeconds < 0) {
    console.error("用法: openarch coordination lease acquire --repository-id <id> --target <target> --owner <executor> [--ttl <seconds>] [--wait <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const lease = waitSeconds > 0
    ? await acquireLeaseWithWait(url, { repositoryId, target, owner, ttlSeconds }, { timeoutMs: waitSeconds * 1000 })
    : await acquireLease(url, { repositoryId, target, owner, ttlSeconds });
  console.log(`已获取语义锁：${lease.key.repositoryId}/${lease.key.target}`);
  console.log(`  leaseId=${lease.leaseId} owner=${lease.owner} fencingToken=${lease.fencingToken} epoch=${lease.coordinatorEpoch} expiresAt=${lease.expiresAt}`);
  return 0;
};

export const leaseRenewAction: CommandHandler = async (args, context) => {
  const leaseId = parseOptionValue(args, "--lease-id");
  const owner = parseOptionValue(args, "--owner");
  const fencingToken = Number(parseOptionValue(args, "--fencing-token"));
  const coordinatorEpoch = Number(parseOptionValue(args, "--epoch"));
  const ttlSeconds = Number(parseOptionValue(args, "--ttl") ?? "30");
  if (!leaseId || !owner || !Number.isFinite(fencingToken) || !Number.isFinite(coordinatorEpoch) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    console.error("用法: openarch coordination lease renew --lease-id <id> --owner <executor> --fencing-token <n> --epoch <n> [--ttl <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const lease = await renewLease(url, { leaseId, owner, fencingToken, coordinatorEpoch }, ttlSeconds);
  console.log(`已续期语义锁：${lease.key.repositoryId}/${lease.key.target} expiresAt=${lease.expiresAt}`);
  return 0;
};

export const leaseReleaseAction: CommandHandler = async (args, context) => {
  const leaseId = parseOptionValue(args, "--lease-id");
  const owner = parseOptionValue(args, "--owner");
  const fencingToken = Number(parseOptionValue(args, "--fencing-token"));
  const coordinatorEpoch = Number(parseOptionValue(args, "--epoch"));
  if (!leaseId || !owner || !Number.isFinite(fencingToken) || !Number.isFinite(coordinatorEpoch)) {
    console.error("用法: openarch coordination lease release --lease-id <id> --owner <executor> --fencing-token <n> --epoch <n>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  await releaseLease(url, { leaseId, owner, fencingToken, coordinatorEpoch });
  console.log("语义锁已释放。");
  return 0;
};

export const leaseListAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const leases = await listLeases(url, repositoryId);
  if (leases.length === 0) {
    console.log("当前没有活跃语义锁。");
    return 0;
  }
  for (const lease of leases) {
    console.log(`${lease.key.repositoryId}/${lease.key.target}  owner=${lease.owner}  leaseId=${lease.leaseId}  expiresAt=${lease.expiresAt}`);
  }
  return 0;
};

export const sessionRegisterAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const sessionId = parseOptionValue(args, "--session-id");
  const owner = parseOptionValue(args, "--owner");
  const ttlSeconds = Number(parseOptionValue(args, "--ttl") ?? "60");
  if (!repositoryId || !sessionId || !owner || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    console.error("用法: openarch coordination session register --repository-id <id> --session-id <id> --owner <executor> [--ttl <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const session = await registerSession(url, { repositoryId, sessionId, owner, ttlSeconds });
  console.log(`会话已注册：${session.ref.repositoryId}/${session.ref.sessionId}`);
  console.log(`  owner=${session.owner} fencingToken=${session.fencingToken} epoch=${session.coordinatorEpoch} expiresAt=${session.expiresAt}`);
  return 0;
};

export const sessionHeartbeatAction: CommandHandler = async (args, context) => {
  const sessionId = parseOptionValue(args, "--session-id");
  const owner = parseOptionValue(args, "--owner");
  const fencingToken = Number(parseOptionValue(args, "--fencing-token"));
  const coordinatorEpoch = Number(parseOptionValue(args, "--epoch"));
  const ttlSeconds = Number(parseOptionValue(args, "--ttl") ?? "60");
  if (!sessionId || !owner || !Number.isFinite(fencingToken) || !Number.isFinite(coordinatorEpoch) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    console.error("用法: openarch coordination session heartbeat --session-id <id> --owner <executor> --fencing-token <n> --epoch <n> [--ttl <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const session = await heartbeatSession(url, { sessionId, owner, fencingToken, coordinatorEpoch }, ttlSeconds);
  console.log(`会话心跳已确认：${session.ref.repositoryId}/${session.ref.sessionId} expiresAt=${session.expiresAt}`);
  return 0;
};

export const sessionCloseAction: CommandHandler = async (args, context) => {
  const sessionId = parseOptionValue(args, "--session-id");
  const owner = parseOptionValue(args, "--owner");
  const fencingToken = Number(parseOptionValue(args, "--fencing-token"));
  const coordinatorEpoch = Number(parseOptionValue(args, "--epoch"));
  if (!sessionId || !owner || !Number.isFinite(fencingToken) || !Number.isFinite(coordinatorEpoch)) {
    console.error("用法: openarch coordination session close --session-id <id> --owner <executor> --fencing-token <n> --epoch <n>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  await closeSession(url, { sessionId, owner, fencingToken, coordinatorEpoch });
  console.log("会话已关闭。");
  return 0;
};

export const sessionListAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const sessions = await listSessions(url, repositoryId);
  if (sessions.length === 0) {
    console.log("当前没有活跃会话。");
    return 0;
  }
  for (const session of sessions) {
    console.log(`${session.ref.repositoryId}/${session.ref.sessionId}  owner=${session.owner}  expiresAt=${session.expiresAt}`);
  }
  return 0;
};
