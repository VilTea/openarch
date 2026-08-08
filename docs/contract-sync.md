# 契约同步治理

> Phase 2 起，契约同步治理是 `authority consistency` 的语言内子集；仓库级的 authority 漂移（如 dogfood 目录硬编码、平行语言事实入口）由 `openarch rules scan` 的 report-only repository 规则承担。

## 范围

契约同步治理防止“同一个合同有多个无追踪表示”在字段变更后静默漂移。它处理编译器看不到的完整影子类型、序列化重复声明和动态语言的裸字段访问；它不是 CRL 或 I_push 因子。

## 当前登记

| contractId | 权威 owner | 允许消费者 | 首个 provider |
|---|---|---|---|
| `p95-values` | `packages/core/src/domain/crlState.ts:P95Values` | 类型导入，或有用途名称的真子集投影 | TS/JS ESLint |
| `baseline-index-entry` | `packages/core/src/port/StorageService.ts:IndexEntry` | 类型导入；schema 是明确边界投影 | 待现有语言工具链验证 |
| `baseline-index` | `packages/core/src/port/StorageService.ts:BaselineIndex` | 类型导入；schema 是明确边界投影 | 待现有语言工具链验证 |

TS/JS provider 当前报告四类确定性事实：adapter 中完整的 `P95Values` 影子类型为 WARN；CLI 对 `p95.<field>` 的裸访问为 ERROR；通用层并行维护语言事实表为 WARN；通用层直接硬编码源码发现 glob 为 WARN。局部投影不报警。规则命中只要求同步工作，不改变复杂度公式。

## 仓库级 authority 漂移（report-only）

以下问题不进入 CRL / I_push，也不由策略检查直接裁决；它们先以 `openarch rules scan` finding 校准：

- `hardcoded-project-shape`：在通用层写死 `packages/**` 等项目结构假设。
- `parallel-language-facts`：在 `LanguageRegistry.ts` 之外重复维护语言 id / 扩展名 / 指示物。
- `authority-bypass`：文件自行实现语言/源码发现逻辑，但未显式使用 `languageSupport.ts` / `projectFiles.ts` 入口。

这类规则的目标是把“新增语言或目录时需要到处修改”的渐进式腐化变成可审计事实，再决定是否由项目策略升级。

## 当前校准结论

| 信号 | 位置 | 当前等级 | 校准边界 |
|---|---|---|---|
| `openarch/no-inline-language-facts` | TS/JS provider | WARN | 只在 authority owner 外，对“至少两种扩展名 + 多语言/指示物”的并行事实表报警；注册 authority 内合法。 |
| `openarch/no-direct-source-glob` | TS/JS provider | WARN | 只在 authority owner 外，对直接源码发现 glob 报警；`projectFiles.ts` 内合法。 |
| `hardcoded-project-shape` | repository anti-pattern | report-only | 只能稳定识别 `packages/**` 一类仓库形态硬编码；它无法仅凭仓库扫描可靠区分“坏味道”和“项目自有 authority/config owner”，因此不进 gate。 |
| `parallel-language-facts` | repository anti-pattern | report-only | 对 authority owner 外、具备多语言/多扩展特征的并行事实表报警；单语言局部事实不报警。 |
| `authority-bypass` | repository anti-pattern | report-only | 对未显式引用 `LanguageRegistry`/`projectFiles` authority 的源码发现重实现，或具备成组特征的语言事实重实现报警；authority import 与不完整语言事实不报警；仍是启发式，只用于暴露漂移候选。 |

这意味着 Phase 2 的 authority consistency 现在分成两层：provider 只承载语言内、可静态证明的问题；repository anti-pattern 只承载跨入口/跨文件的启发式坏味道，并保留不确定性。

## Provider 合同

不同语言使用项目已有的编译器或静态分析器，但应能产出：`contractId`、owner、consumer、rule、severity、remediation。新语言先用一个非法副本和一个合法投影完成可行性验证；未证明的启发式不得 BLOCK。
