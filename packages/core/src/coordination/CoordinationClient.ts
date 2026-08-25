// packages/core/src/coordination/CoordinationClient.ts
export type CoordinationCause =
  | "service_unreachable"
  | "http_status"
  | "invalid_descriptor";

export class CoordinationError extends Error {
  readonly _tag = "CoordinationError" as const;
  readonly cause: CoordinationCause;
  readonly status?: number;
  readonly code?: string;
  readonly retryable?: boolean;
  constructor(cause: CoordinationCause, detail: string, status?: number, code?: string, retryable?: boolean) {
    super(detail);
    this.name = "CoordinationError";
    this.cause = cause;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DocsRepoDescriptor {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly headSha: string;
}

const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
// Git-backed service-owned writes can take several seconds in local mode;
// keep the client default generous enough for real dogfood/remote use.
const BASE_TIMEOUT_MS = 20_000;
const TASK_RETRY_DELAYS_MS = [100, 400];

const request = async (url: string, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(BASE_TIMEOUT_MS) });
  } catch (error) {
    throw new CoordinationError("service_unreachable", error instanceof Error ? error.message : String(error));
  }
};

const requireOk = async (response: Response): Promise<void> => {
  if (response.ok) return;
  const body = await response.json().catch(() => ({ error: response.statusText }));
  const detail = typeof body?.error === "string" ? body.error : response.statusText;
  const code = typeof body?.code === "string" ? body.code : undefined;
  const retryable = typeof body?.retryable === "boolean" ? body.retryable : undefined;
  throw new CoordinationError("http_status", detail, response.status, code, retryable);
};

/** The service returns `{"docsRepo": {remoteUrl, branch, headSha}, scope, scopeState}`. */
const parseDescriptor = (value: unknown): DocsRepoDescriptor => {
  const descriptor = (value as { docsRepo?: Partial<DocsRepoDescriptor> })?.docsRepo ?? {};
  const remoteUrl = descriptor.remoteUrl ?? "";
  const branch = descriptor.branch ?? "";
  const headSha = descriptor.headSha ?? "";
  if (typeof remoteUrl !== "string" || remoteUrl.trim() === ""
    || typeof branch !== "string" || branch.trim() === ""
    || typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    throw new CoordinationError("invalid_descriptor", "service returned an invalid docs-repo descriptor");
  }
  return { remoteUrl: remoteUrl.trim(), branch: branch.trim(), headSha: headSha.toLowerCase() };
};

const readJson = async <T>(response: Response, what: string): Promise<T> => {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new CoordinationError("invalid_descriptor", `service returned a non-JSON ${what} body`);
  }
};

const baseUrl = (url: string): string => url.replace(/\/+$/, "");

const getJSON = async <T>(url: string, path: string, query = ""): Promise<T> => {
  const response = await request(`${baseUrl(url)}${path}${query}`);
  await requireOk(response);
  return readJson(response, path);
};

const postJSON = async <T>(url: string, path: string, body: unknown, requestId?: string): Promise<T> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requestId) headers["X-Request-Id"] = requestId;
  const response = await request(`${baseUrl(url)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  await requireOk(response);
  return readJson(response, path);
};

const listCollection = async <T>(
  url: string,
  path: string,
  field: string,
  parseItem: (value: unknown, what: string) => T,
  repositoryId?: string,
): Promise<readonly T[]> => {
  const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  const body = await getJSON<{ readonly [key: string]: unknown } | null>(url, `${path}${query}`);
  const items = body?.[field];
  if (!Array.isArray(items)) {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${field} list`);
  }
  return items.map((item) => parseItem(item, `${field} list`));
};

const newRequestId = (): string =>
  `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableCoordinationError = (error: unknown): boolean => {
  if (!(error instanceof CoordinationError)) return false;
  if (error.cause === "service_unreachable") return true;
  return error.retryable === true;
};

const postJSONWithRetry = async <T>(url: string, path: string, body: unknown): Promise<T> => {
  const requestId = newRequestId();
  let attempt = 0;
  for (;;) {
    try {
      return await postJSON<T>(url, path, body, requestId);
    } catch (error) {
      if (!isRetryableCoordinationError(error) || attempt >= TASK_RETRY_DELAYS_MS.length) throw error;
      await delay(TASK_RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }
};

export const fetchDocsRepoDescriptor = async (url: string): Promise<DocsRepoDescriptor> =>
  parseDescriptor(await getJSON(url, "/v1/docs-repo"));

export const postDocsRepoRefresh = async (
  url: string,
  notice: { readonly repositoryId: string; readonly branch: string; readonly headSha: string },
): Promise<DocsRepoDescriptor> =>
  parseDescriptor(await postJSONWithRetry(url, "/v1/docs-repo/refresh", notice));

export const postEvidence = async (url: string, record: unknown): Promise<void> => {
  await postJSON(url, "/v1/evidence", record);
};

export interface TaskStatus {
  readonly state: string;
  readonly proposalSha256?: string;
  readonly verifiedHeadSha?: string;
  readonly claimedBy?: string;
  readonly completedBy?: string;
  readonly localHeadSHA?: string;
  readonly completedHeadSHA?: string;
}

export interface TaskSubmitResult {
  readonly status: TaskStatus;
  readonly created: boolean;
}

const parseTaskStatus = (value: unknown, what: string): TaskStatus => {
  const status = value as TaskStatus;
  if (typeof status?.state !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} status`);
  }
  if (status.proposalSha256 !== undefined && typeof status.proposalSha256 !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} proposalSha256`);
  }
  if (status.verifiedHeadSha !== undefined && typeof status.verifiedHeadSha !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} verifiedHeadSha`);
  }
  return status;
};

const parseTaskResult = (result: TaskSubmitResult, what: string): TaskSubmitResult => {
  if (typeof result?.created !== "boolean") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} result`);
  }
  return { created: result.created, status: parseTaskStatus(result.status, what) };
};

export const submitTask = async (
  url: string,
  submission: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
    readonly branch: string;
    readonly headSha: string;
  },
): Promise<TaskSubmitResult> => {
  const result = await postJSONWithRetry<TaskSubmitResult>(url, "/v1/tasks/submit", {
    task: { repositoryId: submission.repositoryId, serviceId: submission.serviceId, taskId: submission.taskId },
    branch: submission.branch,
    headSha: submission.headSha,
  });
  return parseTaskResult(result, "task submit");
};

export const claimTask = async (
  url: string,
  claim: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
    readonly proposalSha256: string;
    readonly claimedBy: string;
  },
): Promise<TaskSubmitResult> => {
  const result = await postJSONWithRetry<TaskSubmitResult>(url, "/v1/tasks/claim", {
    task: { repositoryId: claim.repositoryId, serviceId: claim.serviceId, taskId: claim.taskId },
    proposalSha256: claim.proposalSha256,
    claimedBy: claim.claimedBy,
  });
  return parseTaskResult(result, "task claim");
};

export const completeLocalTask = async (
  url: string,
  completion: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
    readonly proposalSha256: string;
    readonly completedBy: string;
    readonly localHeadSHA: string;
    readonly target: string;
    readonly leaseId: string;
  },
): Promise<TaskSubmitResult> => {
  const result = await postJSONWithRetry<TaskSubmitResult>(url, "/v1/tasks/complete-local", {
    task: { repositoryId: completion.repositoryId, serviceId: completion.serviceId, taskId: completion.taskId },
    proposalSha256: completion.proposalSha256,
    completedBy: completion.completedBy,
    localHeadSHA: completion.localHeadSHA,
    target: completion.target,
    leaseId: completion.leaseId,
  });
  return parseTaskResult(result, "task complete-local");
};

export const completeTask = async (
  url: string,
  completion: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
    readonly proposalSha256: string;
    readonly completedBy: string;
    readonly completedHeadSHA: string;
    readonly target: string;
    readonly leaseId: string;
  },
): Promise<TaskSubmitResult> => {
  const result = await postJSONWithRetry<TaskSubmitResult>(url, "/v1/tasks/complete", {
    task: { repositoryId: completion.repositoryId, serviceId: completion.serviceId, taskId: completion.taskId },
    proposalSha256: completion.proposalSha256,
    completedBy: completion.completedBy,
    completedHeadSHA: completion.completedHeadSHA,
    target: completion.target,
    leaseId: completion.leaseId,
  });
  return parseTaskResult(result, "task complete");
};

export interface TaskSummary {
  readonly task: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
  };
  readonly title: string;
  readonly hypothesis: string;
  readonly requestedBy: string;
  readonly proposalSha256: string;
  readonly status: TaskStatus;
}

const parseTaskSummary = (value: unknown, what: string): TaskSummary => {
  const summary = value as TaskSummary;
  if (typeof summary?.task?.repositoryId !== "string" || typeof summary?.task?.serviceId !== "string"
    || typeof summary?.task?.taskId !== "string" || typeof summary?.title !== "string"
    || typeof summary?.requestedBy !== "string" || typeof summary?.proposalSha256 !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} summary`);
  }
  return {
    task: { repositoryId: summary.task.repositoryId, serviceId: summary.task.serviceId, taskId: summary.task.taskId },
    title: summary.title,
    hypothesis: summary.hypothesis,
    requestedBy: summary.requestedBy,
    proposalSha256: summary.proposalSha256,
    status: parseTaskStatus(summary.status, what),
  };
};

export const listTasks = (url: string, repositoryId?: string): Promise<readonly TaskSummary[]> =>
  listCollection(url, "/v1/tasks", "tasks", parseTaskSummary, repositoryId);

export interface TaskLifecycleEvent {
  readonly schemaVersion: string;
  readonly task: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
  };
  readonly type: "verified" | "claimed" | "completed_local" | "completed";
  readonly proposalSha256: string;
  readonly verifiedHeadSha: string;
  readonly sequence: number;
  readonly prevEventHash: string;
  readonly eventHash: string;
  readonly recordedAt: string;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly claimedBy?: string;
  readonly completedBy?: string;
  readonly completedHeadSHA?: string;
}

export interface TaskDetail {
  readonly task: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
  };
  readonly title: string;
  readonly hypothesis: string;
  readonly requestedBy: string;
  readonly proposalSha256: string;
  readonly dependsOn?: readonly {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
  }[];
  readonly goal?: string;
  readonly scope?: readonly string[];
  readonly constraints?: readonly string[];
  readonly verification?: readonly string[];
  readonly deliverable?: string;
  readonly status: TaskStatus;
  readonly events: readonly TaskLifecycleEvent[];
}

const parseTaskLifecycleEvent = (value: unknown, what: string): TaskLifecycleEvent => {
  const event = value as TaskLifecycleEvent;
  if (typeof event?.schemaVersion !== "string" || typeof event?.type !== "string"
    || typeof event?.task?.repositoryId !== "string" || typeof event?.task?.serviceId !== "string"
    || typeof event?.task?.taskId !== "string" || typeof event?.proposalSha256 !== "string"
    || typeof event?.verifiedHeadSha !== "string" || typeof event?.sequence !== "number"
    || typeof event?.prevEventHash !== "string" || typeof event?.eventHash !== "string"
    || typeof event?.recordedAt !== "string" || typeof event?.signerKeyId !== "string"
    || typeof event?.signature !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} event`);
  }
  if (!["verified", "claimed", "completed_local", "completed"].includes(event.type)) {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} event type`);
  }
  return event;
};

const parseTaskDetail = (value: unknown, what: string): TaskDetail => {
  const detail = value as TaskDetail;
  if (typeof detail?.task?.repositoryId !== "string" || typeof detail?.task?.serviceId !== "string"
    || typeof detail?.task?.taskId !== "string" || typeof detail?.title !== "string"
    || typeof detail?.requestedBy !== "string" || typeof detail?.proposalSha256 !== "string"
    || !Array.isArray(detail.events)) {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} detail`);
  }
  return {
    task: { repositoryId: detail.task.repositoryId, serviceId: detail.task.serviceId, taskId: detail.task.taskId },
    title: detail.title,
    hypothesis: detail.hypothesis,
    requestedBy: detail.requestedBy,
    proposalSha256: detail.proposalSha256,
    ...(Array.isArray(detail.dependsOn)
      ? { dependsOn: detail.dependsOn.map((ref) => ({
          repositoryId: String(ref.repositoryId), serviceId: String(ref.serviceId), taskId: String(ref.taskId),
        })) }
      : {}),
    ...(typeof detail.goal === "string" ? { goal: detail.goal } : {}),
    ...(Array.isArray(detail.scope) ? { scope: detail.scope.map(String) } : {}),
    ...(Array.isArray(detail.constraints) ? { constraints: detail.constraints.map(String) } : {}),
    ...(Array.isArray(detail.verification) ? { verification: detail.verification.map(String) } : {}),
    ...(typeof detail.deliverable === "string" ? { deliverable: detail.deliverable } : {}),
    status: parseTaskStatus(detail.status, what),
    events: detail.events.map((event) => parseTaskLifecycleEvent(event, what)),
  };
};

export const getTaskDetail = async (
  url: string,
  ref: { readonly repositoryId: string; readonly serviceId: string; readonly taskId: string },
): Promise<TaskDetail> => {
  const path = `/v1/tasks/${encodeURIComponent(ref.repositoryId)}/${encodeURIComponent(ref.serviceId)}/${encodeURIComponent(ref.taskId)}`;
  return parseTaskDetail(await getJSON(url, path), "task detail");
};

export interface DebtSummary {
  readonly schemaVersion: string;
  readonly debt: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly debtId: string;
  };
  readonly title: string;
  readonly reason: string;
  readonly reconsiderCondition: string;
  readonly acceptanceCriteria?: string;
  readonly status: string;
}

const parseDebtSummary = (value: unknown, what: string): DebtSummary => {
  const debt = value as DebtSummary;
  if (typeof debt?.debt?.repositoryId !== "string" || typeof debt?.debt?.serviceId !== "string"
    || typeof debt?.debt?.debtId !== "string" || typeof debt?.title !== "string"
    || typeof debt?.reason !== "string" || typeof debt?.reconsiderCondition !== "string"
    || typeof debt?.status !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} summary`);
  }
  return debt;
};

export const listDebts = (url: string, repositoryId?: string): Promise<readonly DebtSummary[]> =>
  listCollection(url, "/v1/debts", "debts", parseDebtSummary, repositoryId);

export interface LeaseCredential {
  readonly leaseId: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly coordinatorEpoch: number;
}

export interface Lease {
  readonly key: { readonly repositoryId: string; readonly target: string };
  readonly leaseId: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly coordinatorEpoch: number;
  readonly expiresAt: string;
}

const parseLease = (value: unknown, what: string): Lease => {
  const lease = value as Lease;
  if (typeof lease?.leaseId !== "string" || typeof lease?.owner !== "string"
    || typeof lease?.fencingToken !== "number" || typeof lease?.coordinatorEpoch !== "number"
    || typeof lease?.key?.repositoryId !== "string" || typeof lease?.key?.target !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} lease`);
  }
  return lease;
};

export const acquireLease = async (
  url: string,
  leaseRequest: { readonly repositoryId: string; readonly target: string; readonly owner: string; readonly ttlSeconds: number },
): Promise<Lease> => {
  const lease = await postJSON<Lease>(url, "/v1/leases/acquire", {
    key: { repositoryId: leaseRequest.repositoryId, target: leaseRequest.target },
    owner: leaseRequest.owner,
    ttlSeconds: leaseRequest.ttlSeconds,
  });
  return parseLease(lease, "acquire");
};

/**
 * acquireLeaseWithWait retries a held semantic lock until the lease is
 * released or the timeout expires. This lets an agent either wait for the
 * lock or, with a short timeout, decide to defer the task and work on
 * something else.
 */
export const acquireLeaseWithWait = async (
  url: string,
  leaseRequest: { readonly repositoryId: string; readonly target: string; readonly owner: string; readonly ttlSeconds: number },
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<Lease> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await acquireLease(url, leaseRequest);
    } catch (error) {
      const coordination = error instanceof CoordinationError ? error : undefined;
      const held = coordination?.cause === "http_status" && coordination.status === 409;
      if (!held || Date.now() >= deadline) throw error;
      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
};

export const renewLease = async (
  url: string,
  credential: LeaseCredential,
  ttlSeconds: number,
): Promise<Lease> => {
  const lease = await postJSON<Lease>(url, "/v1/leases/renew", { credential, ttlSeconds });
  return parseLease(lease, "renew");
};

export const releaseLease = async (
  url: string,
  credential: LeaseCredential,
): Promise<void> => {
  await postJSON(url, "/v1/leases/release", { credential });
};

export const listLeases = (url: string, repositoryId?: string): Promise<readonly Lease[]> =>
  listCollection(url, "/v1/leases", "leases", parseLease, repositoryId);

export interface SessionCredential {
  readonly sessionId: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly coordinatorEpoch: number;
}

export interface LiveSession {
  readonly ref: { readonly repositoryId: string; readonly sessionId: string };
  readonly owner: string;
  readonly fencingToken: number;
  readonly coordinatorEpoch: number;
  readonly startedAt: string;
  readonly lastHeartbeat: string;
  readonly expiresAt: string;
}

const parseSession = (value: unknown, what: string): LiveSession => {
  const session = value as LiveSession;
  if (typeof session?.ref?.repositoryId !== "string" || typeof session?.ref?.sessionId !== "string"
    || typeof session?.owner !== "string" || typeof session?.fencingToken !== "number"
    || typeof session?.coordinatorEpoch !== "number" || typeof session?.expiresAt !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} session`);
  }
  return session;
};

export const registerSession = async (
  url: string,
  registration: { readonly repositoryId: string; readonly sessionId: string; readonly owner: string; readonly ttlSeconds: number },
): Promise<LiveSession> => {
  const session = await postJSON<LiveSession>(url, "/v1/sessions/register", registration);
  return parseSession(session, "register");
};

export const heartbeatSession = async (
  url: string,
  credential: SessionCredential,
  ttlSeconds: number,
): Promise<LiveSession> => {
  const session = await postJSON<LiveSession>(url, "/v1/sessions/heartbeat", { credential, ttlSeconds });
  return parseSession(session, "heartbeat");
};

export const closeSession = async (
  url: string,
  credential: SessionCredential,
): Promise<void> => {
  await postJSON(url, "/v1/sessions/close", { credential });
};

export const listSessions = (url: string, repositoryId?: string): Promise<readonly LiveSession[]> =>
  listCollection(url, "/v1/sessions", "sessions", parseSession, repositoryId);
