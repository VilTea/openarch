// packages/core/__tests__/coordination/CoordinationClient.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  CoordinationError,
  acquireLease,
  acquireLeaseWithWait,
  claimTask,
  closeSession,
  completeLocalTask,
  completeTask,
  fetchDocsRepoDescriptor,
  getTaskDetail,
  heartbeatSession,
  listDebts,
  listLeases,
  listSessions,
  listTasks,
  postDocsRepoRefresh,
  postEvidence,
  registerSession,
  releaseLease,
  renewLease,
  submitTask,
} from "../../src/coordination/CoordinationClient";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const okDescriptor = { docsRepo: { remoteUrl: "https://example.com/docs.git", branch: "main", headSha: "a".repeat(40) }, scopeState: "unavailable" };

const okDescriptorFlat = okDescriptor.docsRepo;

describe("fetchDocsRepoDescriptor", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("returns the descriptor on HTTP 200 with valid fields", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => okDescriptor });
    await expect(fetchDocsRepoDescriptor("http://127.0.0.1:8787")).resolves.toEqual(okDescriptorFlat);
  });

  it("throws CoordinationError(cause=http_status) on non-200", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) });
    await expect(fetchDocsRepoDescriptor("http://127.0.0.1:8787")).rejects.toMatchObject({ cause: "http_status", status: 503 });
  });

  it("throws CoordinationError(cause=invalid_descriptor) on malformed fields", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ docsRepo: { remoteUrl: "", branch: "main", headSha: "xyz" } }) });
    await expect(fetchDocsRepoDescriptor("http://127.0.0.1:8787")).rejects.toMatchObject({ cause: "invalid_descriptor" });
  });

  it("throws CoordinationError(cause=invalid_descriptor) on non-JSON 2xx body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } });
    await expect(fetchDocsRepoDescriptor("http://127.0.0.1:8787")).rejects.toMatchObject({ cause: "invalid_descriptor" });
  });

  it("throws CoordinationError(cause=service_unreachable) on network failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchDocsRepoDescriptor("http://127.0.0.1:8787")).rejects.toMatchObject({ cause: "service_unreachable" });
  });
});

describe("postDocsRepoRefresh", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends {repositoryId, branch, headSha} and returns the refreshed descriptor", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => okDescriptor });
    const descriptor = await postDocsRepoRefresh("http://127.0.0.1:8787", { repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/docs-repo/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) });
    expect(descriptor).toEqual(okDescriptorFlat);
  });

  it("throws CoordinationError(cause=http_status) on 409", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "diverged" }) });
    await expect(postDocsRepoRefresh("http://127.0.0.1:8787", { repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) }))
      .rejects.toMatchObject({ cause: "http_status", status: 409 });
  });

  it("retries a retryable refresh error and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "busy", code: "service_unavailable", retryable: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => okDescriptor });
    const descriptor = await postDocsRepoRefresh("http://127.0.0.1:8787", { repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) });
    expect(descriptor).toEqual(okDescriptorFlat);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("postEvidence / submitTask", () => {
  beforeEach(() => mockFetch.mockReset());

  it("postEvidence posts to /v1/evidence", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    await postEvidence("http://127.0.0.1:8787", { schema: 2 });
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/evidence");
  });

  it("submitTask posts to /v1/tasks/submit and returns created result", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ status: { state: "verified" }, created: true }) });
    const result = await submitTask("http://127.0.0.1:8787", { repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1", branch: "main", headSha: "a".repeat(40) });
    expect(result.created).toBe(true);
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/tasks/submit");
  });

  it("listLeases appends the optional repositoryId filter", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ leases: [] }) });
    await listLeases("http://127.0.0.1:8787", "repo-a");
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/leases?repositoryId=repo-a");
  });

  it("listSessions appends the optional repositoryId filter", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sessions: [] }) });
    await listSessions("http://127.0.0.1:8787", "repo-a");
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/sessions?repositoryId=repo-a");
  });

  it("listTasks parses summaries and appends the repositoryId filter", async () => {
    const summary = {
      task: { repositoryId: "repo-a", serviceId: "svc-a", taskId: "task-1" },
      title: "clean refactor", hypothesis: "lower branch", requestedBy: "agent-a",
      proposalSha256: "a".repeat(64), status: { state: "verified", proposalSha256: "a".repeat(64) },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: [summary] }) });
    const tasks = await listTasks("http://127.0.0.1:8787", "repo-a");
    expect(tasks).toEqual([summary]);
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/tasks?repositoryId=repo-a");
  });
});

describe("task claim / complete endpoint contracts", () => {
  beforeEach(() => mockFetch.mockReset());

  it("claimTask posts to /v1/tasks/claim and returns the claimed result", async () => {
    const resultBody = { status: { state: "claimed", claimedBy: "agent-a" }, created: true };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => resultBody });
    const result = await claimTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1",
      proposalSha256: "p".repeat(64), claimedBy: "agent-a",
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/tasks/claim");
    expect(JSON.parse(String(init.body))).toEqual({
      task: { repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1" },
      proposalSha256: "p".repeat(64), claimedBy: "agent-a",
    });
    expect(result).toEqual(resultBody);
  });

  it("completeLocalTask posts to /v1/tasks/complete-local with localHeadSHA and target", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: { state: "completed_local", completedBy: "agent-a" }, created: true }) });
    await completeLocalTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1",
      proposalSha256: "p".repeat(64), completedBy: "agent-a",
      localHeadSHA: "a".repeat(40), target: "src/feature.ts", leaseId: "lease-1",
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/tasks/complete-local");
    expect(JSON.parse(String(init.body))).toMatchObject({ localHeadSHA: "a".repeat(40), target: "src/feature.ts" });
  });

  it("completeTask posts to /v1/tasks/complete with completedHeadSHA and target", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: { state: "completed" }, created: true }) });
    await completeTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1",
      proposalSha256: "p".repeat(64), completedBy: "agent-a",
      completedHeadSHA: "a".repeat(40), target: "src/feature.ts", leaseId: "lease-1",
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/tasks/complete");
    expect(JSON.parse(String(init.body))).toMatchObject({ completedHeadSHA: "a".repeat(40), target: "src/feature.ts" });
  });
});

describe("task retry and detail contracts", () => {
  beforeEach(() => mockFetch.mockReset());

  it("submitTask retries a retryable 503 and succeeds on the second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "busy", code: "service_unavailable", retryable: true }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ status: { state: "verified" }, created: true }) });
    const result = await submitTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1", branch: "main", headSha: "a".repeat(40),
    });
    expect(result.created).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const [secondUrl, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe(secondUrl);
    expect((firstInit.headers as Record<string, string>)["X-Request-Id"]).toBe((secondInit.headers as Record<string, string>)["X-Request-Id"]);
  });

  it("submitTask does not retry a permanent state conflict", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "conflict", code: "state_conflict", retryable: false }) });
    await expect(submitTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1", branch: "main", headSha: "a".repeat(40),
    })).rejects.toMatchObject({ cause: "http_status", status: 409 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getTaskDetail requests the task path and parses the v2 event chain", async () => {
    const detail = {
      task: { repositoryId: "repo-a", serviceId: "svc-a", taskId: "task-1" },
      title: "clean", hypothesis: "h", requestedBy: "agent-a", proposalSha256: "p".repeat(64),
      goal: "Add login", scope: ["src/auth"], constraints: ["do not touch schema"],
      verification: ["pnpm test auth"], deliverable: "summary and diff",
      status: { state: "verified", proposalSha256: "p".repeat(64) },
      events: [{
        schemaVersion: "2", task: { repositoryId: "repo-a", serviceId: "svc-a", taskId: "task-1" },
        type: "verified", proposalSha256: "p".repeat(64), verifiedHeadSha: "a".repeat(40),
        sequence: 1, prevEventHash: "0".repeat(64), eventHash: "e".repeat(64),
        recordedAt: "2026-08-22T00:00:00Z", signerKeyId: "coordination-task-v1", signature: "sig",
      }],
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => detail });
    const result = await getTaskDetail("http://127.0.0.1:8787", { repositoryId: "repo-a", serviceId: "svc-a", taskId: "task-1" });
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/tasks/repo-a/svc-a/task-1");
    expect(result.events[0]?.sequence).toBe(1);
    expect(result.goal).toBe("Add login");
    expect(result.scope).toEqual(["src/auth"]);
    expect(result.constraints).toEqual(["do not touch schema"]);
    expect(result.verification).toEqual(["pnpm test auth"]);
    expect(result.deliverable).toBe("summary and diff");
  });
});

describe("debt / lease / session endpoint contracts", () => {
  beforeEach(() => mockFetch.mockReset());

  it("listDebts parses summaries and appends the repositoryId filter", async () => {
    const debt = {
      schemaVersion: "1",
      debt: { repositoryId: "repo-a", serviceId: "svc-a", debtId: "debt-1" },
      title: "Defer", reason: "No evidence", reconsiderCondition: "More data", status: "deferred",
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ debts: [debt] }) });
    const debts = await listDebts("http://127.0.0.1:8787", "repo-a");
    expect(debts).toEqual([debt]);
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8787/v1/debts?repositoryId=repo-a");
  });

  it("acquireLease posts the key/owner/ttl and parses the lease", async () => {
    const lease = {
      key: { repositoryId: "repo-a", target: "file:src/feature.ts" },
      leaseId: "lease-1", owner: "agent-a", fencingToken: 1, coordinatorEpoch: 7,
      expiresAt: new Date().toISOString(),
    };
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => lease });
    const result = await acquireLease("http://127.0.0.1:8787", { repositoryId: "repo-a", target: "file:src/feature.ts", owner: "agent-a", ttlSeconds: 30 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/leases/acquire");
    expect(JSON.parse(String(init.body))).toEqual({ key: { repositoryId: "repo-a", target: "file:src/feature.ts" }, owner: "agent-a", ttlSeconds: 30 });
    expect(result).toEqual(lease);
  });

  it("acquireLeaseWithWait polls until a held lease is released", async () => {
    const lease = {
      key: { repositoryId: "repo-a", target: "file:src/feature.ts" },
      leaseId: "lease-1", owner: "agent-b", fencingToken: 2, coordinatorEpoch: 7,
      expiresAt: new Date().toISOString(),
    };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "semantic lease is held" }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "semantic lease is held" }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => lease });
    const result = await acquireLeaseWithWait("http://127.0.0.1:8787", {
      repositoryId: "repo-a", target: "file:src/feature.ts", owner: "agent-b", ttlSeconds: 30,
    }, { timeoutMs: 5000, pollMs: 5 });
    expect(result.leaseId).toBe("lease-1");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("acquireLeaseWithWait throws when the timeout expires", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "semantic lease is held" }) });
    await expect(acquireLeaseWithWait("http://127.0.0.1:8787", {
      repositoryId: "repo-a", target: "file:src/feature.ts", owner: "agent-b", ttlSeconds: 30,
    }, { timeoutMs: 20, pollMs: 5 })).rejects.toMatchObject({ cause: "http_status", status: 409 });
  });

  it("renewLease posts the credential and ttl and parses the lease", async () => {
    const lease = {
      key: { repositoryId: "repo-a", target: "file:src/feature.ts" },
      leaseId: "lease-1", owner: "agent-a", fencingToken: 2, coordinatorEpoch: 7,
      expiresAt: new Date().toISOString(),
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => lease });
    const credential = { leaseId: "lease-1", owner: "agent-a", fencingToken: 2, coordinatorEpoch: 7 };
    const result = await renewLease("http://127.0.0.1:8787", credential, 60);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ credential, ttlSeconds: 60 });
    expect(result).toEqual(lease);
  });

  it("releaseLease posts the credential to /v1/leases/release", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ released: true }) });
    const credential = { leaseId: "lease-1", owner: "agent-a", fencingToken: 2, coordinatorEpoch: 7 };
    await releaseLease("http://127.0.0.1:8787", credential);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/leases/release");
    expect(JSON.parse(String(init.body))).toEqual({ credential });
  });

  it("registerSession posts registration and parses the session", async () => {
    const session = {
      ref: { repositoryId: "repo-a", sessionId: "sess-1" }, owner: "agent-a",
      fencingToken: 1, coordinatorEpoch: 7, startedAt: "2026-01-01T00:00:00Z",
      lastHeartbeat: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:01:00Z",
    };
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => session });
    const result = await registerSession("http://127.0.0.1:8787", { repositoryId: "repo-a", sessionId: "sess-1", owner: "agent-a", ttlSeconds: 60 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/register");
    expect(JSON.parse(String(init.body))).toEqual({ repositoryId: "repo-a", sessionId: "sess-1", owner: "agent-a", ttlSeconds: 60 });
    expect(result).toEqual(session);
  });

  it("heartbeatSession posts credential and ttl", async () => {
    const session = {
      ref: { repositoryId: "repo-a", sessionId: "sess-1" }, owner: "agent-a",
      fencingToken: 2, coordinatorEpoch: 7, startedAt: "2026-01-01T00:00:00Z",
      lastHeartbeat: "2026-01-01T00:00:30Z", expiresAt: "2026-01-01T00:01:30Z",
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => session });
    const credential = { sessionId: "sess-1", owner: "agent-a", fencingToken: 2, coordinatorEpoch: 7 };
    await heartbeatSession("http://127.0.0.1:8787", credential, 90);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ credential, ttlSeconds: 90 });
  });

  it("closeSession posts the credential to /v1/sessions/close", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ closed: true }) });
    const credential = { sessionId: "sess-1", owner: "agent-a", fencingToken: 2, coordinatorEpoch: 7 };
    await closeSession("http://127.0.0.1:8787", credential);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/close");
    expect(JSON.parse(String(init.body))).toEqual({ credential });
  });

  it("listCollection throws invalid_descriptor when the collection field is missing", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: "not-an-array" }) });
    await expect(listTasks("http://127.0.0.1:8787")).rejects.toMatchObject({ cause: "invalid_descriptor" });
  });
});


describe("concurrent coordination requests (L4)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("concurrent acquireLease on the same target yields exactly one winner with independent requests", async () => {
    // Mock service: first acquire for a given target wins (200), later ones are held (409).
    const held = new Set<string>();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const key = `${body.key?.repositoryId}/${body.key?.target}`;
      if (held.has(key)) {
        return { ok: false, status: 409, json: async () => ({ error: "semantic lease is held" }) };
      }
      held.add(key);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          key: { repositoryId: body.key.repositoryId, target: body.key.target },
          leaseId: "lease-1", owner: body.owner, fencingToken: 1, coordinatorEpoch: 7,
          expiresAt: new Date().toISOString(),
        }),
      };
    });
    const acquire = (owner: string) =>
      acquireLease("http://127.0.0.1:8787", { repositoryId: "repo-a", target: "s4#lease", owner, ttlSeconds: 30 });
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map(acquire));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.status === "rejected" && (r as PromiseRejectedResult).reason).toMatchObject({ cause: "http_status", status: 409 });
    }
  });

  it("concurrent submitTask with different tasks sends independent bodies", async () => {
    const seen: Array<{ taskId: string; headSha: string }> = [];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push({ taskId: body.task?.taskId, headSha: body.headSha });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          status: { task: body.task, state: "verified", proposalSha256: "p", verifiedHeadSha: body.headSha },
          created: true,
        }),
      };
    });
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      repositoryId: "repo-a", serviceId: "svc-a", taskId: `task-${i}`,
      branch: "main", headSha: "a".repeat(40).slice(0, 39) + String(i),
    }));
    const results = await Promise.all(tasks.map((t) => submitTask("http://127.0.0.1:8787", t)));
    expect(results).toHaveLength(8);
    // Every request carried its own task identity: no shared-state cross-talk.
    for (const t of tasks) {
      expect(seen).toContainEqual({ taskId: t.taskId, headSha: t.headSha });
    }
  });
});
