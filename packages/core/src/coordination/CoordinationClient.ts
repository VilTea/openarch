// packages/core/src/coordination/CoordinationClient.ts
export type CoordinationCause =
  | "service_unreachable"
  | "http_status"
  | "invalid_descriptor";

export class CoordinationError extends Error {
  readonly _tag = "CoordinationError" as const;
  readonly cause: CoordinationCause;
  readonly status?: number;
  constructor(cause: CoordinationCause, detail: string, status?: number) {
    super(detail);
    this.name = "CoordinationError";
    this.cause = cause;
    this.status = status;
  }
}

export interface DocsRepoDescriptor {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly headSha: string;
}

const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;
const BASE_TIMEOUT_MS = 5000;

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
  throw new CoordinationError("http_status", detail, response.status);
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

export const fetchDocsRepoDescriptor = async (url: string): Promise<DocsRepoDescriptor> => {
  const response = await request(`${baseUrl(url)}/v1/docs-repo`);
  await requireOk(response);
  return parseDescriptor(await readJson(response, "docs-repo"));
};

export const postDocsRepoRefresh = async (
  url: string,
  notice: { readonly repositoryId: string; readonly branch: string; readonly headSha: string },
): Promise<DocsRepoDescriptor> => {
  const response = await request(`${baseUrl(url)}/v1/docs-repo/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notice),
  });
  await requireOk(response);
  return parseDescriptor(await readJson(response, "docs-repo refresh"));
};

export const postEvidence = async (url: string, record: unknown): Promise<void> => {
  const response = await request(`${baseUrl(url)}/v1/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  await requireOk(response);
};

export interface TaskSubmitResult {
  readonly status: {
    readonly state: string;
    readonly proposalSha256?: string;
    readonly verifiedHeadSha?: string;
    readonly claimedBy?: string;
    readonly completedBy?: string;
    readonly completedHeadSHA?: string;
  };
  readonly created: boolean;
}

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
  const response = await request(`${baseUrl(url)}/v1/tasks/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: { repositoryId: submission.repositoryId, serviceId: submission.serviceId, taskId: submission.taskId },
      branch: submission.branch,
      headSha: submission.headSha,
    }),
  });
  await requireOk(response);
  return parseTaskResult(await readJson(response, "task submit"), "task submit");
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
  const response = await request(`${baseUrl(url)}/v1/tasks/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: { repositoryId: claim.repositoryId, serviceId: claim.serviceId, taskId: claim.taskId },
      proposalSha256: claim.proposalSha256,
      claimedBy: claim.claimedBy,
    }),
  });
  await requireOk(response);
  return parseTaskResult(await readJson(response, "task claim"), "task claim");
};

export const completeTask = async (
  url: string,
  completion: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly taskId: string;
    readonly proposalSha256: string;
    readonly completedBy: string;
    readonly completedHeadSHA?: string;
  },
): Promise<TaskSubmitResult> => {
  const response = await request(`${baseUrl(url)}/v1/tasks/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: { repositoryId: completion.repositoryId, serviceId: completion.serviceId, taskId: completion.taskId },
      proposalSha256: completion.proposalSha256,
      completedBy: completion.completedBy,
      ...(completion.completedHeadSHA ? { completedHeadSHA: completion.completedHeadSHA } : {}),
    }),
  });
  await requireOk(response);
  return parseTaskResult(await readJson(response, "task complete"), "task complete");
};

const parseTaskResult = (result: TaskSubmitResult, what: string): TaskSubmitResult => {
  if (typeof result?.created !== "boolean" || typeof result?.status?.state !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} result`);
  }
  return result;
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
  readonly status: TaskSubmitResult["status"];
}

const parseTaskSummary = (value: unknown, what: string): TaskSummary => {
  const summary = value as TaskSummary;
  if (typeof summary?.task?.repositoryId !== "string" || typeof summary?.task?.serviceId !== "string"
    || typeof summary?.task?.taskId !== "string" || typeof summary?.title !== "string"
    || typeof summary?.requestedBy !== "string" || typeof summary?.proposalSha256 !== "string"
    || typeof summary?.status?.state !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} summary`);
  }
  return summary;
};

export const listTasks = async (url: string, repositoryId?: string): Promise<readonly TaskSummary[]> => {
  const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  const response = await request(`${baseUrl(url)}/v1/tasks${query}`);
  await requireOk(response);
  const body = await readJson(response, "task list") as { readonly tasks?: unknown };
  if (!Array.isArray(body?.tasks)) {
    throw new CoordinationError("invalid_descriptor", "service returned an invalid task list");
  }
  return body.tasks.map((summary) => parseTaskSummary(summary, "task list"));
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

export const listDebts = async (url: string, repositoryId?: string): Promise<readonly DebtSummary[]> => {
  const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  const response = await request(`${baseUrl(url)}/v1/debts${query}`);
  await requireOk(response);
  const body = await readJson(response, "debt list") as { readonly debts?: unknown };
  if (!Array.isArray(body?.debts)) {
    throw new CoordinationError("invalid_descriptor", "service returned an invalid debt list");
  }
  return body.debts.map((debt) => parseDebtSummary(debt, "debt list"));
};

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
  const response = await request(`${baseUrl(url)}/v1/leases/acquire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: { repositoryId: leaseRequest.repositoryId, target: leaseRequest.target }, owner: leaseRequest.owner, ttlSeconds: leaseRequest.ttlSeconds }),
  });
  await requireOk(response);
  return parseLease(await readJson(response, "lease acquire"), "acquire");
};

export const renewLease = async (
  url: string,
  credential: LeaseCredential,
  ttlSeconds: number,
): Promise<Lease> => {
  const response = await request(`${baseUrl(url)}/v1/leases/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, ttlSeconds }),
  });
  await requireOk(response);
  return parseLease(await readJson(response, "lease renew"), "renew");
};

export const releaseLease = async (
  url: string,
  credential: LeaseCredential,
): Promise<void> => {
  const response = await request(`${baseUrl(url)}/v1/leases/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  await requireOk(response);
};

export const listLeases = async (url: string, repositoryId?: string): Promise<readonly Lease[]> => {
  const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  const response = await request(`${baseUrl(url)}/v1/leases${query}`);
  await requireOk(response);
  const body = await readJson(response, "lease list") as { readonly leases?: unknown };
  if (!Array.isArray(body?.leases)) {
    throw new CoordinationError("invalid_descriptor", "service returned an invalid lease list");
  }
  return body.leases.map((lease) => parseLease(lease, "list"));
};

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
  const response = await request(`${baseUrl(url)}/v1/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  await requireOk(response);
  return parseSession(await readJson(response, "session register"), "register");
};

export const heartbeatSession = async (
  url: string,
  credential: SessionCredential,
  ttlSeconds: number,
): Promise<LiveSession> => {
  const response = await request(`${baseUrl(url)}/v1/sessions/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, ttlSeconds }),
  });
  await requireOk(response);
  return parseSession(await readJson(response, "session heartbeat"), "heartbeat");
};

export const closeSession = async (
  url: string,
  credential: SessionCredential,
): Promise<void> => {
  const response = await request(`${baseUrl(url)}/v1/sessions/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  await requireOk(response);
};

export const listSessions = async (url: string, repositoryId?: string): Promise<readonly LiveSession[]> => {
  const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  const response = await request(`${baseUrl(url)}/v1/sessions${query}`);
  await requireOk(response);
  const body = await readJson(response, "session list") as { readonly sessions?: unknown };
  if (!Array.isArray(body?.sessions)) {
    throw new CoordinationError("invalid_descriptor", "service returned an invalid session list");
  }
  return body.sessions.map((session) => parseSession(session, "list"));
};
