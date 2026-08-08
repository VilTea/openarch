// engine.executeRule 集成测试——验证引擎驱动的管道（text→ast→link）纪律
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { executeRule } from "../../src/implicit-deps/engine";
import type { ParserService as ParserServiceIf } from "../../src/port/ParserService";
import { createProjectFacts } from "../../src/script-runtime/projectFacts";

const tmpDir = join(tmpdir(), `openarch-engine-${Date.now()}`);
const fixture = (name: string) => resolve(__dirname, "..", "..", "fixtures", name);

const mockParser: ParserServiceIf = {
  parse: (p: string) => Effect.die("not used"),
  query: (p: string, pattern: string) => Effect.succeed([
    { captures: [{ name: "stmt", text: "bus.emit('test')" }] },
  ]),
  supportedLanguages: Effect.succeed(["typescript" as const]),
};

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true });
  // 有效规则：含 text + ast + link 三个 stage
  writeFileSync(join(tmpDir, "valid.mjs"), `export default {
  stages: {
  text({ files, text }) {
    return files.filter(f => f.endsWith(".ts"));
  },
  ast: {
    pattern: "(expression_statement) @stmt",
    extract(matches) {
      return matches.map(m => ({ stmt: m.captures[0]?.text ?? "" }));
    },
  },
  },
  link({ records, log }) {
    log(records.length + " records");
    return records.map(r => ({
      from: r._file, to: "sink.ts", via: "event:test", type: "event_bus",
    }));
  },
};`);
  // 仅有 link（无 text/ast——合法）
  writeFileSync(join(tmpDir, "link-only.mjs"), `export default {
  stages: {},
  link({ records, log }) {
    return records.map(r => ({
      from: r._file, to: "sink.ts", via: "none", type: "http_rpc",
    }));
  },
};`);
  // 缺 link —— 非法
  writeFileSync(join(tmpDir, "no-link.mjs"), `export default { stages: { text({ files }) { return [...files]; } } };`);
});
afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("engine.executeRule", () => {
  it("完整管道（text+ast+link）——引擎保证：query 只对 text 输出跑、link 只收到 extract 产出", async () => {
    const files = [fixture("eventbus-demo.ts"), fixture("eventbus-demo.ts").replace(/\.ts$/, ".json")]; // .json 被 text 筛掉
    const mockImport = async (_url: string): Promise<Record<string, unknown>> => ({
      default: {
        stages: {
        text: ({ files: fs, text: tx }: { files: readonly string[]; text: (p: string) => string }) =>
          fs.filter(f => f.endsWith(".ts")),
        ast: {
          pattern: "(expression_statement) @stmt",
          extract: (matches: Array<{ captures: Array<{ text: string }> }>) =>
            matches.map(m => ({ stmt: m.captures[0]?.text ?? "" })),
        },
        },
        link: ({ records, log }: { records: Array<{ _file: string; stmt: string }>; log: (...a: unknown[]) => void }) => {
          log(`${records.length} records`);
          return records.map(r => ({ from: r._file, to: "sink.ts", via: "event:test", type: "event_bus" }));
        },
      },
    });
    const { edges, error } = await executeRule(
      join(tmpDir, "valid.mjs"), files, mockParser, mockImport,
    );
    expect(error).toBeUndefined();
    // text 筛掉 .json → 1 文件；ast extract 每条 statement 一条记录；link 每条记录产生一条边
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0].from).toContain("eventbus-demo");
    expect(edges[0].type).toBe("event_bus");
  });

  it("仅 link（无 text/ast）——引擎直接进 link，records 是 files 的 {_file} 列表", async () => {
    const files = [fixture("eventbus-demo.ts")];
    const mockImport = async (_url: string): Promise<Record<string, unknown>> => ({
      default: {
        stages: {},
        link: ({ records }: { records: Array<{ _file: string }> }) =>
          records.map(r => ({ from: r._file, to: "sink.ts", via: "raw", type: "http_rpc" })),
      },
    });
    const { edges, error } = await executeRule(
      join(tmpDir, "link-only.mjs"), files, mockParser, mockImport,
    );
    expect(error).toBeUndefined();
    expect(edges).toHaveLength(1);
    expect(edges[0].via).toBe("raw");
  });

  it("缺 link stage → error", async () => {
    const mockImport = async (_url: string): Promise<Record<string, unknown>> => ({
      default: {
        stages: {
        text: ({ files: fs }: { files: readonly string[] }) => [...fs],
      },
      },
    });
    const { edges, error } = await executeRule(
      join(tmpDir, "no-link.mjs"), [], mockParser, mockImport,
    );
    expect(error).toBeDefined();
    expect(edges).toHaveLength(0);
  });

  it("不存在的 mjs → error", async () => {
    const mockImport = async (_url: string): Promise<Record<string, unknown>> => { throw new Error("ENOENT"); };
    const { edges, error } = await executeRule(
      join(tmpDir, "ghost.mjs"), [], mockParser, mockImport,
    );
    expect(error).toBeDefined();
    expect(edges).toHaveLength(0);
  });

  it("does not let an implicit-dependency rule treat missing metrics as clean input", async () => {
    const { edges, unavailable } = await executeRule("metrics.mjs", [fixture("eventbus-demo.ts")], mockParser, async () => ({
      default: {
        requires: ["structure-metrics.v1"], stages: {},
        link: () => { throw new Error("must not execute"); },
      },
    }));
    expect(edges).toEqual([]);
    expect(unavailable).toContain("structure-metrics.v1");
  });

  it("derives a script-local authority through the shared runtime without project configuration", async () => {
    const files = ["src/owned.ts", "src/other.ts"];
    const { edges, error } = await executeRule("local-authority.mjs", files, mockParser, async () => ({
      default: {
        authority: { id: "local-owner", owner: "src/owner.ts", protectedPaths: ["src/owned.ts"] },
        targets: { authority: ["local-owner"] },
        stages: {},
        link: ({ records, facts }: { records: Array<{ _file: string }>; facts: { authorities: { value?: Array<{ id: string }> } } }) => records.map((record) => ({
          from: record._file, to: "sink.ts", via: facts.authorities.value?.[0]?.id ?? "missing", type: "event_bus",
        })),
      },
    }), { facts: createProjectFacts({ files }) });

    expect(error).toBeUndefined();
    expect(edges).toEqual([{ from: "src/owned.ts", to: "sink.ts", via: "local-owner", type: "event_bus" }]);
  });

  it("normalizes project endpoints and removes duplicate semantic edges", async () => {
    const source = fixture("eventbus-demo.ts");
    const { edges, error } = await executeRule("dedupe.mjs", [source], mockParser, async () => ({
      default: {
        stages: {},
        link: () => [
          { from: source, to: "sink.ts", via: "event:ready", type: "event_bus" },
          { from: source, to: "sink.ts", via: "event:ready", type: "event_bus" },
        ],
      },
    }));

    expect(error).toBeUndefined();
    expect(edges).toEqual([expect.objectContaining({ to: "sink.ts", via: "event:ready", type: "event_bus" })]);
    expect(edges[0].from).toMatch(/(?:^|\/)fixtures\/eventbus-demo\.ts$/);
    expect(edges[0].from).not.toMatch(/^[A-Za-z]:/);
  });

  it("rejects malformed or out-of-project dependency endpoints", async () => {
    const malformed = await executeRule("malformed.mjs", [], mockParser, async () => ({
      default: { stages: {}, link: () => [{ from: "a.ts", to: "b.ts", via: "event" }] },
    }));
    const outside = await executeRule("outside.mjs", [], mockParser, async () => ({
      default: { stages: {}, link: () => [{ from: "../outside.ts", to: "b.ts", via: "event", type: "event_bus" }] },
    }));

    expect(malformed.error).toContain("from/to/via/type");
    expect(outside.error).toContain("项目内");
  });
});
