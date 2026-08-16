import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as coreModule from "@openarch/core";
import { coordinationCommand } from "../../src/commands/coordination";
import type { CommandContext } from "../../src/runtime";

const baseContext = (cwd: string): CommandContext => ({
  cwd, rawArgv: [], locale: "zh", args: [],
} as unknown as CommandContext);

const tempProject = () => {
  // reuse the temp-dir helper pattern from existing cli tests (see docsCommand.test.ts)
  return require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "openarch-coord-"));
};

describe("coordinationCommand", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("reports not_configured and exits 3 when no coordination config", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["status"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("未配置"));
  });

  it("rejects unknown actions with usage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["bogus"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("status"));
  });
});

describe("coordination bootstrap / refresh / scope", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("bootstrap fails with exit 3 when service unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = tempProject();
    // configure a coordination url pointing at nothing
    const fs = require("node:fs");
    const path = require("node:path");
    fs.mkdirSync(path.join(cwd, ".openarch"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".openarch", "coordination.json"), JSON.stringify({ version: 1, url: "http://127.0.0.1:1" }));
    const code = await coordinationCommand(["bootstrap"], baseContext(cwd));
    expect(code).toBe(3);
  });

  it("scope register writes the document into the associated docs-repo", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = tempProject();
    const docsRepo = tempProject();
    fs.mkdirSync(path.join(docsRepo, ".git"), { recursive: true });
    vi.spyOn(coreModule, "statusDocsRepo").mockReturnValue({ associated: true, config: { target: docsRepo }, symlinkValid: true });
    const code = await coordinationCommand(["scope", "register", "--repository-id", "repo-1"], baseContext(cwd));
    expect(code).toBe(0);
    const written = fs.readFileSync(path.join(docsRepo, "repositories", "repo-1", "scope.json"), "utf8");
    expect(JSON.parse(written)).toEqual({ schemaVersion: "1", repository: { repositoryId: "repo-1" } });
  });

  it("scope migrate-legacy writes an explicit repositoryId registration and never rewrites legacy", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = tempProject();
    const docsRepo = tempProject();
    fs.mkdirSync(path.join(docsRepo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(docsRepo, "projects", "legacy-a"), { recursive: true });
    vi.spyOn(coreModule, "statusDocsRepo").mockReturnValue({ associated: true, config: { target: docsRepo }, symlinkValid: true });
    const code = await coordinationCommand(["scope", "migrate-legacy", "--legacy-path", "projects/legacy-a", "--repository-id", "repo-explicit"], baseContext(cwd));
    expect(code).toBe(0);
    const written = fs.readFileSync(path.join(docsRepo, "repositories", "repo-explicit", "scope.json"), "utf8");
    expect(JSON.parse(written)).toEqual({ schemaVersion: "1", repository: { repositoryId: "repo-explicit" } });
    expect(fs.existsSync(path.join(docsRepo, "projects", "legacy-a"))).toBe(true);
  });

  it("scope migrate-legacy rejects a basename-like identity source", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["scope", "migrate-legacy", "--legacy-path", "projects/a/b", "--repository-id", "repo-1"], baseContext(tempProject()));
    expect(code).toBe(3);
  });

  it("scope register fails closed without an associated docs-repo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(coreModule, "statusDocsRepo").mockReturnValue({ associated: false, config: null, symlinkValid: false });
    const code = await coordinationCommand(["scope", "register", "--repository-id", "repo-1"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("docs-repo"));
  });

  it("scope register rejects path-like id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["scope", "register", "--repository-id", "a/b"], baseContext(tempProject()));
    expect(code).toBe(3);
  });
});

describe("coordination debt", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("debt register writes an Agent-owned deferred decision template", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = tempProject();
    const docsRepo = tempProject();
    fs.mkdirSync(path.join(docsRepo, ".git"), { recursive: true });
    vi.spyOn(coreModule, "statusDocsRepo").mockReturnValue({ associated: true, config: { target: docsRepo }, symlinkValid: true });
    const code = await coordinationCommand(["debt", "register", "--repository-id", "repo-1", "--service-id", "svc-a", "--debt-id", "debt-1", "--title", "Defer split", "--reason", "No evidence", "--reconsider-condition", "Third language"], baseContext(cwd));
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(docsRepo, "debts", "repo-1", "svc-a", "debt-1.json"), "utf8"));
    expect(written).toMatchObject({ schemaVersion: "1", debt: { repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1" }, status: "deferred" });
  });

  it("debt register fails closed without a docs-repo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(coreModule, "statusDocsRepo").mockReturnValue({ associated: false, config: null, symlinkValid: false });
    const code = await coordinationCommand(["debt", "register", "--repository-id", "repo-1", "--service-id", "svc-a", "--debt-id", "d1", "--title", "x", "--reason", "y", "--reconsider-condition", "z"], baseContext(tempProject()));
    expect(code).toBe(3);
  });
});

describe("coordination evidence / task", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("evidence upload requires an evidence file argument", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["evidence"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("evidence"));
  });

  it("task submit requires explicit ids and head", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["task"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--task-id"));
  });

  it("task claim requires a proposal sha and executor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["claim", "--task-id", "t1"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--proposal-sha256"));
  });

  it("task complete requires an executor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["complete", "--task-id", "t1"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--completed-by"));
  });

  it("lease acquire requires repository, target and owner", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["lease", "acquire", "--target", "svc"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--repository-id"));
  });

  it("lease renew requires full credential", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await coordinationCommand(["lease", "renew", "--lease-id", "1:2"], baseContext(tempProject()));
    expect(code).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--fencing-token"));
  });
});
