import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditConfig } from "../../src/application/configAudit";

const tempDir = () => join(tmpdir(), `openarch-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("auditConfig", () => {
  it("records an initial config, detects drift, then writes an event", () => {
    const base = tempDir();
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.yml"), "rules_warn: []\n");
    expect(auditConfig("record", base, new Date("2026-07-11T00:00:00.000Z")).status).toBe("initialized");
    expect(auditConfig("check", base).status).toBe("unchanged");
    writeFileSync(join(base, "config.yml"), "rules_warn:\n  - name: changed\n");
    expect(auditConfig("check", base).status).toBe("drift");
    const recorded = auditConfig("record", base, new Date("2026-07-11T01:00:00.000Z"));
    expect(recorded.status).toBe("recorded");
    expect(recorded.eventPath).toContain("config-events");
    expect(auditConfig("check", base).status).toBe("unchanged");
    rmSync(base, { recursive: true, force: true });
  });

  it("requires an explicit initial record in check mode", () => {
    const base = tempDir();
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.yml"), "rules_warn: []\n");
    expect(auditConfig("check", base).status).toBe("uninitialized");
    rmSync(base, { recursive: true, force: true });
  });
});
