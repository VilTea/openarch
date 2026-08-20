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

const getJSON = async <T>(url: string, path: string, query = ""): Promise<T> => {
  const response = await request(`${baseUrl(url)}${path}${query}`);
  await requireOk(response);
  return readJson(response, path);
};

const postJSON = async <T>(url: string, path: string, body: unknown): Promise<T> => {
  const response = await request(`${baseUrl(url)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

export const fetchDocsRepoDescriptor = async (url: string): Promise<DocsRepoDescriptor> =>
  parseDescriptor(await getJSON(url, "/v1/docs-repo"));

export const postDocsRepoRefresh = async (
  url: string,
  notice: { readonly repositoryId: string; readonly branch: string; readonly headSha: string },
): Promise<DocsRepoDescriptor> =>
  parseDescriptor(await postJSON(url, "/v1/docs-repo/refresh", notice));

export const postEvidence = async (url: string, record: unknown): Promise<void> => {
  await postJSON(url, "/v1/evidence", record);
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
  const result = await postJSON<TaskSubmitResult>(url, "/v1/tasks/submit", {
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
  const result = await postJSON<TaskSubmitResult>(url, "/v1/tasks/claim", {
    task: { repositoryId: claim.repositoryId, serviceId: claim.serviceId, taskId: claim.taskId },
    proposalSha256: claim.proposalSha256,
    claimedBy: claim.claimedBy,
  });
  return parseTaskResult(result, "task claim");
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
  const result = await postJSON<TaskSubmitResult>(url, "/v1/tasks/complete", {
    task: { repositoryId: completion.repositoryId, serviceId: completion.serviceId, taskId: completion.taskId },
    proposalSha256: completion.proposalSha256,
    completedBy: completion.completedBy,
    ...(completion.completedHeadSHA ? { completedHeadSHA: completion.completedHeadSHA } : {}),
  });
  return parseTaskResult(result, "task complete");
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

export const listTasks = (url: string, repositoryId?: string): Promise<readonly TaskSummary[]> =>
  listCollection(url, "/v1/tasks", "tasks", parseTaskSummary, repositoryId);

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
