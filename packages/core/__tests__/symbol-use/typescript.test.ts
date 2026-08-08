import { describe, expect, it } from "vitest";
import { join } from "node:path";
import ts from "typescript";
import { collectTypeScriptSymbolUse } from "../../src/symbol-use/typescriptCollection";
import { semanticEvidenceView } from "../support/semanticEvidence";
import { withTsProject } from "../support/tsProject";

describe("collectTypeScriptSymbolUse", () => {
  it("distinguishes isolated internal properties from referenced and public declarations", () => {
    withTsProject([
      { path: "src/internal.ts", content: [
        "interface InternalOptions {",
        "  stale: string;",
        "  active: string;",
        "}",
        "const options = {} as InternalOptions;",
        "console.log(options.active);",
      ].join("\n") },
      { path: "src/index.ts", content: [
        "export interface PublicOptions {",
        "  reserved: string;",
        "}",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(report.state.availability).toBe("available");
      expect(semanticEvidenceView(report)).toMatchObject({
        providerId: "typescript-symbol-use",
        evidenceSource: "compiler",
        coverage: { declarations: "complete", repositoryReferences: "complete" },
      });
      expect(fact("InternalOptions.stale")).toMatchObject({ publicSurface: "internal", repositoryReferences: [] });
      expect(fact("InternalOptions.active")?.repositoryReferences).toHaveLength(1);
      expect(fact("PublicOptions.reserved")).toMatchObject({ publicSurface: "declared-public", repositoryReferences: [] });
    }, { tsconfig: { compilerOptions: { strict: true }, include: ["src/**/*.ts"] } });
  });

  it("returns unavailable rather than an empty result without tsconfig evidence", () => {
    withTsProject([], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      expect(semanticEvidenceView(report)).toMatchObject({
        providerId: "typescript-symbol-use",
        evidenceSource: "compiler",
        availability: "unavailable",
        coverage: { declarations: "unavailable", repositoryReferences: "unavailable" },
        facts: [],
      });
    });
  });

  it("collects compiler-resolved class and function references across imports and aliases", () => {
    withTsProject([
      { path: "src/producer.ts", content: [
        "export class PublicService { perform() {} }",
        "class InternalService {}",
        "export const exportedWorker = () => new PublicService();",
        "const localWorker = () => new InternalService();",
        "export { localWorker as workerAlias };",
        "function unusedInternal() {}",
      ].join("\n") },
      { path: "src/consumer.ts", content: [
        'import { PublicService, workerAlias } from "./producer.js";',
        "const service = new PublicService();",
        "workerAlias();",
        "service.perform();",
        "void service;",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(semanticEvidenceView(report)).toMatchObject({ availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } });
      expect(fact("PublicService")).toMatchObject({ publicSurface: "declared-public" });
      expect(fact("PublicService")?.repositoryReferences).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: "src/consumer.ts", line: 1 }),
        expect.objectContaining({ file: "src/consumer.ts", line: 2 }),
      ]));
      expect(fact("localWorker")).toMatchObject({ publicSurface: "declared-public", repositoryReferences: expect.arrayContaining([
        expect.objectContaining({ file: "src/consumer.ts", line: 3 }),
      ]) });
      expect(fact("PublicService.perform")).toMatchObject({
        declaration: { kind: "method" },
        publicSurface: "declared-public",
        repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/consumer.ts", line: 4 })]),
      });
      expect(fact("unusedInternal")).toMatchObject({ publicSurface: "internal", repositoryReferences: [] });
    }, { tsconfig: { compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src/**/*.ts"] } });
  });

  it("marks references partial when governed files fall outside every tsconfig project", () => {
    withTsProject([
      { path: "src/included.ts", content: "export function included() {}\n" },
      { path: "outside.ts", content: "function outside() {}\n" },
    ], (cwd) => {
      expect(semanticEvidenceView(collectTypeScriptSymbolUse(cwd))).toMatchObject({
        availability: "partial",
        coverage: { declarations: "partial", repositoryReferences: "partial" },
        reason: "some governed source files are outside the resolved TypeScript project",
        facts: expect.arrayContaining([expect.objectContaining({ declaration: expect.objectContaining({ name: "included" }) })]),
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("uses the shared demand scope and does not claim repository completeness", () => {
    withTsProject([
      { path: "src/api.ts", content: "export function publish() {}\nexport function untouched() {}\n" },
      { path: "src/consumer.ts", content: 'import { publish } from "./api"; publish();\n' },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd, "typescript", {
        declarations: [{ file: "src/api.ts", names: ["publish"] }],
      });

      expect(semanticEvidenceView(report)).toMatchObject({
        availability: "partial",
        coverage: { declarations: "partial", repositoryReferences: "partial" },
        scope: { mode: "demand", governedFileCount: 2, selectedDeclarationFileCount: 1, declarationFamilies: expect.arrayContaining(["callable", "type", "property"]) },
        reason: expect.stringContaining("demand-driven semantic query selected 1/2"),
      });
      expect(report.facts.map((fact) => fact.declaration.name)).toEqual(["publish"]);
      expect(report.facts[0]?.repositoryReferences).toEqual([expect.objectContaining({ file: "src/consumer.ts", line: 1 })]);
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("follows a project reference from emitted declarations back to the governed source declaration", () => {
    withTsProject([
      { path: "packages/contracts/tsconfig.json", content: JSON.stringify({
        compilerOptions: {
          composite: true, declaration: true, module: "NodeNext", moduleResolution: "NodeNext",
          target: "ESNext", rootDir: "src", outDir: "dist",
        },
        include: ["src/**/*.ts"],
      }) },
      { path: "packages/contracts/src/index.ts", content: [
        "export function contractWorker() {}",
        "export function unusedContractWorker() {}",
      ].join("\n") },
      { path: "packages/app/tsconfig.json", content: JSON.stringify({
        compilerOptions: {
          composite: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ESNext",
          rootDir: "src", outDir: "dist",
        },
        references: [{ path: "../contracts" }],
        include: ["src/**/*.ts"],
      }) },
      { path: "packages/app/src/consumer.ts", content: [
        'import { contractWorker } from "../../contracts/dist/index.js";',
        "contractWorker();",
      ].join("\n") },
    ], (cwd) => {
      const contracts = join(cwd, "packages", "contracts");

      const host = ts.createSolutionBuilderHost();
      const builder = ts.createSolutionBuilder(host, [join(contracts, "tsconfig.json")], {});
      expect(builder.build()).toBe(ts.ExitStatus.Success);

      const report = collectTypeScriptSymbolUse(cwd);
      const fact = report.facts.find((entry) => entry.declaration.name === "contractWorker");
      const unused = report.facts.find((entry) => entry.declaration.name === "unusedContractWorker");

      expect(semanticEvidenceView(report)).toMatchObject({ availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } });
      expect(fact).toMatchObject({
        declaration: { file: "packages/contracts/src/index.ts", line: 1 },
        repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "packages/app/src/consumer.ts", line: 1 })]),
      });
      expect(fact?.repositoryReferences).toHaveLength(2);
      expect(unused).toMatchObject({ publicSurface: "declared-public", repositoryReferences: [] });
    });
  });

  it("keeps test-only files outside the production symbol-use scope", () => {
    withTsProject([
      { path: "src/included.ts", content: "export function included() {}\n" },
      { path: "tests/outside.test.ts", content: "function helperForTest() {}\n" },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      expect(semanticEvidenceView(report)).toMatchObject({ availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } });
      expect(report.facts.some((fact) => fact.declaration.name === "helperForTest")).toBe(false);
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("uses declaration identity for class accessors and object-property functions", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "class InternalService {",
        "  get value() { return 1; }",
        "  set value(next: number) { void next; }",
        "}",
        "const service = new InternalService();",
        "void service.value;",
        "service.value = 2;",
        "const handlers = { execute: () => {}, stale: () => {} };",
        "handlers.execute();",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("InternalService.value")).toMatchObject({
        declaration: { kind: "accessor" },
        publicSurface: "internal",
        repositoryReferences: expect.arrayContaining([
          expect.objectContaining({ file: "src/members.ts", line: 6 }),
          expect.objectContaining({ file: "src/members.ts", line: 7 }),
        ]),
      });
      expect(fact("execute")).toMatchObject({
        declaration: { kind: "object-property-function" },
        publicSurface: "unknown",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 9 })],
      });
      expect(fact("stale")).toMatchObject({ publicSurface: "unknown", repositoryReferences: [] });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("collects interface method signatures without confusing public and internal zero-reference evidence", () => {
    withTsProject([
      { path: "src/contract.ts", content: [
        "interface InternalActions { stale(): void; run(): void; }",
        "export interface PublicActions { external(): void; }",
        "export const actions: InternalActions = { stale: () => {}, run: () => {} };",
      ].join("\n") },
      { path: "src/consumer.ts", content: [
        'import { actions } from "./contract";',
        "actions.run();",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("InternalActions.stale")).toMatchObject({
        declaration: { kind: "interface-method" }, publicSurface: "internal", repositoryReferences: [],
      });
      expect(fact("InternalActions.run")).toMatchObject({
        declaration: { kind: "interface-method" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/consumer.ts", line: 2 })],
      });
      expect(fact("PublicActions.external")).toMatchObject({
        declaration: { kind: "interface-method" }, publicSurface: "declared-public", repositoryReferences: [],
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("collects type-literal contracts, including compiler-resolved literal member access", () => {
    withTsProject([
      { path: "src/contract.ts", content: [
        "type InternalOptions = { stale: string; run(): void; [\"literal\"](): void };",
        "export type PublicOptions = { external(): void };",
        "export const options: InternalOptions = { stale: \"\", run() {}, literal() {} };",
        "type SelectedRun = InternalOptions[\"run\"];",
      ].join("\n") },
      { path: "src/consumer.ts", content: [
        'import { options } from "./contract";',
        "options.run();",
        "options[\"literal\"]();",
        "const { run: selectedRun } = options; selectedRun();",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("InternalOptions.stale")).toMatchObject({
        declaration: { kind: "type-property" }, publicSurface: "internal", repositoryReferences: [],
      });
      expect(fact("InternalOptions.run")).toMatchObject({
        declaration: { kind: "type-method" }, publicSurface: "internal",
        repositoryReferences: expect.arrayContaining([
          expect.objectContaining({ file: "src/contract.ts", line: 4 }),
          expect.objectContaining({ file: "src/consumer.ts", line: 2 }),
          expect.objectContaining({ file: "src/consumer.ts", line: 4 }),
        ]),
      });
      expect(fact("InternalOptions.literal")).toMatchObject({
        declaration: { kind: "type-method" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/consumer.ts", line: 3 })],
      });
      expect(fact("PublicOptions.external")).toMatchObject({
        declaration: { kind: "type-method" }, publicSurface: "declared-public", repositoryReferences: [],
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("keeps protected extension contracts public while retaining private and internal members", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "export class PublicBase {",
        "  protected extensionPoint() {}",
        "  private privateUnused() {}",
        "}",
        "class InternalBase {",
        "  protected stale() {}",
        "}",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("PublicBase.extensionPoint")).toMatchObject({
        publicSurface: "declared-public", repositoryReferences: [],
      });
      expect(fact("PublicBase.privateUnused")).toMatchObject({
        publicSurface: "internal", repositoryReferences: [],
      });
      expect(fact("InternalBase.stale")).toMatchObject({
        publicSurface: "internal", repositoryReferences: [],
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("uses one declaration identity for overloads and retains generic member references", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "function parse(value: string): string;",
        "function parse(value: number): string;",
        "function parse(value: string | number): string { return String(value); }",
        "interface InternalWorker {",
        "  run(value: string): string;",
        "  run(value: number): string;",
        "}",
        "class InternalBox {",
        "  get<T>(value: T): T { return value; }",
        "}",
        "const worker: InternalWorker = { run: (value) => String(value) };",
        "const box = new InternalBox();",
        "parse(1);",
        "worker.run(2);",
        "box.get<string>(\"value\");",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const facts = (name: string) => report.facts.filter((entry) => entry.declaration.name === name);

      expect(facts("parse")).toHaveLength(1);
      expect(facts("parse")[0]).toMatchObject({
        publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 13 })],
      });
      expect(facts("InternalWorker.run")).toHaveLength(1);
      expect(facts("InternalWorker.run")[0]).toMatchObject({
        declaration: { kind: "interface-method" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 14 })],
      });
      expect(facts("InternalBox.get")).toMatchObject([
        {
          declaration: { kind: "method" }, publicSurface: "internal",
          repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 15 })],
        },
      ]);
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("does not turn interface implementation or inherited dispatch members into isolated declarations", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "interface Runner { run(): void; readonly value: number; }",
        "class InterfaceImplementation implements Runner {",
        "  run() {}",
        "  get value() { return 1; }",
        "}",
        "class Base {",
        "  run() {}",
        "  get value() { return 1; }",
        "}",
        "class Derived extends Base {",
        "  run() {}",
        "  get value() { return 2; }",
        "}",
        "const runner: Runner = new InterfaceImplementation();",
        "runner.run();",
        "void runner.value;",
        "const base: Base = new Derived();",
        "base.run();",
        "void base.value;",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("InterfaceImplementation.run")).toMatchObject({ publicSurface: "unknown" });
      expect(fact("InterfaceImplementation.value")).toMatchObject({ publicSurface: "unknown" });
      expect(fact("Derived.run")).toMatchObject({ publicSurface: "unknown" });
      expect(fact("Derived.value")).toMatchObject({ publicSurface: "unknown" });
      expect(fact("Runner.run")).toMatchObject({
        publicSurface: "internal", repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 15 })],
      });
      expect(fact("Base.run")).toMatchObject({
        publicSurface: "internal", repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 18 })],
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("collects callable class fields and object method shorthand without guessing object escape", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "interface Contract { execute(): void; }",
        "export class PublicHandler { handler = () => {}; private stale = () => {}; }",
        "class InternalHandler { run = () => {}; }",
        "class Implementation implements Contract { execute = () => {}; }",
        "const internal = new InternalHandler();",
        "internal.run();",
        "const contract: Contract = new Implementation();",
        "contract.execute();",
        "const handlers = { execute() {}, stale() {} };",
        "handlers.execute();",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("PublicHandler.handler")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "declared-public",
      });
      expect(fact("PublicHandler.stale")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "internal", repositoryReferences: [],
      });
      expect(fact("InternalHandler.run")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 6 })],
      });
      expect(fact("Implementation.execute")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "unknown",
      });
      expect(fact("execute")).toMatchObject({
        declaration: { kind: "object-property-function" }, publicSurface: "unknown",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 10 })],
      });
      expect(fact("stale")).toMatchObject({
        declaration: { kind: "object-property-function" }, publicSurface: "unknown", repositoryReferences: [],
      });
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });

  it("uses compiler-resolved private and literal member access without guessing dynamic keys", () => {
    withTsProject([
      { path: "src/members.ts", content: [
        "class InternalStore {",
        "  #secret = () => {};",
        "  [\"literalMethod\"]() {}",
        "  [\"literalField\"] = () => {};",
        "  static [\"staticMethod\"]() {}",
        "  invokeSecret() { this.#secret(); }",
        "}",
        "const store = new InternalStore();",
        "store[\"literalMethod\"]();",
        "store[\"literalField\"]();",
        "InternalStore[\"staticMethod\"]();",
        "const runtimeKey = \"literalMethod\";",
        "store[runtimeKey]();",
      ].join("\n") },
    ], (cwd) => {
      const report = collectTypeScriptSymbolUse(cwd);
      const fact = (name: string) => report.facts.find((entry) => entry.declaration.name === name);

      expect(fact("InternalStore.#secret")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 6 })],
      });
      expect(fact("InternalStore.literalMethod")).toMatchObject({
        declaration: { kind: "method" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 9 })],
      });
      expect(fact("InternalStore.literalField")).toMatchObject({
        declaration: { kind: "class-property-function" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 10 })],
      });
      expect(fact("InternalStore.staticMethod")).toMatchObject({
        declaration: { kind: "method" }, publicSurface: "internal",
        repositoryReferences: [expect.objectContaining({ file: "src/members.ts", line: 11 })],
      });
      expect(fact("InternalStore.literalMethod")?.repositoryReferences).toHaveLength(1);
    }, { tsconfig: { include: ["src/**/*.ts"] } });
  });
});
