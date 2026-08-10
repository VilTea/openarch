import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/**
 * Presentation is a CLI concern. Domain facts and JSON contracts keep stable
 * identifiers and are never translated in place.
 */
export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "en";

const localeFromValue = (value: string | undefined): Locale | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return undefined;
};

const systemLocale = (): Locale =>
  localeFromValue(Intl.DateTimeFormat().resolvedOptions().locale) ?? DEFAULT_LOCALE;

export interface LocaleResolution {
  readonly locale: Locale;
  readonly args: readonly string[];
  readonly error?: string;
}

interface ParsedLocaleArguments {
  readonly args: readonly string[];
  readonly explicit?: string;
  readonly missingValue?: true;
}

const configuredLocale = (cwd: string): { readonly locale?: Locale; readonly error?: string } => {
  const configPath = join(cwd, ".openarch", "config.yml");
  if (!existsSync(configPath)) return {};
  try {
    const config = load(readFileSync(configPath, "utf8")) as { presentation?: { locale?: unknown } } | undefined;
    const value = config?.presentation?.locale;
    if (value === undefined) return {};
    if (typeof value !== "string" || !localeFromValue(value)) return { error: String(value ?? "") };
    return { locale: localeFromValue(value) };
  } catch {
    // Config parsing is governed elsewhere; locale selection falls through to
    // the host default so presentation never blocks investigation.
    return {};
  }
};

const parseLocaleArguments = (rawArgv: readonly string[]): ParsedLocaleArguments => {
  const args: string[] = [];
  let explicit: string | undefined;
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = rawArgv[index];
    if (arg === "--lang") {
      const value = rawArgv[index + 1];
      if (value === undefined || value.startsWith("--")) return { args, missingValue: true };
      explicit = value;
      index += 1;
    } else if (arg.startsWith("--lang=")) {
      explicit = arg.slice("--lang=".length);
    } else {
      args.push(arg);
    }
  }
  return { args, explicit };
};

const explicitLocaleResolution = (
  explicit: string | undefined,
  args: readonly string[],
  fallback: Locale,
): LocaleResolution | undefined => {
  if (explicit === undefined) return undefined;
  const locale = localeFromValue(explicit);
  return locale
    ? { locale, args }
    : { locale: fallback, args, error: message(fallback, "locale.invalid", { value: explicit }) };
};

const projectLocaleResolution = (cwd: string, args: readonly string[], fallback: Locale): LocaleResolution => {
  const project = configuredLocale(cwd);
  if (project.error !== undefined) return { locale: fallback, args, error: message(fallback, "locale.invalidProject", { value: project.error }) };
  return { locale: project.locale ?? fallback, args };
};

/**
 * `--lang` is global and may be written before or after a command. It is
 * removed before command parsing so subcommands do not each own the option.
 */
export const resolveLocale = (
  rawArgv: readonly string[],
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): LocaleResolution => {
  const environmentLocale = localeFromValue(environment.OPENARCH_LANG)
    ?? localeFromValue(environment.OPENARCH_LOCALE);
  const fallback = environmentLocale ?? systemLocale();
  const parsed = parseLocaleArguments(rawArgv);
  if (parsed.missingValue) return { locale: fallback, args: parsed.args, error: message(fallback, "locale.missing") };
  const explicit = explicitLocaleResolution(parsed.explicit, parsed.args, fallback);
  if (explicit) return explicit;
  if (environmentLocale) return { locale: environmentLocale, args: parsed.args };
  return projectLocaleResolution(cwd, parsed.args, fallback);
};

type MessageParams = Record<string, string | number>;

const interpolate = (template: string, params: MessageParams = {}): string =>
  template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));

const catalog = {
  zh: {
    "locale.missing": "--lang 需要指定 zh 或 en。",
    "locale.invalid": "无效的 --lang 值: {value}。仅支持 zh 或 en。",
    "locale.invalidProject": "无效的 presentation.locale 值: {value}。仅支持 zh 或 en。",
    "command.unknown": "未知命令: {command}。运行 openarch --help 查看用法。",
    "analysis.failed": "分析失败 [{tag}]{path}{cause}",
    "analysis.historyRecovery": "恢复指引：先备份 .openarch/history/ 并保留原始错误；按治理生命周期从 Git 或外部备份恢复完整历史记录集合。不要删除或跳过损坏记录来伪造 clean；无法恢复时历史 CRL 保持 UNAVAILABLE，结构基线可另行用 openarch scan 重建。",
    "init.invalidMode": "--mode 只能是 personal 或 team",
    "init.agentRequired": "--agent 需要指定 coding agent",
    "init.invalidAgent": "--agent 只能是 {agents}",
    "init.skillDirRequired": "--skill-dir 需要指定项目内的 skills 目录",
    "init.agentSkillDirConflict": "--agent 与 --skill-dir 不能同时使用",
    "init.scriptConflict": "--install-script 与 --replace-script 不能同时使用",
    "init.invalidToolchainScope": "--toolchains 只能是 user 或 project",
    "init.coordinationUrlRequired": "--coordination-url 需要指定 http(s) 服务地址",
    "init.coordinationConflict": "--coordination-url 与 --clear-coordination 不能同时使用",
    "toolchains.heading": "## 外部语义工具链",
    "toolchains.usage": "用法: openarch toolchains [--json]",
    "toolchains.userConfig": "- 用户配置: {path}",
    "toolchains.userConfigUnavailable": "不可用（请设置 HOME、APPDATA 或 OPENARCH_TOOLCHAINS_FILE）",
    "toolchains.projectConfig": "- 项目本机配置: {path}",
    "toolchains.languagesMissing": "- 未配置可分析语言；先在 .openarch/config.yml 声明 languages。",
    "toolchains.language": "- {language}: {availability}",
    "toolchains.tool": "  - {id}: {availability} [{location}]{detail}",
    "context.heading": "## OpenArch 项目上下文",
    "context.configuration": "- 配置: {state}",
    "context.baselineAvailable": "- 基线: 可用（{files} 文件；scope={scope}；snapshot={freshness}{scanAt}）",
    "context.baselineMissing": "- 基线: 缺失",
    "context.baselineScope.compatible": "兼容", "context.baselineScope.different": "不匹配", "context.baselineScope.partial": "局部", "context.baselineScope.unknown": "未知",
    "context.baselineFreshness.current": "当前", "context.baselineFreshness.stale": "过期", "context.baselineFreshness.unknown": "未知",
    "context.baselineScanAt": "；scan={at}",
    "context.baselineGeneration": "- 基线代：active={active}，readable={readable}，临时代={transient}（仅报告）",
    "context.available": "可用",
    "context.missing": "缺失",
    "context.architecturePolicy": "- 架构策略: {state}{detail}",
    "context.declaredRules": "（{count} 条已声明规则）",
    "context.worktree": "- 工作树: {paths} 路径，{sources} 源码{pending}",
    "context.staged": "- 暂存区: {paths} 路径，{sources} 源码",
    "context.gitUnavailable": "- Git 变更集: UNAVAILABLE（当前目录不是可读取的 Git 工作树；本地配置与 baseline 事实仍可查看）",
    "context.pending": "，待封存语义证据={state}",
    "evidence.current": "当前",
    "evidence.missing": "缺失",
    "evidence.stale": "过期",
    "context.readiness": "### 治理可用性",
    "context.footer": "*以上是只读事实，不代表唯一下一步；请结合当前任务、强制约束与用户授权决定行动。*",
    "context.usage": "用法: openarch context [--json] [--remote]",
    "architecturePolicy.configMissing": "缺少 .openarch/config.yml",
    "architecturePolicy.configRootInvalid": "config.yml 根节点不是 mapping",
    "architecturePolicy.configReadFailed": "无法读取 config.yml{detail}",
    "governance.heading": "## 治理复盘（仅报告）",
    "governance.metricPolicy": "### 指标策略",
    "governance.architectureGate": "- 架构门禁: {verdict}（项目规则={rules}，评估生产文件={files}）",
    "governance.architectureTriggered": "  [{level}] {name}: {condition} → {file} → 建议: 修复该文件，或按项目证据调整/试行策略。",
    "governance.signalSummary": "  ⚠ 治理信号 {count} 个（{ids}）——见下；PARTIAL/UNAVAILABLE 是事实边界，不是 clean。",
    "governance.unconfiguredGate": "- [ATTENTION] 当前门禁未声明生产规则；PASS 只表示没有已配置策略被触发。",
    "governance.policyCalibrationHeading": "### 探索性策略校准（仅建议）",
    "governance.policyCalibrationBaseline": "- 观察基准（不是默认阈值）：max_func_branch P95={branch}，nesting_depth P95={nesting}，loc P95={loc}，external_passthrough P95={external}",
    "governance.policyCalibrationUnavailable": "- 尚无完整 P95 观察基准；先完成完整 scan/review，再设定阈值，不要猜测。",
    "governance.policyCalibrationWait": "- 当前不具备阈值校准前提；先补齐完整 scan/review 事实，暂不写入规则。",
    "governance.policyCalibrationAction": "- 请由项目所有者选择：1) 依据 P95 与 Top-3 试行一条最小 WARN；2) 试行两条独立 WARN；3) 暂缓并记录理由。阈值要写明容忍度、样本范围和回扫计划，首轮不自动 BLOCK。",
    "governance.structuralBoundary": "- 结构候选仅解释指标策略，不自动形成 finding 或 signal。",
    "governance.noStructuralData": "- 无可用局部负担或历史趋势数据。",
    "governance.definitionHeading": "- 定义面信号（声明密集 + 规模大，report-only）：超本语言 decl P95 且超 loc P95 的契约候选。",
    "governance.definitionEntry": "  → {path}: decl={decl} / loc={loc}",
    "governance.structuralEntry": "- {path}: 局部={local} 暴露={exposure} 不连通形态={shape} 历史={crl}",
    "governance.findingPolicy": "### Finding 策略",
    "governance.antiPatterns": "#### 反模式（默认仅报告）",
    "governance.antiPatternsUnavailable": "- [UNAVAILABLE] 反模式: {reason}",
    "governance.rulesRun": "- 已执行规则: {count}",
    "governance.findings": "- Finding: {count}{details}",
    "governance.findingDetail": "  [{ruleId}] {location}: {message}",
    "governance.testPolicy": "#### 测试 finding 策略",
    "governance.testsUnavailable": "- [UNAVAILABLE] 测试治理: {reason}",
    "governance.testCoverage": "- 覆盖状态: {status}（测试文件={files}，provider 处理={handled}）",
    "governance.testVerdict": "- 策略裁决: {verdict}（仅基于已收集 finding）",
    "governance.coverageLimits": "- 覆盖限制: {reasons}",
    "governance.signals": "### 信号",
    "governance.noSignals": "- 无诊断信号。",
    "governance.next": "### 下一步",
    "governance.actionConfigurePolicy": "不要停在 UNCONFIGURED/PASS：先用 review 的 P95 与 Top-3 发起一次阈值校准选择，再以项目证据配置最小 rules_warn/rules_block；不要复制其他项目阈值。",
    "governance.actionAntiPatterns": "逐类复核反模式 finding，保存真实正例；修复或记录合理边界后，才讨论项目级质量裁决。",
    "governance.actionTestCoverage": "确认实际测试 runner；仅启用已支持 provider，未知框架应保持 UNAVAILABLE，不能由 PASS 伪装为覆盖完整。",
    "governance.actionNone": "当前没有需要由该概览升级的信号；继续按项目策略运行 openarch check。",
    "gate.heading": "## check 策略裁决",
    "gate.verdict": "- Verdict: {verdict}",
    "gate.verdictWarnSuffix": "（{count} 项 WARN，见上）",
    "gate.evaluated": "- 评估文件数: {files}",
    "gate.trigger": "  [{level}] {name}: {condition}{observed}",
    "gate.triggerFile": "    → {path}",
    "gate.recommendation": "    → 建议: {recommendation}",
    "gate.recommendation.split_function": "拆分该函数的职责，或改用策略/查找表。",
    "gate.recommendation.inspect_branch_shape": "先判断控制流位于单函数、顶层分派还是多个独立函数。",
    "gate.recommendation.extract_dispatch": "将顶层分派改为命令注册表、查找表或独立命令处理器。",
    "gate.recommendation.reduce_local_burden": "优先降低局部控制复杂度或外部透传；暴露度和模块形态见诊断。",
    "gate.recommendation.review_high_impact": "对高 CRL 文件运行 openarch review。",
    "gate.breakdownSummary": "    存量诊断: 局部={local} 暴露={exposure} 不连通形态(1-connectedness)={shape} 复合={composite}",
    "gate.breakdownP95": "    P95: br={branch} ne={nesting} loc={loc} α={alpha} 1conn={connectedness} extPa={external}",
    "gate.breakdownBranch": "    {bar} 分支(maxFunc): {value}",
    "gate.breakdownNesting": "    {bar} 嵌套深度: {value}",
    "gate.breakdownLoc": "    {bar} 行数(-注释): {value}",
    "gate.breakdownExternal": "    {bar} 外部透传: {value}（直接非本地={external} / P95={p95}{capped}）",
    "gate.capped": "，已截断",
    "gate.breakdownReview": "    review-only 枢纽位(α): {alpha}；不连通: {disconnected}",
    "gate.unavailable.languages_empty": "- 原因: config.yml 未声明可分析的 languages，无法界定 baseline 的裁决范围。",
    "gate.unavailable.missing_baseline_index": "- 原因: 缺少可读取的 baseline index。",
    "gate.unavailable.baseline_scope_incompatible": "- 原因: baseline 的分析范围与当前配置不一致或不是完整 scan。",
    "gate.unavailable.metric_contract_incompatible": "- 原因: baseline 未使用当前 metric contract。",
    "gate.unavailable.unsupported_gate_metric": "- 原因: 项目规则使用了非 gate metric。",
    "gate.unavailable.missing_max_function_branch": "- 原因: baseline 缺少 maxFuncBranch；不能将旧文件聚合替代函数复杂度。",
    "gate.unavailable.missing_metric_language": "- 原因: baseline 缺少 parser 确认的文件语言；运行完整 scan 重建多语言事实。",
    "gate.unavailable.unconfigured_language_policy": "- 原因: 生产语言没有显式 structural_policies 总体，不能继承其他语言的阈值。",
    "gate.unavailable.ambiguous_structural_policy": "- 原因: 一个生产文件命中多个 structural_policies 总体；收紧 scope 使其唯一归属。",
    "gate.unavailable.policy_calibration_missing": "- 原因: 强制策略总体缺少已封存的 P95 校准。",
    "gate.unavailable.execution_failed": "- 原因: gate 执行失败。",
    "gate.diagnostic": "- Diagnostic: {category}/{operation}{path}: {detail}",
    "gate.unavailableAction": "- 行动: 修正配置或运行 openarch scan 后重试。",
    "gate.calibrationHeading": "### 校准漂移（仅报告）",
    "gate.calibrationShift": "- CALIBRATION_SHIFT {path}: sealed {sealed} -> observed {observed}；规则 {previousRules} -> {observedRules}",
    "gate.policiesHeading": "### 结构策略总体",
    "gate.policy": "- {id}: {mode}；语言={languages}；文件={files}",
    "gate.policy.observe": "观察（不裁决）",
    "gate.policy.enforce": "强制",
    "gate.none": "无",
    "gate.unconfigured": "- Policy coverage: UNCONFIGURED（当前项目未声明 rules_warn 或 rules_block）",
    "gate.unconfiguredAction": "- 行动: 运行 openarch review 查看结构、反模式和测试治理信号；调查后再按项目证据配置策略。",
    "gate.topHeading": "### 存量 Top-3（局部负担最高文件）",
    "gate.topColFile": "文件",
    "gate.topColLocal": "局部负担",
    "gate.topColExposure": "暴露",
    "gate.topColShape": "不连通形态(1-conn)",
    "gate.topColComposite": "复合诊断",
    "gate.topLevelHeading": "### 顶层控制流（仅报告）",
    "gate.topLevelColFile": "文件",
    "gate.topLevelColWeighted": "顶层加权分支",
    "gate.topLevelColMaxFunc": "单函数最大",
    "gate.topLevelColTotal": "文件总加权分支",
    "gate.footer": "*由 `openarch check --report` 生成 · 阈值见 `.openarch/config.yml`*",
    "check.worktreeStagedConflict": "--worktree 与 --staged 不能同时使用",
    "check.scopeHeading": "## 变更度量范围",
    "check.scopeNoChange": "- 未选择变更集：本次不计算 D_MR 或 I_push；后续的存量 Top-3 来自现有 baseline，不代表本次改动。",
    "check.scopeCurrent": "- 查看当前结构：openarch review，或 openarch scan --report（刷新快照后立即复盘）。",
    "check.scopeChange": "- 查看本次改动：在 scan 前运行 openarch check --staged --report。",
    "check.worktreeEmpty": "工作树没有可供 Git diff 取证的已跟踪新增或修改文件。",
    "audit.heading": "## 配置审计",
    "audit.status": "- Status: {status}",
    "audit.event": "- Event: {path}",
    "audit.drift": "- 配置已变更但尚未记录；运行 openarch check --record-config 写入审计事件。",
    "diff.heading": "## 架构增量评估报告\n- 冲击量 I_push: +{impact}\n- I_push 范围: 当前为文件级结构传播上界，不等同于声明级已验证消费者数\n- 变更诊断 D_MR: {diagnosis}\n- 文件 deltas: {files} 文件",
    "semantic.automatic": "自动语义分析{suffix}: {files} 文件，{units} 个声明级变更单元。",
    "semantic.explicitFallback": "显式语义兜底: {path}={kind}",
    "diff.metric.branch": "最大函数分支", "diff.metric.nesting": "嵌套", "diff.metric.loc": "LOC", "diff.metric.externalPassthrough": "外部编排",
    "diff.scope.existing": "既有文件", "diff.scope.introduced": "新增文件", "diff.scope.existing_unavailable": "既有文件（before 结构不可用）",
    "diff.metricDelta": "{metric} {delta}{normalized}", "diff.normalizedDelta": "（加权归一化 {delta}）", "diff.noLocalChange": "无局部负担变化",
    "diff.mrPrefix": "  D_MR {file}（{scope}{source}）: ", "diff.sealedBaseline": "（使用已封存 baseline）",
    "diff.introducedBefore": "无可比 before 结构，仅记录 after 原始事实；不计入 D_MR。", "diff.unavailableBefore": "before 结构不可用，未以零值替代；不计入 D_MR。",
    "diff.mrComparable": "{changes}；局部恶化 +{deterioration}，改善 -{improvement}；暴露 Δα={exposure}", "diff.exposureUnavailable": "不可用（未重建 before 图）",
    "diff.summaryDeterioration": "+{value} 局部负担（不参与 gate）", "diff.summaryBeforeUnavailable": "缺少可比 before 结构（不参与 gate）", "diff.summaryClean": "无局部负担恶化（0.00，不参与 gate）",
    "diff.actionConsumers": "检查直接消费者: {consumers}", "diff.actionPublicContract": "确认公开合同没有仓库内直接消费者，并运行语言级契约检查", "diff.actionDependencyBoundary": "确认依赖增删符合层级与 authority 边界", "diff.actionQuality": "运行受影响模块的语言检查与已有测试",
    "diff.plan": "  验证计划 {file}: {contracts}", "diff.publicContracts": "公共合同 {contracts}", "diff.noPublicContracts": "无公开合同变更", "diff.planAction": "    → {action}",
    "diff.staticPath": "- 符号引用路径: STATIC parser fallback（当前 I_push 使用静态依赖图；未请求 LSP 语义事实）", "diff.semanticNoReports": "- 符号引用路径: STATIC parser fallback（已请求 LSP，但未取得 provider 报告）", "diff.semanticFallback": "- 符号引用路径 {language}: STATIC parser fallback（{provider} 不可用：{reason}）", "diff.semanticPath": "- 符号引用路径 {language}: {source} {provider} {availability}（声明={declarations}，引用={references}；{scope}）{risk}", "diff.semanticScope": "范围={mode}，声明文件={selected}/{governed}，族={families}", "diff.semanticScopeLegacy": "范围=未声明（旧 provider 合同）", "diff.semanticRisk": "；风险: {reason}", "diff.semanticReasonUnavailable": "未提供原因",
    "diff.symbolEvidence": "    LSP 符号证据 {symbol}: {source}/{provider}（声明={declarations}，引用={references}）→ {consumers}；{comparison}{risk}", "diff.symbolNoConsumers": "未观察到仓库引用", "diff.symbolComparison": "静态 import={static}，交集={shared}，静态独有={staticOnly}，符号独有={symbolOnly}", "diff.symbolRisk": "；风险: {reason}",
    "diff.changeSurface": "  变更面冲击: C_push = Σ λ·log2(n+1)·ω = {total}（{provenance}）", "diff.changeSurfaceUnavailable": "  变更面分析不可用: {language}（{reason}）——不输出 C_push 数值（无兜底）", "diff.changeSurfaceFile": "    {file}（{language}）: {provenance} 总={total}（文件级上界 {bound}，符号级确认 {confirmed}）", "diff.changeSurfaceContribution": "      {anchor} ({kind}): λ={lambda} × log2({consumerCount}+1)={reach} × ω={weight} → {value}；消费者: {consumers}", "diff.changeSurfaceNoConsumers": "无仓库消费者", "diff.changeSurfaceUnconfirmed": "符号级未确认（静态上界 {bound} 个潜在消费者未获符号级确认）", "diff.changeSurfaceConfirmedBeyondBound": "符号级确认 {count} 个消费者（{list}）——超出静态上界 {bound}（上界可能含导入未用假阳性，或确认消费者为测试/范围外文件）", "diff.changeSurfaceSignalFileHeavy": "    信号[file-heavy] {file}: 文件冲击 I_push={iPush} 大于变更面 C_push={cPush}——热点文件改内部实现（文件级假阳性）", "diff.changeSurfaceSignalSymbolHeavy": "    信号[symbol-heavy] {file}: 变更面 C_push={cPush} 大于文件冲击 I_push={iPush}——API 面变化（文件级低估真实冲击）",
    "diff.symbolAdmissionHeading": "### 符号范围公式准入（仅报告）", "diff.symbolAdmission": "  {file}::{symbol} [{language}/{provider}] {availability}，未满足: {missing}", "diff.symbolAdmissionRequirement.before_declaration_identity": "Git before 声明身份", "diff.symbolAdmissionRequirement.after_declaration_identity": "before/after 稳定声明身份", "diff.symbolAdmissionRequirement.repository_references": "完整仓库引用范围", "diff.symbolAdmissionRequirement.public_surface": "公开面分类", "diff.symbolAdmissionRequirement.common_population": "共同版本化文件范围", "diff.symbolAdmissionRequirement.calibration_samples": "持久化正反校准样本",
    "diff.evidence": "- {state}: {id}", "diff.pendingEvidence": "pending evidence", "diff.history": "history", "history.compacted": "已压缩 {compacted} 条 sealed history，保留 {retained} 条近期证据。", "history.invalidPolicy": "history 保留策略无效：{detail}",
    "diff.delta": "  {file}: ΔI={impact}  α={alpha}",
    "docs.heading": "## 文档相似候选", "docs.scope": "- scope: {scope}", "docs.root": "- document root: {root}", "docs.unavailable": "- Status: UNAVAILABLE ({reason})", "docs.indexed": "- indexed: {indexed}, updated: {updated}", "docs.noCandidates": "- Candidates: 0", "docs.candidates": "- Candidates: {count}（仅报告）", "docs.candidate": "  [ADVISORY] {left} ~ {right} (minhash={minhash}, simhashDistance={distance})", "docs.usage": "用法: openarch docs <check|record|status> [...options]", "docs.storeMissing": "文档库未配置。运行 openarch init --docs-store project，或配置 shared document scope",
    "record.invalidCategory": "--category 必须是 anti_patterns、patterns 或 decisions。运行 openarch docs record --help 查看用法。", "record.created": "✓ 经验条目已生成: {path} ({category})", "record.check": "  填写完成后运行: openarch docs check --changed {path}", "record.commit": "  闭环: 在文档库 Git 根提交；手工编辑由 docs hook 检查。",
    "status.heading": "## OpenArch 状态", "status.present": "已建立", "status.missing": "未建立", "status.baseline": "- baseline: {state}", "status.files": "  nFiles: {files}", "status.associated": "已关联 ({type})", "status.unassociated": "未关联", "status.docsRepo": "- docs-repo: {state}", "status.behind": "  ⚠ 落后 remote {commits} commits", "status.store": "- document-store: {state}", "status.unconfigured": "未配置", "status.scopeUnavailable": "  ⚠ shared document scope 未登记，相似度检查不可用", "status.readiness": "## 治理链路就绪度（仅报告）", "status.scan": "- scan: {status} {phase} {completed}/{total}{files}", "status.scanStale": "过期运行标记（可能已中断）", "status.reason": "  ⚠ {reason}",
    "rules.factsHeading": "## 脚本事实能力", "rules.fact": "- {id}: {summary} 不可用时：{unavailable}", "rules.astHeading": "## 引擎 AST 事实阶段", "rules.astFact": "- {id}: {summary}", "rules.skeletons": "- Skeletons: {starters}", "rules.templatesHeading": "## 可选反模式模板（未安装，默认仅报告）", "rules.noTemplates": "- 当前项目 languages 没有可推荐的 shipped 反模式模板。", "rules.template": "- {family}: {id}（openarch init --install-script {id}）", "rules.unknownSkeleton": "未知 skeleton: {skeleton}。可用项: {starters}", "rules.usage": "用法: openarch rules <check|facts|skeleton <staged-ast|classification|metrics|authority-import|authority-change-set>>", "rules.commandUsage": "用法: openarch rules <check|facts|skeleton|scan|discover> [...options]", "rules.contractHeading": "## 扩展合同检查", "rules.scripts": "- Scripts: {count}", "rules.engines": "- anti-patterns={antiPatterns}, implicit-deps={implicitDeps}, test-governance={testGovernance}",
    "scriptFact.fileClassification.summary": "fileKind、pathClass 与仓库相对路径。", "scriptFact.fileClassification.unavailable": "检查 languages/file_kinds/paths 配置。", "scriptFact.structureMetrics.summary": "compatible baseline 的原始结构指标与依赖图事实。", "scriptFact.structureMetrics.unavailable": "运行 openarch scan，使 baseline scope 与 metric contract 对齐。", "scriptFact.authorities.summary": "项目可复用或脚本局部声明的边界，以及 runtime 派生的 protectedFiles/authorityIds。", "scriptFact.authorities.unavailable": "在项目 authority_hygiene 或当前脚本中声明 owner、保护范围与合法入口。", "scriptFact.testCaseSpans.summary": "当前 provider 确认的测试体范围、名称与状态。", "scriptFact.testCaseSpans.unavailable": "配置可处理当前测试文件的 provider，并修复未识别或采集失败范围。", "scriptFact.invocationBindings.summary": "语言 provider 已确认的调用接收者、方法与局部绑定目标。", "scriptFact.invocationBindings.unavailable": "仅对当前语言已实现的保守绑定范围编写脚本；动态或跨函数流转保持 unavailable。", "scriptFact.semanticRelations.summary": "provider 直接证明的类/接口关系；仅声明 requires 后按需收集。", "scriptFact.semanticRelations.unavailable": "在脚本 requires 声明 semantic-relations.v1，并配置已校准的语言语义 provider。", "scriptFact.changeSurface.summary": "变更驱动的符号面：哪些声明被改、被哪些文件消费；仅在变更集上下文（check --semantic）可用。", "scriptFact.changeSurface.unavailable": "在脚本 requires 声明 change-surface.v1，并在 check --semantic 变更集上下文中运行。", "scriptFact.staticImports.summary": "ParserStrategy 提供已注册语言的静态 import source records；动态、未解析或 parser 失败保持 unavailable。",
    "antiPatterns.heading": "## 反模式校准报告", "antiPatterns.changeSet": "- Change set: {state}（{files} 个源码文件）", "antiPatterns.rules": "- Rules: {count}", "antiPatterns.findings": "- Findings: {count}", "antiPatterns.finding": "  [{scope}:{rule}] {location}: {detail}{metadata}{evidence}{suggestion}", "antiPatterns.suggestion": "；建议: {suggestion}", "antiPatterns.pruning": "  [PRUNING] {rule}: {input} -> {targets} targets -> {candidates} candidates -> {records} records", "antiPatterns.authorityHeading": "## Authority Hygiene 提交质量裁决", "antiPatterns.verdict": "- Verdict: {verdict}",
    "evolution.none": "未保留", "evolution.history": "{status}，已确认 {confirmed}/{inspected} 个事件", "evolution.enumerationIncomplete": "枚举未完成", "evolution.surfaceUnavailable": "- 稳定多写面: UNAVAILABLE；{reason}。", "evolution.surfaceAbsent": "- 稳定多写面: 尚未形成可复核的重复既有表面。", "evolution.structureConfirmed": "结构佐证: implementation import {imports}，弱连通分量 {components}。", "evolution.structureLimited": "结构佐证有限：当前投影没有内部 implementation import 关系。", "evolution.surface": "- 稳定多写面: {files}；{commits} 次接入、{members} 个新增成员。", "evolution.members": "  成员: {members}；{corroboration}", "evolution.variants": "  另有 {count} 个投影变体保留在事实集中。", "evolution.evidenceCommits": "  证据提交: {commits}。", "evolution.integration": "- 接入: {commits} 次独立提交，新增 {members} 个直接成员。", "evolution.membersOnly": "  成员: {members}。", "evolution.coordinationHistory": "- 历史: {history}；当前直接 implementation import {imports} 个。", "evolution.coordinatorCommits": "  协调提交: {commits}。", "evolution.actionableInvestigation": "- 调查: 先确认该稳定既有表面是否是合理的单一注册；成立不变量后再用合同测试或项目脚本建立防线。", "evolution.insufficientInvestigation": "- 调查: 先确认新增成员是否持续要求修改同一入口；当前证据不足以推断 registry 或重构必要性。", "evolution.deferredHeading": "### 待取证", "evolution.deferred": "- {count} 个协调面没有可用历史样本，不参与调查队列，也不代表 clean。", "evolution.deferredItem": "- {coordinator}: 接入 {commits} 次，成员 {members} 个。", "evolution.gitUnavailable": "Git 动作 unavailable", "evolution.cochangeHeading": "### 闭合共变背景", "evolution.cochangeUnavailable": "- UNAVAILABLE；{reason}。", "evolution.cochangeSummary": "- {count} 个闭合集保留为追溯事实，不与协调 dossier 竞争调查顺序。", "evolution.cochangeItem": "- {files} 文件 / {occurrences} 次：{members}；{action}；内部 import {imports}。", "evolution.heading": "## 演化候选报告（仅报告）", "evolution.statusUnavailable": "- 状态: UNAVAILABLE", "evolution.reason": "- 原因: {reason}", "evolution.noGitEvidence": "- 无法从当前仓库的真实 Git 提交建立共同变化证据。", "evolution.eligible": "- 可分析 Git 提交: {count}", "evolution.bootstrapExcluded": "- 已排除 {count} 个仅新增当前生产文件的 bootstrap 提交。", "evolution.historyExcluded": "- 当前 baseline 缺少 {count} 个历史路径的事实；它们已排除。", "evolution.relationUnavailable": "- 模块关系分类: UNAVAILABLE；{reason}", "evolution.dossierSummary": "- 协调 dossier: 已取证 {sampled}，待取证 {deferred}；稳定多写面 {linked}/{surfaces}（投影 {projections} 条）。", "evolution.disclaimer": "- 说明: 每个 dossier 合并同一 coordinator 的接入事实与重复既有表面；它是调查线索，不是 finding 或重构结论。", "evolution.budget": "- 取证预算: 候选={candidates}，事件={events}/{budget}，已确认={confirmed}，不可用={unavailable}。", "evolution.noDossiers": "- 当前没有足够证据形成协调 dossier；这不代表不存在腐化。", "evolution.queueHeading": "### 调查队列",
    "readiness.capabilityAssetMissing": "核心能力资产缺失: {path}",
    "readiness.capabilityAsset": "核心能力资产: {path}",
    "readiness.capabilityMaintenanceChecked": "最近维护检查: {at}",
    "readiness.capabilityMaintenanceUnobserved": "编码前读取该资产并明确复用或不适用；能力、CLI、schema、provider 或脚本合同变更后更新它，再运行 docs check --changed {path}",
    "readiness.documentHookMissing": "文档仓 pre-commit hook 未安装",
    "readiness.documentHookInstalled": "文档仓 advisory hook 已安装",
    "readiness.documentHookStale": "文档仓 hook 需要由当前 OpenArch 刷新 launcher 合同",
    "readiness.codeHookMissing": "代码仓 pre-commit hook 未安装",
    "readiness.codeHookExternal": "代码仓 pre-commit 由外部 hook 占用，OpenArch 未修改它",
    "readiness.codeHookStale": "代码仓 hook 需要由当前 OpenArch 刷新 launcher 合同",
    "readiness.codeHookInstalled": "代码仓 enforcing hook 已安装",
    "readiness.hookRuntimeAvailable": "hook 可解析执行器: {executable}",
    "readiness.hookRuntimeMissing": "hook 执行器不可用: {executable}；安装发布版 openarch 或设置 OPENARCH_BIN",
    "readiness.documentStoreMissing": "DocumentStore 未配置",
    "readiness.documentStoreProject": "project-local 文档库: {root}",
    "readiness.documentStoreShared": "shared 文档库已关联: {root}",
    "readiness.documentStoreSharedUnavailable": "shared 文档库关联或链接不可用",
    "readiness.documentScopeMissing": "shared document scope 未登记",
    "readiness.documentScopeRegistered": "scope 已在文档库登记: {scope}",
    "readiness.documentScopeUnregistered": "项目 scope 绑定未在文档库 registry 中登记",
    "readiness.documentSimilarityChecked": "最近成功检查: {at}",
    "readiness.documentSimilarityUnobserved": "尚未运行文档相似检查",
    "readiness.coordinationNotConfigured": "未配置协调服务；本地治理和 Git 文档协作仍可用，远程 Task/会议/租约操作保持 UNAVAILABLE。由用户显式提供地址：openarch init --coordination-url <https://...>",
    "readiness.coordinationConfigured": "协调服务已显式配置: {url}（尚未连通性验证；Git 文档库仍是持久事实源）",
    "readiness.coordinationInvalid": "协调服务配置无效: {path}（{reason}）；修正或运行 openarch init --clear-coordination",
    "help.commands": "命令：",
    "command.init": "初始化治理边界和文档库",
    "command.context": "显示只读项目治理事实，供 Agent 结合任务判断",
    "command.scan": "建立或更新结构基线；--report 显示当前结构复盘",
    "command.review": "调查结构、规则与测试信号",
    "command.check": "验证变更影响、策略与配置审计",
    "command.rules": "管理项目规则：check|facts|skeleton|scan|discover",
    "command.docs": "管理治理文档：check|record|status",
    "command.toolchains": "显示外部语义工具及用户/项目本机配置位置",
    "command.update": "检查远端 release 是否有新版本（只读，不自动更新）",
    "command.calibration": "导出高级校准证据",
    "command.coordination": "协作协调服务命令族（status/bootstrap/refresh/scope/evidence/task）",
    "command.lsp": "LSP 进程守护命令族（start/stop/status——jdtls 转发 daemon）",
    "command.antiPatterns": "反模式规则校准（默认仅报告——含文件/行明细）",
    "update.usage": "用法: openarch update [--json]",
    "update.available": "发现新版本: 当前 {current} → 最新 {latest}",
    "update.action": "更新步骤: 1) 从 GitHub release 下载新二进制替换 %LOCALAPPDATA%\\OpenArch\\bin 下的 openarch；2) 重新运行 openarch init --agent <your-agent> 刷新项目 Skill 树。",
    "update.upToDate": "已是最新版本: {version}",
    "update.failed": "更新检查失败: {detail}（网络不可达或远端不可用，本地治理不受影响）",
    "help.init": `openarch init [options]

初始化治理边界、项目文档库和可选的提交 hook。

选项：
  --docs-store project          使用当前仓库的 docs/openarch 文档库
  --docs-repo <path-or-url>     关联共享文档仓库
  --docs-scope <scope-id>       关联共享文档仓库时指定作用域
  --coordination-url <url>      配置可选的本机协调服务基址
  --clear-coordination          清除本机协调服务选择
  --install-hook                安装或更新 OpenArch pre-commit hook
  --agent <name>                更新当前项目的 claude|codex|cursor|opencode|reasonix Skill
  --skill-dir <relative-path>  更新当前项目自定义 agent 的 skills 父目录
  --mode <personal|team>        写入治理持久化模式；personal 不自动暂存 .openarch 运行产物
  --toolchains <user|project>   创建空的外部语义工具链配置（不覆盖既有文件）
  --install-script <id,...>     按 id 安装默认项目脚本
  --replace-script <id,...>     替换指定的未定制默认项目脚本
  --unlink                      解除已有文档仓关联

--docs-repo 是 Git 文档存储，不是协调服务地址。本地 scan/check/review 不依赖二者；不得从 Git remote 或项目形状推导协调服务，必须在初始化或之后由用户显式提供。`,
    "help.scan": `openarch scan [--report] [glob...]

建立或更新结构基线。默认扫描当前项目已配置语言的完整源码范围。

选项：
  --report             更新后立即显示当前结构的仅报告复盘
  --seal-calibration   仅完整 scan 可用；将当前观察分布封存为门禁 P95

先用 openarch check --staged --report 观察本次改动的 D_MR；scan --report 展示的是更新后的当前结构，不是改动差值。`,
    "help.context": `openarch context [--json]

显示当前项目的只读治理事实：配置、baseline、Git 工作树/暂存区源码变更、pending evidence 新鲜度，以及文档和 hook 可用性。

它不输出唯一下一步、不刷新 baseline、不改变项目策略。Agent 应结合用户任务、明确策略和强制约束决定行动；--json 供 Agent 稳定读取事实。`,
    "help.review": `openarch review [--evolution] [--report]

调查存量架构、结构负担与治理信号（报告口径；gate 是独立策略裁决）。

输出包含：
  架构门禁 verdict 与触发明细（规则 + 条件 + 触发文件）
  Top-3 局部负担文件与 P95 归一化基准
  反模式 / 测试治理 finding（默认仅报告，不自动裁决）

选项：
  --evolution  用 git 历史做演化对比（结构负担随版本的变化）
  --report     详细报告口径

心流提示：WARN 触发明细直接在此查看（无需绕道）；提交门禁仍用 openarch check --staged --report。`,
    "help.check": `openarch check [--worktree|--staged] [--semantic] [--wait-index] [--report] [--tests] [--full] [--verbose] [paths...]

统一变更验证：评估变更影响（I_push / D_MR）、策略门禁与配置审计。

模式：
  --worktree    分析工作树未暂存改动（默认）
  --staged      分析 Git index（提交门禁）
  --full        跳过 diff 前置，直接全量分析（门禁 + 审计 + 测试治理）
  <paths...>    显式指定待分析路径

选项：
  --semantic      请求编译器/LSP 符号级证据（仅工作树；输出 C_push 变更面与消费者）
  --wait-index    配合 --semantic：等待 LSP 完整索引（慢但准，验收场景）
  --report        报告口径（含策略明细与 WARN 列表）
  --tests         追加测试治理评估（可与 --full 组合：check --full --tests）
  --verbose       取证详情（D_MR / 符号证据 / 公式准入）
  --record-config 将本次校准记录写入项目配置
  --change-override <path=kind>  自动语义分类歧义时显式指定变更类型

心流提示：准备提交时先跑 --staged --report；查当前 WARN 明细也可直接 openarch review。`,
    "help.rules": `openarch rules <action>

管理项目规则脚本与事实能力。

actions:
  check     校验规则 / 脚本配置一致性（含脚本失败隔离）
  facts     列出脚本事实能力（file-classification / structure-metrics / authorities / test-case-spans / invocation-bindings / semantic-relations / change-surface）
  skeleton  生成规则脚本骨架
  scan      扫描并执行项目规则（反模式 / 隐式依赖 / 测试治理 finding）
  discover  发现可纳入治理的规则候选`,
    "help.coordination": `openarch coordination <action>

协调服务命令族；未配置服务时 fail-closed（exit 3），本地 scan/check/review 不受影响。

actions:
  status            查看协调状态（not_configured / unavailable / available）
  bootstrap         读取服务 docs-repo 描述（remoteUrl / branch / headSha）
  refresh           通知服务快进 worktree
  scope register    登记 scope 文档（写入关联 docs-repo 根）
  evidence          上传语义证据
  task              提交 task proposal（服务端校验并追加 verified 事件）
  claim             认领 task（claimed；同执行者幂等，异执行者拒绝）
  complete          完成 task（completed；仅认领者，防重放）
  lease acquire|renew|release  语义锁租约（TTL，fencing token + epoch 防陈旧）

前提：先 openarch init --coordination-url <url> 显式配置；远端不存在时保持 UNAVAILABLE 不伪造。`,
    "help.toolchains": `openarch toolchains [--json]

显示按当前项目 languages 选择的外部编译器/LSP 发现结果，以及用户级和项目本机配置文件的位置。

首次配置可运行：openarch init --toolchains user
当前 checkout 覆盖可运行：openarch init --toolchains project`,
    "help.docs": `openarch docs <check|record|status> [options]

动作：
  check [--changed <file...>|--staged]  检查填写后的文档相似候选
  record [title] [--category <category>]  生成经验模板
  status [--verify]                     查看文档治理状态

运行 openarch docs record --help 查看经验类别说明。`,
    "help.record": `openarch docs record [title] [--category <category>]

生成待填写的经验文档模板；不会检查空白模板。

类别：
  patterns       已验证的改进或重构（默认）
  anti_patterns  经复盘确认的失败或腐化模式
  decisions      项目架构或治理决策

填写后运行 openarch docs check --changed <generated-path>，再在文档库 Git 根提交。`,
  },
  en: {
    "locale.missing": "--lang requires zh or en.",
    "locale.invalid": "Invalid --lang value: {value}. Supported values are zh and en.",
    "locale.invalidProject": "Invalid presentation.locale value: {value}. Supported values are zh and en.",
    "command.unknown": "Unknown command: {command}. Run openarch --help for usage.",
    "analysis.failed": "Analysis failed [{tag}]{path}{cause}",
    "analysis.historyRecovery": "Recovery: first copy .openarch/history/ and preserve the original error, then restore a coherent history record set from Git or an external backup. Do not delete or skip corrupt entries to manufacture clean; if recovery is impossible, historical CRL remains UNAVAILABLE and only the structural baseline can be rebuilt separately with openarch scan.",
    "init.invalidMode": "--mode must be personal or team",
    "init.agentRequired": "--agent requires a coding agent name",
    "init.invalidAgent": "--agent must be one of: {agents}",
    "init.skillDirRequired": "--skill-dir requires a project-relative skills directory",
    "init.agentSkillDirConflict": "--agent and --skill-dir cannot be used together",
    "init.scriptConflict": "--install-script and --replace-script cannot be used together",
    "init.invalidToolchainScope": "--toolchains must be user or project",
    "init.coordinationUrlRequired": "--coordination-url requires an http(s) service URL",
    "init.coordinationConflict": "--coordination-url and --clear-coordination cannot be used together",
    "toolchains.heading": "## External Semantic Toolchains",
    "toolchains.usage": "Usage: openarch toolchains [--json]",
    "toolchains.userConfig": "- User configuration: {path}",
    "toolchains.userConfigUnavailable": "unavailable (set HOME, APPDATA, or OPENARCH_TOOLCHAINS_FILE)",
    "toolchains.projectConfig": "- Checkout-local configuration: {path}",
    "toolchains.languagesMissing": "- No analyzable languages are configured; declare languages in .openarch/config.yml first.",
    "toolchains.language": "- {language}: {availability}",
    "toolchains.tool": "  - {id}: {availability} [{location}]{detail}",
    "context.heading": "## OpenArch Project Context",
    "context.configuration": "- Configuration: {state}",
    "context.baselineAvailable": "- Baseline: available ({files} files; scope={scope}; snapshot={freshness}{scanAt})",
    "context.baselineMissing": "- Baseline: missing",
    "context.baselineScope.compatible": "compatible", "context.baselineScope.different": "different", "context.baselineScope.partial": "partial", "context.baselineScope.unknown": "unknown",
    "context.baselineFreshness.current": "current", "context.baselineFreshness.stale": "stale", "context.baselineFreshness.unknown": "unknown",
    "context.baselineScanAt": "; scan={at}",
    "context.baselineGeneration": "- Baseline generation: active={active}, readable={readable}, temporary generations={transient} (report only)",
    "context.available": "available",
    "context.missing": "missing",
    "context.architecturePolicy": "- Architecture policy: {state}{detail}",
    "context.declaredRules": " ({count} declared rules)",
    "context.worktree": "- Worktree: {paths} paths, {sources} source files{pending}",
    "context.staged": "- Staged: {paths} paths, {sources} source files",
    "context.gitUnavailable": "- Git change set: UNAVAILABLE (the current directory is not a readable Git worktree; local configuration and baseline facts remain observable)",
    "context.pending": "; pending evidence={state}",
    "evidence.current": "current",
    "evidence.missing": "missing",
    "evidence.stale": "stale",
    "context.readiness": "### Governance Readiness",
    "context.footer": "*These are read-only facts, not a prescribed next step. Decide from the task, mandatory constraints, and user authorization.*",
    "context.usage": "Usage: openarch context [--json] [--remote]",
    "architecturePolicy.configMissing": ".openarch/config.yml is missing",
    "architecturePolicy.configRootInvalid": "config.yml root is not a mapping",
    "architecturePolicy.configReadFailed": "Unable to read config.yml{detail}",
    "governance.heading": "## Governance Review (Report Only)",
    "governance.metricPolicy": "### Metric Policy",
    "governance.architectureGate": "- Architecture gate: {verdict} (project rules={rules}, production files evaluated={files})",
    "governance.architectureTriggered": "  [{level}] {name}: {condition} -> {file} -> Suggested: fix the file, or adjust/trial the rule with project evidence.",
    "governance.signalSummary": "  ⚠ {count} governance signal(s): {ids} - see below; PARTIAL/UNAVAILABLE is a fact boundary, not clean.",
    "governance.unconfiguredGate": "- [ATTENTION] The gate has no declared production rules; PASS only means no configured policy was triggered.",
    "governance.policyCalibrationHeading": "### Exploratory Policy Calibration (Suggestions Only)",
    "governance.policyCalibrationBaseline": "- Observed reference (not a default threshold): max_func_branch P95={branch}, nesting_depth P95={nesting}, loc P95={loc}, external_passthrough P95={external}",
    "governance.policyCalibrationUnavailable": "- No complete P95 reference is available; finish a full scan/review before setting a threshold. Do not guess.",
    "governance.policyCalibrationWait": "- The prerequisites for threshold calibration are not available; complete scan/review facts before writing policy.",
    "governance.policyCalibrationAction": "- Ask the project owner to choose: 1) trial one minimal WARN from P95 and Top-3; 2) trial two independent WARNs; 3) defer and record why. State tolerance, sample scope, and re-scan plan; never auto-create a BLOCK on the first trial.",
    "governance.structuralBoundary": "- Structural candidates explain metric policy only; they do not automatically become findings or signals.",
    "governance.noStructuralData": "- No local-burden or historical-trend data is available.",
    "governance.definitionHeading": "- Definition-footprint signal (declaration-dense AND large, report-only): above language decl P95 and loc P95.",
    "governance.definitionEntry": "  -> {path}: decl={decl} / loc={loc}",
    "governance.structuralEntry": "- {path}: local={local} exposure={exposure} disconnected-shape={shape} history={crl}",
    "governance.findingPolicy": "### Finding Policy",
    "governance.antiPatterns": "#### Anti-patterns (Report Only by Default)",
    "governance.antiPatternsUnavailable": "- [UNAVAILABLE] Anti-patterns: {reason}",
    "governance.rulesRun": "- Rules run: {count}",
    "governance.findings": "- Findings: {count}{details}",
    "governance.findingDetail": "  [{ruleId}] {location}: {message}",
    "governance.testPolicy": "#### Test Finding Policy",
    "governance.testsUnavailable": "- [UNAVAILABLE] Test governance: {reason}",
    "governance.testCoverage": "- Coverage: {status} (test files={files}, provider handled={handled})",
    "governance.testVerdict": "- Policy verdict: {verdict} (from collected findings only)",
    "governance.coverageLimits": "- Coverage limits: {reasons}",
    "governance.signals": "### Signals",
    "governance.noSignals": "- No diagnostic signals.",
    "governance.next": "### Next Actions",
    "governance.actionConfigurePolicy": "Do not stop at UNCONFIGURED/PASS: start a threshold-calibration choice from review P95 and Top-3, then configure the smallest rules_warn/rules_block from project evidence; do not copy another project's thresholds.",
    "governance.actionAntiPatterns": "Review anti-pattern findings by category and preserve real positive examples; only discuss a project-level quality verdict after repair or recording a justified boundary.",
    "governance.actionTestCoverage": "Confirm the actual test runner; enable only supported providers. Unknown frameworks must remain UNAVAILABLE rather than letting PASS imply complete coverage.",
    "governance.actionNone": "No signal from this overview needs escalation; continue running openarch check under project policy.",
    "gate.heading": "## Check Policy Verdict",
    "gate.verdict": "- Verdict: {verdict}",
    "gate.verdictWarnSuffix": " ({count} WARNs, see above)",
    "gate.evaluated": "- Production files evaluated: {files}",
    "gate.trigger": "  [{level}] {name}: {condition}{observed}",
    "gate.triggerFile": "    -> {path}",
    "gate.recommendation": "    -> Recommendation: {recommendation}",
    "gate.recommendation.split_function": "Split this function's responsibility, or use a strategy or lookup table.",
    "gate.recommendation.inspect_branch_shape": "First determine whether the control flow is in one function, top-level dispatch, or independent functions.",
    "gate.recommendation.extract_dispatch": "Replace top-level dispatch with a command registry, lookup table, or independent command handler.",
    "gate.recommendation.reduce_local_burden": "Reduce local control complexity or external passthrough first; inspect exposure and module shape in the diagnostics.",
    "gate.recommendation.review_high_impact": "Run openarch review for files with high CRL.",
    "gate.breakdownSummary": "    Existing diagnostic: local={local} exposure={exposure} disconnected-shape(1-connectedness)={shape} composite={composite}",
    "gate.breakdownP95": "    P95: br={branch} ne={nesting} loc={loc} alpha={alpha} 1conn={connectedness} extPa={external}",
    "gate.breakdownBranch": "    {bar} Branches (max function): {value}",
    "gate.breakdownNesting": "    {bar} Nesting depth: {value}",
    "gate.breakdownLoc": "    {bar} Lines (-comments): {value}",
    "gate.breakdownExternal": "    {bar} External passthrough: {value} (direct non-local={external} / P95={p95}{capped})",
    "gate.capped": ", capped",
    "gate.breakdownReview": "    Review-only hub position (alpha): {alpha}; disconnectedness: {disconnected}",
    "gate.unavailable.languages_empty": "- Reason: config.yml declares no analyzable languages, so the baseline adjudication scope is unknown.",
    "gate.unavailable.missing_baseline_index": "- Reason: no readable baseline index is available.",
    "gate.unavailable.baseline_scope_incompatible": "- Reason: the baseline analysis scope differs from current configuration or is not a complete scan.",
    "gate.unavailable.metric_contract_incompatible": "- Reason: the baseline does not use the current metric contract.",
    "gate.unavailable.unsupported_gate_metric": "- Reason: project rules use a non-gate metric.",
    "gate.unavailable.missing_max_function_branch": "- Reason: the baseline lacks maxFuncBranch; a legacy file aggregate cannot replace function complexity.",
    "gate.unavailable.missing_metric_language": "- Reason: the baseline lacks parser-confirmed file language; rebuild multi-language facts with a complete scan.",
    "gate.unavailable.unconfigured_language_policy": "- Reason: a production language has no explicit structural_policies population and cannot inherit another language's thresholds.",
    "gate.unavailable.ambiguous_structural_policy": "- Reason: a production file matches multiple structural_policies populations; narrow scopes until ownership is unique.",
    "gate.unavailable.policy_calibration_missing": "- Reason: an enforced policy population has no sealed P95 calibration.",
    "gate.unavailable.execution_failed": "- Reason: gate execution failed.",
    "gate.diagnostic": "- Diagnostic: {category}/{operation}{path}: {detail}",
    "gate.unavailableAction": "- Action: fix configuration or run openarch scan, then retry.",
    "gate.calibrationHeading": "### Calibration Shift (Report Only)",
    "gate.calibrationShift": "- CALIBRATION_SHIFT {path}: sealed {sealed} -> observed {observed}; rules {previousRules} -> {observedRules}",
    "gate.policiesHeading": "### Structural Policy Populations",
    "gate.policy": "- {id}: {mode}; languages={languages}; files={files}",
    "gate.policy.observe": "observe (no verdict)",
    "gate.policy.enforce": "enforce",
    "gate.none": "none",
    "gate.unconfigured": "- Policy coverage: UNCONFIGURED (the project declares no rules_warn or rules_block)",
    "gate.unconfiguredAction": "- Action: run openarch review for structural, anti-pattern, and test-governance signals; configure policy only after investigation from project evidence.",
    "gate.topHeading": "### Existing Top-3 (Highest Local Burden)",
    "gate.topColFile": "File",
    "gate.topColLocal": "Local burden",
    "gate.topColExposure": "Exposure",
    "gate.topColShape": "Disconnected (1-conn)",
    "gate.topColComposite": "Composite",
    "gate.topLevelHeading": "### Top-Level Control Flow (Report Only)",
    "gate.topLevelColFile": "File",
    "gate.topLevelColWeighted": "Weighted top-level",
    "gate.topLevelColMaxFunc": "Max function",
    "gate.topLevelColTotal": "Total weighted",
    "gate.footer": "*Generated by `openarch check --report`; thresholds are in `.openarch/config.yml`*",
    "check.worktreeStagedConflict": "--worktree and --staged cannot be used together",
    "check.scopeHeading": "## Change Measurement Scope",
    "check.scopeNoChange": "- No change set was selected: D_MR and I_push are not measured in this run. The existing Top-3 below comes from the current baseline and does not describe this change.",
    "check.scopeCurrent": "- Inspect current structure with openarch review, or openarch scan --report after refreshing the snapshot.",
    "check.scopeChange": "- Inspect this change with openarch check --staged --report before scan.",
    "check.worktreeEmpty": "The worktree has no tracked additions or modifications available for Git diff evidence.",
    "audit.heading": "## Configuration Audit",
    "audit.status": "- Status: {status}",
    "audit.event": "- Event: {path}",
    "audit.drift": "- Configuration changed but has not been recorded; run openarch check --record-config to write an audit event.",
    "diff.heading": "## Architecture Increment Assessment\n- Impact upper bound I_push: +{impact}\n- I_push scope: a file-level structural propagation upper bound, not a count of verified declaration consumers\n- Change diagnosis D_MR: {diagnosis}\n- File deltas: {files}",
    "semantic.automatic": "Automatic semantic analysis{suffix}: {files} files, {units} declaration-level change units.",
    "semantic.explicitFallback": "Explicit semantic fallback: {path}={kind}",
    "diff.metric.branch": "maximum function branches", "diff.metric.nesting": "nesting", "diff.metric.loc": "LOC", "diff.metric.externalPassthrough": "external orchestration",
    "diff.scope.existing": "existing file", "diff.scope.introduced": "introduced file", "diff.scope.existing_unavailable": "existing file (before structure unavailable)",
    "diff.metricDelta": "{metric} {delta}{normalized}", "diff.normalizedDelta": " (weighted normalized {delta})", "diff.noLocalChange": "no local-burden change",
    "diff.mrPrefix": "  D_MR {file} ({scope}{source}): ", "diff.sealedBaseline": " (sealed baseline)",
    "diff.introducedBefore": "no comparable before structure; records after facts only and does not enter D_MR.", "diff.unavailableBefore": "before structure is unavailable and was not replaced with zero; it does not enter D_MR.",
    "diff.mrComparable": "{changes}; deterioration +{deterioration}, improvement -{improvement}; exposure delta alpha={exposure}", "diff.exposureUnavailable": "unavailable (before graph was not rebuilt)",
    "diff.summaryDeterioration": "+{value} local burden (does not enter the gate)", "diff.summaryBeforeUnavailable": "comparable before structure is unavailable (does not enter the gate)", "diff.summaryClean": "no local-burden deterioration (0.00; does not enter the gate)",
    "diff.actionConsumers": "Verify direct consumers: {consumers}", "diff.actionPublicContract": "Confirm the public contract has no repository direct consumers, then run language-level contract checks", "diff.actionDependencyBoundary": "Confirm dependency additions/removals respect layering and authority boundaries", "diff.actionQuality": "Run language checks and existing tests for affected modules",
    "diff.plan": "  Verification plan {file}: {contracts}", "diff.publicContracts": "public contract {contracts}", "diff.noPublicContracts": "no public contract change", "diff.planAction": "    -> {action}",
    "diff.staticPath": "- Symbol-reference path: STATIC parser fallback (I_push uses the static dependency graph; LSP facts were not requested)", "diff.semanticNoReports": "- Symbol-reference path: STATIC parser fallback (LSP was requested but returned no provider reports)", "diff.semanticFallback": "- Symbol-reference path {language}: STATIC parser fallback ({provider} unavailable: {reason})", "diff.semanticPath": "- Symbol-reference path {language}: {source} {provider} {availability} (declarations={declarations}, references={references}; {scope}){risk}", "diff.semanticScope": "scope={mode}, declaration-files={selected}/{governed}, families={families}", "diff.semanticScopeLegacy": "scope=undeclared (legacy provider contract)", "diff.semanticRisk": "; risk: {reason}", "diff.semanticReasonUnavailable": "no reason provided",
    "diff.symbolEvidence": "    LSP symbol evidence {symbol}: {source}/{provider} (declarations={declarations}, references={references}) -> {consumers}; {comparison}{risk}", "diff.symbolNoConsumers": "no repository references observed", "diff.symbolComparison": "static import={static}, shared={shared}, static-only={staticOnly}, symbol-only={symbolOnly}", "diff.symbolRisk": "; risk: {reason}",
    "diff.changeSurface": "  Change-surface impact: C_push = Σ λ·log2(n+1)·ω = {total} ({provenance})", "diff.changeSurfaceUnavailable": "  Change-surface analysis unavailable: {language} ({reason}) - no C_push value emitted (no fallback)", "diff.changeSurfaceFile": "    {file} ({language}): {provenance} total={total} (file-level bound {bound}, symbol-confirmed {confirmed})", "diff.changeSurfaceContribution": "      {anchor} ({kind}): λ={lambda} × log2({consumerCount}+1)={reach} × ω={weight} -> {value}; consumers: {consumers}", "diff.changeSurfaceNoConsumers": "no repository consumers", "diff.changeSurfaceUnconfirmed": "symbol-level unconfirmed (static bound {bound} potential consumers not symbol-confirmed)", "diff.changeSurfaceConfirmedBeyondBound": "symbol-confirmed {count} consumers ({list}) - beyond static bound {bound} (bound may contain import-only false positives, or confirmed consumers are tests/out-of-scope files)", "diff.changeSurfaceSignalFileHeavy": "    signal[file-heavy] {file}: file impact I_push={iPush} exceeds change-surface C_push={cPush} - hot file, internal implementation change (file-level false positive)", "diff.changeSurfaceSignalSymbolHeavy": "    signal[symbol-heavy] {file}: change-surface C_push={cPush} exceeds file impact I_push={iPush} - API-surface change (file level understates real impact)",
    "diff.symbolAdmissionHeading": "### Symbol-Scope Formula Admission (Report Only)", "diff.symbolAdmission": "  {file}::{symbol} [{language}/{provider}] {availability}; unmet: {missing}", "diff.symbolAdmissionRequirement.before_declaration_identity": "Git-before declaration identity", "diff.symbolAdmissionRequirement.after_declaration_identity": "stable before/after declaration identity", "diff.symbolAdmissionRequirement.repository_references": "complete repository reference scope", "diff.symbolAdmissionRequirement.public_surface": "public-surface classification", "diff.symbolAdmissionRequirement.common_population": "common versioned file population", "diff.symbolAdmissionRequirement.calibration_samples": "durable positive and negative calibration samples",
    "diff.evidence": "- {state}: {id}", "diff.pendingEvidence": "pending evidence", "diff.history": "history", "history.compacted": "Compacted {compacted} sealed history entries; retained {retained} recent evidence entries.", "history.invalidPolicy": "Invalid history retention policy: {detail}",
    "diff.delta": "  {file}: delta I={impact}  alpha={alpha}",
    "docs.heading": "## Document Similarity Candidates", "docs.scope": "- scope: {scope}", "docs.root": "- document root: {root}", "docs.unavailable": "- Status: UNAVAILABLE ({reason})", "docs.indexed": "- indexed: {indexed}, updated: {updated}", "docs.noCandidates": "- Candidates: 0", "docs.candidates": "- Candidates: {count} (report only)", "docs.candidate": "  [ADVISORY] {left} ~ {right} (minhash={minhash}, simhashDistance={distance})", "docs.usage": "Usage: openarch docs <check|record|status> [...options]", "docs.storeMissing": "No document store is configured. Run openarch init --docs-store project, or configure a shared document scope.",
    "record.invalidCategory": "--category must be anti_patterns, patterns, or decisions. Run openarch docs record --help for usage.", "record.created": "✓ Experience record created: {path} ({category})", "record.check": "  After filling it in, run: openarch docs check --changed {path}", "record.commit": "  Close the loop by committing at the document-store Git root; manual edits are checked by the docs hook.",
    "status.heading": "## OpenArch Status", "status.present": "present", "status.missing": "missing", "status.baseline": "- baseline: {state}", "status.files": "  nFiles: {files}", "status.associated": "associated ({type})", "status.unassociated": "not associated", "status.docsRepo": "- docs-repo: {state}", "status.behind": "  ⚠ {commits} commits behind remote", "status.store": "- document store: {state}", "status.unconfigured": "not configured", "status.scopeUnavailable": "  ⚠ shared document scope is unregistered; similarity checking is unavailable", "status.readiness": "## Governance Readiness (Report Only)", "status.scan": "- scan: {status} {phase} {completed}/{total}{files}", "status.scanStale": "stale running marker (the scan may have been interrupted)", "status.reason": "  ⚠ {reason}",
    "rules.factsHeading": "## Script Fact Capabilities", "rules.fact": "- {id}: {summary} When unavailable: {unavailable}", "rules.astHeading": "## Engine AST Fact Stages", "rules.astFact": "- {id}: {summary}", "rules.skeletons": "- Skeletons: {starters}", "rules.templatesHeading": "## Optional Anti-Pattern Templates (Not Installed; Report Only by Default)", "rules.noTemplates": "- No shipped anti-pattern templates are recommended for the current project languages.", "rules.template": "- {family}: {id} (openarch init --install-script {id})", "rules.unknownSkeleton": "Unknown skeleton: {skeleton}. Available: {starters}", "rules.usage": "Usage: openarch rules <check|facts|skeleton <staged-ast|classification|metrics|authority-import|authority-change-set>>", "rules.commandUsage": "Usage: openarch rules <check|facts|skeleton|scan|discover> [...options]", "rules.contractHeading": "## Extension Contract Check", "rules.scripts": "- Scripts: {count}", "rules.engines": "- anti-patterns={antiPatterns}, implicit-deps={implicitDeps}, test-governance={testGovernance}",
    "scriptFact.fileClassification.summary": "fileKind, pathClass, and repository-relative paths.", "scriptFact.fileClassification.unavailable": "Check languages/file_kinds/paths configuration.", "scriptFact.structureMetrics.summary": "Raw structural metrics and dependency-graph facts from a compatible baseline.", "scriptFact.structureMetrics.unavailable": "Run openarch scan so the baseline scope and metric contract align.", "scriptFact.authorities.summary": "Reusable project or script-local boundaries, plus runtime-derived protectedFiles/authorityIds.", "scriptFact.authorities.unavailable": "Declare owner, protected scope, and valid entry points in project authority_hygiene or this script.", "scriptFact.testCaseSpans.summary": "Provider-confirmed test-body spans, names, and states.", "scriptFact.testCaseSpans.unavailable": "Configure a provider that can process these tests, then repair unrecognized or failed collection scope.", "scriptFact.invocationBindings.summary": "Language-provider-confirmed call receivers, methods, and local binding targets.", "scriptFact.invocationBindings.unavailable": "Write rules only for the conservative binding scope implemented for this language; dynamic or cross-function flow remains unavailable.", "scriptFact.semanticRelations.summary": "Provider-proven direct class/interface relations; collected only when a script requires it.", "scriptFact.semanticRelations.unavailable": "Declare semantic-relations.v1 in script requires and configure a calibrated language semantic provider.", "scriptFact.changeSurface.summary": "Change-driven symbol surface: which declarations changed and which files consume them; available only in a change-set context (check --semantic).", "scriptFact.changeSurface.unavailable": "Declare change-surface.v1 in script requires and run within a check --semantic change-set context.", "scriptFact.staticImports.summary": "ParserStrategy provides static import-source records for registered languages; dynamic, unresolved, or failed parsing remains unavailable.",
    "antiPatterns.heading": "## Anti-Pattern Calibration Report", "antiPatterns.changeSet": "- Change set: {state} ({files} source files)", "antiPatterns.rules": "- Rules: {count}", "antiPatterns.findings": "- Findings: {count}", "antiPatterns.finding": "  [{scope}:{rule}] {location}: {detail}{metadata}{evidence}{suggestion}", "antiPatterns.suggestion": "; suggestion: {suggestion}", "antiPatterns.pruning": "  [PRUNING] {rule}: {input} -> {targets} targets -> {candidates} candidates -> {records} records", "antiPatterns.authorityHeading": "## Authority Hygiene Commit Quality Verdict", "antiPatterns.verdict": "- Verdict: {verdict}",
    "evolution.none": "not retained", "evolution.history": "{status}, confirmed {confirmed}/{inspected} events", "evolution.enumerationIncomplete": "enumeration is incomplete", "evolution.surfaceUnavailable": "- Stable multi-write surface: UNAVAILABLE; {reason}.", "evolution.surfaceAbsent": "- Stable multi-write surface: no reviewable repeated existing surface formed.", "evolution.structureConfirmed": "Structural corroboration: implementation imports {imports}, weak components {components}.", "evolution.structureLimited": "Structural corroboration is limited: the current projection has no internal implementation import relation.", "evolution.surface": "- Stable multi-write surface: {files}; {commits} integrations, {members} new members.", "evolution.members": "  Members: {members}; {corroboration}", "evolution.variants": "  {count} additional projection variants remain in the fact set.", "evolution.evidenceCommits": "  Evidence commits: {commits}.", "evolution.integration": "- Integration: {commits} independent commits, {members} new direct members.", "evolution.membersOnly": "  Members: {members}.", "evolution.coordinationHistory": "- History: {history}; current direct implementation imports {imports}.", "evolution.coordinatorCommits": "  Coordinator commits: {commits}.", "evolution.actionableInvestigation": "- Investigation: first confirm whether this stable existing surface is a justified single registry; establish invariants, then add a contract test or project script defense.", "evolution.insufficientInvestigation": "- Investigation: first confirm whether new members repeatedly require the same entry point to change; current evidence is insufficient to infer a registry or necessary refactor.", "evolution.deferredHeading": "### Evidence Pending", "evolution.deferred": "- {count} coordination surfaces have no usable historical sample; they are outside the investigation queue and are not clean.", "evolution.deferredItem": "- {coordinator}: {commits} integrations, {members} members.", "evolution.gitUnavailable": "Git actions unavailable", "evolution.cochangeHeading": "### Closed Co-Change Background", "evolution.cochangeUnavailable": "- UNAVAILABLE; {reason}.", "evolution.cochangeSummary": "- {count} closed sets remain as traceability facts and do not compete with coordination dossiers.", "evolution.cochangeItem": "- {files} files / {occurrences} occurrences: {members}; {action}; internal imports {imports}.", "evolution.heading": "## Evolution Candidate Report (Report Only)", "evolution.statusUnavailable": "- Status: UNAVAILABLE", "evolution.reason": "- Reason: {reason}", "evolution.noGitEvidence": "- Real Git commits in this repository cannot establish co-change evidence.", "evolution.eligible": "- Eligible Git commits: {count}", "evolution.bootstrapExcluded": "- Excluded {count} bootstrap commits that only added current production files.", "evolution.historyExcluded": "- The current baseline lacks facts for {count} historical paths; they were excluded.", "evolution.relationUnavailable": "- Module relation classification: UNAVAILABLE; {reason}", "evolution.dossierSummary": "- Coordination dossiers: sampled {sampled}, pending {deferred}; stable multi-write surfaces {linked}/{surfaces} ({projections} projections).", "evolution.disclaimer": "- Note: each dossier combines integration facts and repeated existing surfaces for one coordinator; it is an investigation lead, not a finding or refactor conclusion.", "evolution.budget": "- Evidence budget: candidates={candidates}, events={events}/{budget}, confirmed={confirmed}, unavailable={unavailable}.", "evolution.noDossiers": "- There is not enough evidence to form a coordination dossier; this does not prove no corruption exists.", "evolution.queueHeading": "### Investigation Queue",
    "readiness.capabilityAssetMissing": "Core capability asset is missing: {path}",
    "readiness.capabilityAsset": "Core capability asset: {path}",
    "readiness.capabilityMaintenanceChecked": "Last maintenance check: {at}",
    "readiness.capabilityMaintenanceUnobserved": "Read this asset and state reuse or inapplicability before implementation; after changing a capability, CLI, schema, provider, or script contract, update it and run docs check --changed {path}",
    "readiness.documentHookMissing": "Document-repository pre-commit hook is not installed",
    "readiness.documentHookInstalled": "Document-repository advisory hook is installed",
    "readiness.documentHookStale": "Document-repository hook needs its launcher contract refreshed by the current OpenArch",
    "readiness.codeHookMissing": "Code-repository pre-commit hook is not installed",
    "readiness.codeHookExternal": "Code-repository pre-commit hook is owned externally; OpenArch did not modify it",
    "readiness.codeHookStale": "Code-repository hook needs its launcher contract refreshed by the current OpenArch",
    "readiness.codeHookInstalled": "Code-repository enforcing hook is installed",
    "readiness.hookRuntimeAvailable": "Hook executable is resolvable: {executable}",
    "readiness.hookRuntimeMissing": "Hook executable is unavailable: {executable}; install released openarch or set OPENARCH_BIN",
    "readiness.documentStoreMissing": "DocumentStore is not configured",
    "readiness.documentStoreProject": "Project-local document store: {root}",
    "readiness.documentStoreShared": "Shared document store is linked: {root}",
    "readiness.documentStoreSharedUnavailable": "Shared document-store link is unavailable",
    "readiness.documentScopeMissing": "Shared document scope is not registered",
    "readiness.documentScopeRegistered": "Scope is registered in the document store: {scope}",
    "readiness.documentScopeUnregistered": "Project scope binding is not registered in the document-store registry",
    "readiness.documentSimilarityChecked": "Last successful similarity check: {at}",
    "readiness.documentSimilarityUnobserved": "No document-similarity check has been observed",
    "readiness.coordinationNotConfigured": "No coordination service is configured. Local governance and Git document collaboration remain available; remote Task/meeting/lease operations stay UNAVAILABLE. The user must explicitly provide one: openarch init --coordination-url <https://...>",
    "readiness.coordinationConfigured": "Coordination service is explicitly configured: {url} (connectivity is not yet verified; the Git document repository remains durable truth)",
    "readiness.coordinationInvalid": "Coordination service configuration is invalid: {path} ({reason}); correct it or run openarch init --clear-coordination",
    "help.commands": "Commands:",
    "command.init": "Initialize governance boundaries and the document store",
    "command.context": "Show read-only project governance facts for Agent judgment",
    "command.scan": "Create or update the structural baseline; --report reviews current structure",
    "command.review": "Investigate structural, rule, and test signals",
    "command.check": "Verify change impact, policy, and configuration audit",
    "command.rules": "Manage project rules: check|facts|skeleton|scan|discover",
    "command.docs": "Manage governance documents: check|record|status",
    "command.toolchains": "Show external semantic tools and user/checkout-local config locations",
    "command.update": "Check whether a newer release exists (read-only, no auto-update)",
    "command.calibration": "Export advanced calibration evidence",
    "command.coordination": "coordination service command family (status/bootstrap/refresh/scope/evidence/task)",
    "command.lsp": "LSP daemon command family (start/stop/status - jdtls forwarding daemon)",
    "command.antiPatterns": "Anti-pattern rule calibration (report-only by default - includes file/line details)",
    "update.usage": "Usage: openarch update [--json]",
    "update.available": "New version available: current {current} → latest {latest}",
    "update.action": "To update: 1) download the new release binary and replace openarch under %LOCALAPPDATA%\\OpenArch\\bin; 2) re-run openarch init --agent <your-agent> to refresh the project Skill tree.",
    "update.upToDate": "Already up to date: {version}",
    "update.failed": "Update check failed: {detail} (network unreachable or remote unavailable; local governance is unaffected)",
    "help.init": `openarch init [options]

Initialize governance boundaries, the project document store, and an optional commit hook.

Options:
  --docs-store project          Use the current repository's docs/openarch document store
  --docs-repo <path-or-url>     Link a shared document repository
  --docs-scope <scope-id>       Specify a scope when linking a shared document repository
  --coordination-url <url>      Configure an optional local coordination-service base URL
  --clear-coordination           Remove the local coordination-service selection
  --install-hook                Install or update the OpenArch pre-commit hook
  --agent <name>                Update the claude|codex|cursor|opencode|reasonix Skill in this project
  --skill-dir <relative-path>  Update a custom agent's skills parent directory in this project
  --mode <personal|team>        Set governance persistence; personal does not auto-stage .openarch artifacts
  --toolchains <user|project>   Create an empty external semantic-toolchain config without overwriting it
  --install-script <id,...>     Install default project scripts by id
  --replace-script <id,...>     Replace selected uncustomized default project scripts
  --unlink                      Unlink the current document repository

--docs-repo is Git document storage, not a coordination-service address. Local scan/check/review work without either. A coordinator is never inferred from a Git remote or project shape; provide it explicitly here during initialization or later.`,
    "help.scan": `openarch scan [--report] [glob...]

Create or update the structural baseline. By default, scan all source files for the project's configured languages.

Options:
  --report             Show a report-only review of the current structure after updating
  --seal-calibration   Only for a full scan; seal the observed distribution as the gate P95

Use openarch check --staged --report before scan to inspect this change's D_MR; scan --report shows the updated current structure, not a change delta.`,
    "help.context": `openarch context [--json]

Show read-only project governance facts: configuration, baseline, Git worktree/staged source changes, pending evidence freshness, and document and hook availability.

It does not prescribe one next step, refresh the baseline, or change project policy. Agents must decide from the task, explicit policy, mandatory constraints, and user authorization; --json provides stable facts for an Agent.`,
    "help.review": `openarch review [--evolution] [--report]

Investigate existing architecture, structural burden, and governance signals (report-only; the gate remains a separate policy verdict).

Output includes:
  architecture-gate verdict with triggered details (rule + condition + file)
  Top-3 locally heaviest files with the P95 normalized baseline
  anti-pattern / test-governance findings (report-only by default, never auto-adjudicated)

Options:
  --evolution  compare structural burden across git history
  --report     detailed report view

Flow: WARN trigger details are shown right here (no detour); the commit gate remains openarch check --staged --report.`,
    "help.check": `openarch check [--worktree|--staged] [--semantic] [--wait-index] [--report] [--tests] [--full] [--verbose] [paths...]

Unified change validation: change impact (I_push / D_MR), policy gate, and config audit.

Modes:
  --worktree    analyze unstaged worktree changes (default)
  --staged      analyze the Git index (commit gate)
  --full        skip diff prerequisite; full analysis (gate + audit + test governance)
  <paths...>    explicit paths to analyze

Options:
  --semantic       request compiler/LSP symbol-level evidence (worktree only; emits C_push change-surface and consumers)
  --wait-index     with --semantic: wait for a complete LSP index (slow but accurate; acceptance scenarios)
  --report         report view (policy details and WARN list)
  --tests          append test-governance evaluation (compose with --full: check --full --tests)
  --verbose        forensics (D_MR / symbol evidence / formula admission)
  --record-config  write this calibration into project config
  --change-override <path=kind>  explicit change kind when auto classification is ambiguous

Flow: run --staged --report before committing; openarch review shows current WARN details directly.`,
    "help.rules": `openarch rules <action>

Manage project rule scripts and fact capabilities.

actions:
  check     validate rule / script configuration consistency (including script failure isolation)
  facts     list script fact capabilities (file-classification / structure-metrics / authorities / test-case-spans / invocation-bindings / semantic-relations / change-surface)
  skeleton  generate a rule script skeleton
  scan      scan and execute project rules (anti-pattern / implicit-dependency / test-governance findings)
  discover  discover rule candidates eligible for governance`,
    "help.coordination": `openarch coordination <action>

Coordination-service command family; fail-closed (exit 3) without a configured service, local scan/check/review unaffected.

actions:
  status            view coordination state (not_configured / unavailable / available)
  bootstrap         read the service docs-repo descriptor (remoteUrl / branch / headSha)
  refresh           ask the service to advance its worktree
  scope register    register a scope document (written to the linked docs-repo root)
  evidence          upload semantic evidence
  task              submit a task proposal (service validates and appends a verified event)
  claim             claim a task (claimed; idempotent for the same executor, rejected otherwise)
  complete          complete a task (completed; only the claimant, replay-protected)
  lease acquire|renew|release  semantic-lock leases (TTL; fencing token + epoch guard)

Prerequisite: openarch init --coordination-url <url> explicitly; stay UNAVAILABLE without fabrication when no remote exists.`,
    "help.toolchains": `openarch toolchains [--json]

Show external compiler/LSP discovery for the current project languages and the user/checkout-local configuration paths.

Create a user configuration with: openarch init --toolchains user
Create a checkout-local override with: openarch init --toolchains project`,
    "help.docs": `openarch docs <check|record|status> [options]

Actions:
  check [--changed <file...>|--staged]  Check similarity candidates for completed documents
  record [title] [--category <category>]  Create an experience template
  status [--verify]                     Show document-governance status

Run openarch docs record --help for record category guidance.`,
    "help.record": `openarch docs record [title] [--category <category>]

Create an experience-document template to fill in; blank templates are not checked.

Categories:
  patterns       Verified improvements or refactors (default)
  anti_patterns  Reviewed failures or corruption patterns
  decisions      Project architecture or governance decisions

After filling it in, run openarch docs check --changed <generated-path>, then commit at the document-store Git root.`,
  },
} as const;

export type MessageKey = keyof typeof catalog.zh;

export const message = (locale: Locale, key: MessageKey, params?: MessageParams): string =>
  interpolate(catalog[locale][key], params);
