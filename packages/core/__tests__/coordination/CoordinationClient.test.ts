// packages/core/__tests__/coordination/CoordinationClient.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  CoordinationError,
  acquireLease,
  claimTask,
  closeSession,
  completeTask,
  fetchDocsRepoDescriptor,
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

  it("completeTask posts to /v1/tasks/complete and omits completedHeadSHA when absent", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: { state: "completed", completedBy: "agent-a" }, created: false }) });
    await completeTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1",
      proposalSha256: "p".repeat(64), completedBy: "agent-a",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("completedHeadSHA");
  });

  it("completeTask includes completedHeadSHA when provided", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: { state: "completed" }, created: false }) });
    await completeTask("http://127.0.0.1:8787", {
      repositoryId: "repo-1", serviceId: "svc-1", taskId: "task-1",
      proposalSha256: "p".repeat(64), completedBy: "agent-a", completedHeadSHA: "a".repeat(40),
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ completedHeadSHA: "a".repeat(40) });
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
      key: { repositoryId: "repo-a", target: "s1" },
      leaseId: "lease-1", owner: "agent-a", fencingToken: 1, coordinatorEpoch: 7,
      expiresAt: new Date().toISOString(),
    };
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => lease });
    const result = await acquireLease("http://127.0.0.1:8787", { repositoryId: "repo-a", target: "s1", owner: "agent-a", ttlSeconds: 30 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/leases/acquire");
    expect(JSON.parse(String(init.body))).toEqual({ key: { repositoryId: "repo-a", target: "s1" }, owner: "agent-a", ttlSeconds: 30 });
    expect(result).toEqual(lease);
  });

  it("renewLease posts the credential and ttl and parses the lease", async () => {
    const lease = {
      key: { repositoryId: "repo-a", target: "s1" },
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
