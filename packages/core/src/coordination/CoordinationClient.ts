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
): Promise<void> => {
  const response = await request(`${baseUrl(url)}/v1/docs-repo/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notice),
  });
  await requireOk(response);
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
  return parseTaskResult(await readJson(response, "task complete"), "task complete");
};

const parseTaskResult = (result: TaskSubmitResult, what: string): TaskSubmitResult => {
  if (typeof result?.created !== "boolean" || typeof result?.status?.state !== "string") {
    throw new CoordinationError("invalid_descriptor", `service returned an invalid ${what} result`);
  }
  return result;
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
