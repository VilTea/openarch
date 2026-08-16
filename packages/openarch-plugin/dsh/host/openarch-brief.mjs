/**
 * OpenArch DSH 插件 — 治理简报渲染（Host 纯逻辑）。
 *
 * 从 openarch-state.mjs 拆出：把状态快照渲染成 3–8 行 systemPrompt 简报。
 * 拆分动机：简报里 zh/en 双语文案分支是 state 模块 maxFuncBranch 的最大
 * 来源（openarch check 的 crl_local WARN 诊断）；纯函数移出后 state 模块
 * 只保留采集/缓存职责。
 */
export function renderGovernanceBrief(state, locale) {
  const zh = locale !== "en";
  if (!state || !state.initialized) return "";
  const cliContext = state.cli?.ok ? state.cli.context : null;
  const lines = [];
  if (zh) {
    lines.push("OpenArch 治理事实（快照，供你判断；PASS 不代表无未处理信号）：");
  } else {
    lines.push("OpenArch governance facts (snapshot for your judgment; PASS does not mean no outstanding signals):");
  }
  const baselineFact = cliContext?.baseline ?? null;
  if (baselineFact) {
    const fresh = baselineFact.freshness === "fresh";
    const files = typeof baselineFact.files === "number" ? `${baselineFact.files} files` : "unknown";
    const scanAt = typeof baselineFact.scanAt === "string" ? baselineFact.scanAt.slice(0, 10) : "unknown";
    lines.push(zh
      ? `- baseline: ${files}, ${fresh ? "fresh" : "stale"} (scan ${scanAt})`
      : `- baseline: ${files}, ${fresh ? "fresh" : "stale"} (scan ${scanAt})`);
  } else {
    lines.push(zh ? "- baseline: unavailable（无可用基线证据）" : "- baseline: unavailable (no usable baseline evidence)");
  }
  const changes = cliContext?.changes ?? null;
  const worktree = changes?.worktree?.paths ?? null;
  const worktreeSrc = changes?.worktree?.sourcePaths ?? null;
  const staged = changes?.staged?.paths ?? null;
  const stagedSrc = changes?.staged?.sourcePaths ?? null;
  const changeParts = [];
  if (Array.isArray(worktree)) changeParts.push(zh ? `worktree ${worktree.length} (${Array.isArray(worktreeSrc) ? worktreeSrc.length : "?"} src)` : `worktree ${worktree.length} (${Array.isArray(worktreeSrc) ? worktreeSrc.length : "?"} src)`);
  if (Array.isArray(staged)) changeParts.push(zh ? `staged ${staged.length} (${Array.isArray(stagedSrc) ? stagedSrc.length : "?"} src)` : `staged ${staged.length} (${Array.isArray(stagedSrc) ? stagedSrc.length : "?"} src)`);
  lines.push(zh
    ? `- 变更: ${changeParts.length > 0 ? changeParts.join(", ") : "无可见变更"}`
    : `- changes: ${changeParts.length > 0 ? changeParts.join(", ") : "no visible changes"}`);
  const policy = cliContext?.architecturePolicy ?? null;
  lines.push(zh
    ? `- 已声明策略: ${policy?.declaredRules ?? "unknown"} rules (${policy?.state ?? "unknown"})`
    : `- declared policy: ${policy?.declaredRules ?? "unknown"} rules (${policy?.state ?? "unknown"})`);
  const readiness = Array.isArray(cliContext?.readiness) ? cliContext.readiness : [];
  const notReady = readiness.filter((r) => r && typeof r.state === "string" && r.state !== "ready").map((r) => r.id);
  if (notReady.length > 0) {
    lines.push(zh
      ? `- readiness 未就绪: ${notReady.join(", ")}（如 code-hook 未装时提交不经过门禁）`
      : `- readiness not ready: ${notReady.join(", ")} (e.g. without the code-hook, commits bypass the gate)`);
  }
  lines.push(zh
    ? "- 用 openarch_context 读取完整事实；改动后用 openarch_check 验证（0 PASS / 1 WARN / 2 BLOCK / 3 错误）。"
    : "- Use openarch_context for full facts; verify changes with openarch_check (0 PASS / 1 WARN / 2 BLOCK / 3 error).");
  return lines.join("\n");
}
