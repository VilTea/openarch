// packages/cli/src/commands/coordinationActions.ts
// Service-dependent coordination actions. Every action first requires an
// explicit coordination config and an available service (descriptor matching
// the local docs-repo); otherwise they fail closed via CoordinationError.
import type { ScopeDocument } from "@openarch/core";
import {
  CoordinationError,
  acquireLease,
  claimTask,
  completeTask,
  fetchDocsRepoDescriptor,
  postDocsRepoRefresh,
  postEvidence,
  productDocument,
  readCoordinationConfig,
  releaseLease,
  renewLease,
  repositoryDocument,
  scopeDocumentPath,
  serviceDocument,
  statusDocsRepo,
  submitTask,
} from "@openarch/core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectCoordinationContext } from "../coordinationContext";
import { parseOptionValue, parseOptionValues as parseRepeatedOption } from "../runtime";
import type { CommandHandler } from "../runtime";

/** Requires an explicit coordination config; otherwise throws CoordinationError → exit 3. */
const requireConfigured = (cwd: string): string => {
  const configured = readCoordinationConfig(cwd);
  if (configured.state !== "configured") {
    throw new CoordinationError("http_status", "coordination service is not explicitly configured; run `openarch init --coordination-url <url>`");
  }
  return configured.config.url;
};

/** Requires the service descriptor to match the local docs-repo; otherwise fails closed. */
const requireAvailable = async (cwd: string): Promise<void> => {
  const coordination = await collectCoordinationContext(cwd);
  if (coordination.state !== "available") {
    throw new CoordinationError("http_status", `coordination service unavailable: ${coordination.detail}`);
  }
};

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
  await postDocsRepoRefresh(url, { repositoryId, branch, headSha });
  console.log("refresh 已确认：服务 worktree 已快进到 " + headSha);
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

export const evidenceUploadAction: CommandHandler = async (args, context) => {
  const file = args[0];
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
  if (!repositoryId || !serviceId || !taskId || !proposalSha256 || !claimedBy) {
    console.error("用法: openarch coordination task claim --repository-id <id> --service-id <id> --task-id <id> --proposal-sha256 <sha> --claimed-by <executor>");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const result = await claimTask(url, { repositoryId, serviceId, taskId, proposalSha256, claimedBy });
  console.log(`task ${taskId} ${result.created ? "已认领" : "已存在"}：状态 ${result.status.state}${result.status.claimedBy ? ` 执行者 ${result.status.claimedBy}` : ""}`);
  return 0;
};

export const taskCompleteAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const serviceId = parseOptionValue(args, "--service-id");
  const taskId = parseOptionValue(args, "--task-id");
  const proposalSha256 = parseOptionValue(args, "--proposal-sha256");
  const completedBy = parseOptionValue(args, "--completed-by");
  const completedHeadSHA = parseOptionValue(args, "--completed-head-sha");
  if (!repositoryId || !serviceId || !taskId || !proposalSha256 || !completedBy) {
    console.error("用法: openarch coordination task complete --repository-id <id> --service-id <id> --task-id <id> --proposal-sha256 <sha> --completed-by <executor> [--completed-head-sha <sha>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const result = await completeTask(url, { repositoryId, serviceId, taskId, proposalSha256, completedBy, completedHeadSHA });
  console.log(`task ${taskId} ${result.created ? "已完成" : "已存在"}：状态 ${result.status.state}${result.status.completedBy ? ` 执行者 ${result.status.completedBy}` : ""}`);
  return 0;
};

export const leaseAcquireAction: CommandHandler = async (args, context) => {
  const repositoryId = parseOptionValue(args, "--repository-id");
  const target = parseOptionValue(args, "--target");
  const owner = parseOptionValue(args, "--owner");
  const ttlSeconds = Number(parseOptionValue(args, "--ttl") ?? "30");
  if (!repositoryId || !target || !owner || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    console.error("用法: openarch coordination lease acquire --repository-id <id> --target <target> --owner <executor> [--ttl <seconds>]");
    return 3;
  }
  const url = await requireConfigured(context.cwd);
  await requireAvailable(context.cwd);
  const lease = await acquireLease(url, { repositoryId, target, owner, ttlSeconds });
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
