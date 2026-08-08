// packages/core/__tests__/coordination/CoordinationClient.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CoordinationError, acquireLease, fetchDocsRepoDescriptor, postDocsRepoRefresh, postEvidence, submitTask } from "../../src/coordination/CoordinationClient";

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

  it("sends {repositoryId, branch, headSha} and resolves on 2xx", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await postDocsRepoRefresh("http://127.0.0.1:8787", { repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/docs-repo/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ repositoryId: "repo-1", branch: "main", headSha: "a".repeat(40) });
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
