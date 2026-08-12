import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { pytestProvider } from "../../src/test-governance/providers/pytest";
import { pytestRunner } from "../../src/test-governance/runners/pytest";

const dir = join(tmpdir(), `openarch-pytest-provider-${Date.now()}`);
const file = join(dir, "tests", "test_sample.py");
const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => pytestProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(file, [
    "import pytest",
    "from unittest.mock import MagicMock",
    "@pytest.fixture",
    "def fixture_value(): return 1",
    "@pytest.fixture",
    "def test_fixture_value(): return 1",
    "def test_assertion(): assert fixture_value() == 1",
    "@pytest.mark.skip(reason='maintenance')",
    "def test_marked(): assert True",
    "@pytest.mark.xfail(reason='known')",
    "def test_expected_failure(): assert False",
    "def test_skip_call(): pytest.skip('conditional')",
    "def test_raises():\n    with pytest.raises(ValueError):\n        raise ValueError('expected')",
    "def assert_created(entity):\n    assert entity is not None",
    "def validate_created(entity):\n    assert entity.id is not None",
    "def test_assert_helper(): assert_created(obj)",
    "def test_validate_helper(): validate_created(obj)",
    "def test_mock(monkeypatch):\n    monkeypatch.setattr('module.value', 1)\n    MagicMock()\n    assert True",
    "def test_nested():\n    def test_helper():\n        assert True\n    test_helper()",
    "class Helper:\n    def test_not_collected(self):\n        assert True",
    "class TestMethods:\n    def test_method(self):\n        if True:\n            assert True\n        callback = lambda: assert_not_valid\n        return callback",
  ].join("\n"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pytestProvider", () => {
  it("collects standard pytest tests without treating fixtures or nested test-named helpers as cases", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => test.name)).toEqual([
      "test_assertion", "test_marked", "test_expected_failure", "test_skip_call", "test_raises", "test_assert_helper", "test_validate_helper", "test_mock", "test_nested", "test_method",
    ]);
    expect(result.tests.find((test) => test.name === "test_assertion")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "test_marked")?.statuses).toEqual(["skipped"]);
    expect(result.tests.find((test) => test.name === "test_expected_failure")?.statuses).toEqual(["xfail"]);
    expect(result.tests.find((test) => test.name === "test_raises")?.assertionCount).toBe(1);
    // P3（2026-08-12 体验反馈）：同文件内体内含 assert 的包装函数（非前缀命名）视为断言
    expect(result.tests.find((test) => test.name === "test_assert_helper")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "test_validate_helper")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "test_mock")?.mockCount).toBe(2);
    expect(result.tests.find((test) => test.name === "test_nested")?.assertionCount).toBe(0);
    expect(result.tests.find((test) => test.name === "test_method")?.testBodyControlFlow).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "python-pytest.skip-marker", testName: "test_marked", confidence: "high" }),
      expect.objectContaining({ ruleId: "python-pytest.skip-call", testName: "test_skip_call", confidence: "high" }),
      expect.objectContaining({ ruleId: "python-pytest.missing-known-assertion", testName: "test_nested", confidence: "low" }),
    ]));
    expect(result.findings.some((finding) => finding.testName === "fixture_value")).toBe(false);
    expect(result.findings.some((finding) => finding.testName === "test_fixture_value")).toBe(false);
    expect(result.findings.some((finding) => finding.testName === "test_helper")).toBe(false);
    expect(result.findings.some((finding) => finding.testName === "test_not_collected")).toBe(false);
  });

  it("does not execute a directory without pytest project evidence", async () => {
    const other = join(tmpdir(), `openarch-not-pytest-${Date.now()}`);
    mkdirSync(other, { recursive: true });
    try {
      await expect(pytestRunner.run(other)).resolves.toMatchObject({ passed: false, detail: "pytest project configuration not found" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
