/**
 * OpenArch DSH 插件 — 工具结果渲染层（Host 纯逻辑）。
 *
 * 把工具的 canonical JSON 值投影成模型文本：只挑决策相关事实，
 * 全文保留在 canonical JSON 里。与 openarch-tools-run.mjs 一起
 * 从 openarch-tools.mjs 拆出（控制单文件局部负担）。
 */
import { tailChars } from "./openarch-tools-run.mjs";

/** 渲染 context 工具的模型文本。 */
export function renderContextText(value) {
  if (!value.ok) return `openarch context 失败：${value.error}`;
  if (!value.initialized) return "当前目录未初始化 OpenArch（无 .openarch/config.yml）。";
  const context = value.context ?? {};
  const baseline = context.baseline ?? {};
  const policy = context.architecturePolicy ?? {};
  const changes = context.changes ?? {};
  const readiness = Array.isArray(context.readiness) ? context.readiness : [];
  const notReady = readiness.filter((r) => r && typeof r.state === "string" && r.state !== "ready").map((r) => r.id);
  const lines = [
    `OpenArch 项目事实（${value.root}）：`,
    `- 配置: ${context.configuration ?? "unknown"}`,
    `- baseline: ${baseline.available === true ? `${baseline.files ?? "?"} files, ${baseline.scope ?? "unknown"} scope, ${baseline.freshness ?? "unknown"}` : "unavailable"}`,
    `- 策略: ${policy.state ?? "unknown"}, ${policy.declaredRules ?? "?"} declared rules`,
    `- 变更: worktree ${changes.worktree?.paths?.length ?? "?"} paths (${changes.worktree?.sourcePaths?.length ?? "?"} src), staged ${changes.staged?.paths?.length ?? "?"} paths (${changes.staged?.sourcePaths?.length ?? "?"} src)`,
  ];
  if (notReady.length > 0) {
    lines.push(`- readiness 未就绪: ${notReady.join(", ")}（如 code-hook 未装时提交不经过门禁）`);
  }
  return lines.join("\n");
}

/** 渲染 check/review/scan 的模型文本。 */
export function renderGateText(value, kind) {
  if (!value.ok) return `openarch ${kind} 失败：${value.error}`;
  const verdictLine = `openarch ${kind}：${value.verdict}（exit ${value.exitCode}）`;
  const body = tailChars(value.report, 12_000);
  return body ? `${verdictLine}\n${value.command}\n${body}` : `${verdictLine}\n${value.command}`;
}

/** 等宽列填充（ASCII 表头/取值；对齐与 CLI renderAlignedTable 观感一致）。 */
const padEnd = (text, width) => {
  const s = String(text ?? "");
  return s.length >= width ? `${s} ` : s + " ".repeat(width - s.length);
};

/** 渲染 openarch_contract 的模型文本。 */
export function renderContractText(value) {
  if (!value || value.ok === false) return `openarch contract 失败：${value?.error ?? "unknown"}`;
  const verdictLine = `openarch contract：${value.verdict ?? "?"}（exit ${value.exitCode ?? "?"}）`;
  const catalog = value.catalog;
  if (!catalog) {
    const body = tailChars(value.report, 8_000);
    return `${verdictLine}\n${value.command}\n${value.error ?? ""}\n${body}`;
  }
  const lines = [
    verdictLine,
    `- openarch 版本: ${catalog.openarchVersion ?? "unknown"}`,
    "- 机器契约目录:",
  ];
  for (const c of catalog.contracts ?? []) {
    lines.push(`  ${c.id}: ${c.version}（${c.status}）`);
  }
  lines.push("- 契约纪律: 破坏性变更必须 bump version；非破坏字段可同版本追加；对未知版本 fail-closed。");
  return lines.join("\n");
}

/** 渲染 openarch_test 的模型文本（只读观察面；表格式与 CLI 报告同观感）。 */
export function renderTestText(value) {
  if (!value || value.ok === false) return `openarch test 失败：${value?.error ?? "unknown"}`;
  const verdictLine = `openarch test：${value.verdict ?? "?"}（exit ${value.exitCode ?? "?"}）`;
  if (value.list) {
    const lines = [verdictLine, "已注册测试治理 provider（config.yml test_governance.providers 使用 id）："];
    for (const p of value.providers ?? []) lines.push(`  ${p.id} — ${p.label}`);
    return lines.join("\n");
  }
  const t = value.testGovernance;
  if (!t) {
    const body = tailChars(value.report, 12_000);
    return `${verdictLine}\n${value.command}\n（test --json 契约解析失败，原始报告如下）\n${body}`;
  }
  const cov = t.coverage ?? {};
  const lines = [
    verdictLine,
    value.command ?? "openarch test --json",
    "",
    `- 覆盖状态: ${cov.status ?? "unknown"}`,
    `- 覆盖范围: 测试文件 ${cov.testFiles ?? "?"}, provider 处理 ${cov.providerHandledTestFiles ?? "?"}`,
  ];
  if (cov.reasons?.length > 0) lines.push(`- 覆盖限制: ${cov.reasons.join(", ")}`);
  if (t.suggestedAdapters) {
    lines.push(`- 适配器建议: providers=[${t.suggestedAdapters.providers?.join(", ") || "无"}] runners=[${t.suggestedAdapters.runners?.join(", ") || "无"}]（确认框架后显式写入 config.yml，勿自动启用）`);
  }
  if (Array.isArray(t.providers) && t.providers.length > 0) {
    lines.push("", "Provider 覆盖:", `  ${padEnd("provider", 10)}${padEnd("status", 9)}${padEnd("cand", 6)}${padEnd("handled", 8)}${padEnd("miss", 6)}${padEnd("fail", 6)}`);
    for (const p of t.providers) {
      lines.push(`  ${padEnd(p.providerId ?? "?", 10)}${padEnd(p.status ?? "?", 9)}${padEnd(p.candidates ?? "?", 6)}${padEnd(p.handled ?? "?", 8)}${padEnd(p.missingBaseline ?? "?", 6)}${padEnd(p.failed ?? "?", 6)}`);
    }
  }
  if (Array.isArray(t.summaries) && t.summaries.length > 0) {
    lines.push("", "Provider 摘要:");
    for (const s of t.summaries) {
      const p95 = s.p95;
      const p95Text = p95
        ? `loc=${p95.loc?.toFixed(1) ?? "?"} assertion=${p95.assertionCount?.toFixed(1) ?? "?"} mock=${p95.mockCount?.toFixed(1) ?? "?"}`
        : "UNAVAILABLE";
      lines.push(`  [${s.providerId}] files=${s.testFiles ?? "?"} cases=${s.testCases ?? "?"} P95 ${p95Text}`);
    }
  }
  if (t.bloat) {
    lines.push("", `- TEST_BLOAT: ${Number(t.bloat.score).toFixed(3)}${t.bloat.triggered ? "（已触发，观察并治理）" : "（正常范围）"}`);
  }
  const triggeredKinds = [...new Set((t.decision?.triggered ?? []).map((item) => `${item.level}:${item.kind}`))];
  lines.push("", `- 决策: finding=${t.decision?.findingCount ?? "?"}${triggeredKinds.length > 0 ? ` · 触发 ${triggeredKinds.join(", ")}` : ""}；只读观察，绝不自动启用 provider 或据此新增 BLOCK`);
  return lines.join("\n");
}
