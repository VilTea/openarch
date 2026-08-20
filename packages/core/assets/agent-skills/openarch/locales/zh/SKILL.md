---
name: openarch
description: |
  在 OpenArch 已初始化的项目中，用本地证据评估架构影响、治理测试与反模式，
  并在改动后运行与项目配置相符的验证。
---

# OpenArch 治理宪法

OpenArch 是面向编码 Agent 的本地、可审计约束，不替用户编排任务。报告事实与项目策略裁决；不要为通过检查而放宽规则、跳过验证或把不确定性写成“干净”。

## 行动原则

> “没有调查，没有发言权。”——《反对本本主义》

- **实事求是（实践循环）**：先读 `openarch context`、配置、baseline、代码和实际输出；跨边界结论必须回到对应对象与场景检验。`PARTIAL`/`UNAVAILABLE` 不是零或 clean。
- **信息论（保留不确定性）**：复用已有事实与变化量；区分事实、指标、发现、信号、策略和校准，并保留身份、来源、scope、生命周期与观察范围。脚本或 provider 只消费明确 scope 的事实；跨生命周期或所有权边界的事实才版本化，诊断信号不进入 `gate`。
- **认知点原则（主要矛盾 / 净减少）**：系统的可维护性主要由维护者必须记住的独立认知点数量决定，而不是由 `LOC`、类数量或模块数量决定。每个重要概念只保留一个权威入口；新增抽象、模块、文档路径或安装路径前，先问它是否造成认知点净增加。平行实现、重复概念、不一致命名、隐藏约定、文档与实现漂移都是认知点增长；SSOT、消费者分析、统一语言、文档与契约校验是其工程化手段。OpenArch 的结构指标只是代理，不等于认知负荷。
- **红军经验（具体、渐进的持久防腐）**：腐化会随变更回流，不追求一次全绿。按主要矛盾和具体条件建立最小防线，先在局部真实样本回扫、修复/校准、验证/沉淀，再扩展；`BLOCK` 不绕过。

## 术语与状态

- 事实状态统一为 `AVAILABLE` / `PARTIAL` / `UNAVAILABLE` / `NOT_CONFIGURED`；`PARTIAL`/`UNAVAILABLE` 是事实边界，不是零或 clean。
- 策略裁决统一为 `PASS` / `WARN` / `BLOCK`；只有项目策略产生裁决，指标、finding、信号不进入 `gate`。
- 指标与公式以 [metrics-and-evidence.md](./references/metrics-and-evidence.md) 为唯一权威；本文件只保留摘要。
- 流程以“最小闭环”为唯一权威；[agent-workflow.md](./references/agent-workflow.md) 与 [project-defenses.md](./references/project-defenses.md) 是它的专项展开，不另立同等地位的流程。

## 调查与判断

**认知链（每次判断先走一遍）**：`主张 -> 实际对象/边界 -> 事实生产者、scope 与生命周期 -> 观察载体、时点与环境 -> 主要矛盾、反例 -> 最小验证实践`。已初始化项目先用 `openarch context` 提供初始项目事实，再按路由选择一个最能减少不确定性的动作；这不是新的 CLI 状态机。

- **界定对象与边界**：名称、接口、配置、报告等表示不等于实际对象；局部观察不等于跨边界结论。判断跨越实现、部署、持久化、时间、所有权或环境时，记录实际对象身份、生产者、作用域、生命周期、输入快照和观察点；用同一事实载体验证，不能用相邻层测试替代。
- **形成可证伪判断**：读当前代码、配置、baseline、历史和既有规则，寻找可比较的正常样本，再提出最小假设和检查。文件名、相似文本、单个指标或一次扫描只是线索；无法由本地事实判断的语义保留为未知，不伪装成默认 gate。
- **审视影响与分歧**：对外行为、持久化数据、跨组件协作或使用方式可能变化时，调查改变内容、依赖者、失败边界及已有接口/测试的证明力。来源相互矛盾时保留各自身份与范围，差异本身是事实，不以多数、权威、习惯或预期抹平。
- **由局部走向推广**：优先复用已验证能力；内部试验保持可重构，只有真实外部兼容边界才需迁移或拒绝策略。通用原则先在不同条件的局部样本回扫、修复/校准和验证；单项目症状与修复仍属于项目经验。
- **认知点净减少审查**：评审或重构时显式检查“这个概念有几个心智入口”：权威定义在哪里、谁消费、谁修改、删除前检查哪里、文档与实现是否一致、新抽象是否有两个以上真实调用者。无法静态证明的设计判断保留为 `review` 启发式，不冒充指标或 `gate`。

## 协作与环境

- 外部语义工具属于 Agent 或 CI 的全局环境。可以读取项目配置、解释器与依赖来解析，但不得为 OpenArch 改项目的 `manifest`、`lockfile`、`node_modules` 或 `.venv`。
- **协调服务是显式可选能力**：本地 OpenArch 默认独立工作；共享 Git 文档库也不意味着存在协调服务。共享模式只有一个远端 DocumentStore：Agent 的 `--docs-repo` 关联、服务 worktree 与服务返回的 descriptor 均指向同一 remote/branch，服务地址不引入第二个仓库。只有用户在初始化或随后明确执行 `openarch init --coordination-url <https://...>` 后，项目才可尝试远程 Task、会议或语义锁。不得从 Git remote、`--docs-repo`、目录、服务名或环境变量推导地址；未配置时这些远程操作是 `UNAVAILABLE`，本地治理照常继续。
- 问题跨多个独立模块、语言或候选根因时，宿主支持子 Agent 才可并行委派启发式调查：每项只回答一个问题，返回证据、反例、未知和涉及范围；主 Agent 比较结论并完成最终验证。共享结论、同一文件或同一状态的改动不得以并发代替调查。

## 指标罗盘

- `I_push` 是声明语义级别、反向结构传播、直接消费者、项目层敏感性和依赖同步完整度构成的**变更冲击上界**，不是 `LOC` 或质量分。高值先核对合同、分类、`Reach` 和验证计划。
- `CRL_state` 以项目 `P95` 观察**当前局部负担**（最大函数分支、嵌套、有效行数、直接外部编排）；`α_struct` 是暴露解释，`connectedness` 是模块形态解释，二者不能单独定罪。
- `D_MR` 只诊断本次生产变更的局部负担改善或恶化，独立展示、不抵消、不进入 `gate`；测试与辅助文件不参与。
- 认知点不是数值指标：`CRL_state`/结构指标是认知负担的代理，不是认知点本身。认知点净减少作为 `review` 启发式与报告信号使用，不进入 `gate`。

详细因子、校准 epoch、coverage 和行动边界见 [metrics-and-evidence.md](./references/metrics-and-evidence.md)。

## 最小闭环

> 以下是最小闭环的唯一权威描述；其它参考页只能展开或引用，不得另写一套同等地位的流程。

1. 先运行 `openarch context`。无 config 时 init；无 baseline 时 scan；不要预先暂存。若基线作用域当前且项目架构策略为 `UNCONFIGURED`，不要在 `PASS` 后停止：继续运行 `openarch review`，依据 P95/Top-3 主动发起一次探索性策略校准，并用宿主原生单选/多选请项目所有者选择“试行一条最小 WARN、试行两条独立 WARN，或暂缓并记录理由”。首轮不自动写配置、不自动 BLOCK；阈值必须说明容忍度、样本范围和回扫计划。**修改了 `structural_policies`/`file_kinds` 等配置后必须 `openarch scan --rebuild`**（增量 scan 按内容 `SHA-256` 短路，不感知配置变化；否则 gate 会报 `policy_calibration_missing` 或沿用旧 scope）。
2. 编辑前读取当前项目绑定的 DocumentStore 能力资产（若存在）和任务相关经验；明确复用哪项项目能力，或为何不适用。接入项目只维护自己的资产、规则和经验；已安装的 OpenArch Skill、runtime/plugin 镜像和发行资产是只读输入，发现过期或不匹配时上报上游，不在接入项目内修改。只有明确维护产品发行仓库时，才按该仓库的发布流程更新源文件和镜像。缺 scope/资产如实报告 unavailable。
3. 实施后，未暂存改动用 `openarch check --worktree --report --output-mode summary`；需要消费者、变更面或公式细节时再升级到 `--output-mode detail`，需要完整 MR/符号准入钻取时用 `--output-mode full`，人类阅读用 `--human`。非 TypeScript 项目需要更精确的符号引用或消费者证据时，先按语言配置全局 LSP 工具链，再运行 `openarch check --worktree --semantic --report --output-mode detail`，读取实际 provider、coverage 与风险。Go/Rust/Python 首次冷启动会等待 LSP 索引（Go 实测 ~70s 一次性，daemon 热后快）；Java 经 `openarch lsp start` 的 jdtls 转发 daemon 预热（advanced 命令，可按宿主 `SessionStart` hook 常驻——见 `docs/lsp-daemon-hooks.md`），工具链不可用时符号级证据不输出（fail-closed，不降级兑底）。常规报告是行动摘要；仅在调查 D_MR、符号证据或公式准入时追加 `--verbose` 取证。准备提交时用 `openarch check --staged --report --output-mode summary`；LSP 只读取工作树，不能冒充 Git index 证据。同一文件反复修改或用户要求架构检查时先 `openarch review`——review 输出直接包含架构门禁 WARN 触发明细（规则 + 条件 + 触发文件），无需绕道；提交门禁才用 `check --staged`。命令级详细帮助用 `openarch <command> --help`。
4. 功能、provider、脚本、配置或命令改变当前项目能力时，按该项目的 DocumentStore 约定维护其能力资产并执行 `openarch docs check --changed <path>`；没有项目资产或不属于当前项目时不要创建/修改它。有可复查结论才 record。

生产代码的自动 diff 缺语义证据时，调查整批路径后一次使用每文件 `--change-override path=actual-kind`；不要将 unknown 默认成 `function_body`。测试/auxiliary 不进入生产 `I_push` 或 D_MR。

## 决策与门禁

- `PASS` 仅表示已声明策略未触发；无项目规则不等于健康。
- `WARN` 调查触发事实、职责与边界；修复、接受风险或经审计调整策略，不能只调低阈值。
- `BLOCK` 必须修复或由项目所有者明确改变策略并审计。详见 [gate-response.md](./gate-response.md)。
- 首次策略校准、个人或团队持久化、共享文档范围等实质选择，先调查，再用宿主原生单选或多选取得授权；例行检查不伪装成选择。

## 报告消费纪律

`check`/`review` 报告是**全量信号面**，不是 Verdict 一行。运行后必须逐项消费，禁止只取 Verdict 就停：

- **Verdict 只是已声明策略的裁决，不是完成判据**。`PASS` 时仍要读完全部 WARN 明细、`TEST_BLOAT`/测试治理、反模式 finding、结构候选与信号节，才可声称工作完成。
- **所有 signal 必须响应**：`PARTIAL`/`UNAVAILABLE` 是事实边界（如 `TEST_GOVERNANCE_COVERAGE`、provider 不可用、`MISSING_BASELINE`），要么处理（`scan` 更新基线、配置工具链、修复 provider 覆盖），要么记录原因，禁止无视或把 PARTIAL 解释为 clean。
- **反模式 finding 逐类复核**：真实正例 → 修复或记录合理边界；不能只因为 finding 不构成 `BLOCK` 就跳过。
- **结构候选 Top-3** 持续上榜的高局部负担文件是治理候选；每次出现判断"已修复 / 本次变更引入 / 已知边界"并在结束时交代。
- **提交前信号面归零或逐条记录**：`check --staged --report` 的 `PASS` 必须伴随"无未处理信号"的显式陈述；有未处理信号时先处理再提交。

## 按需读取

只读取与当前任务对应的一项 reference；不要在普通改动时加载全部细节。

| 任务或信号 | 必读 reference |
|---|---|
| `I_push`、CRL、D_MR、P95、校准、WARN 解释 | [metrics-and-evidence.md](./references/metrics-and-evidence.md) |
| init、hook、个人/团队模式、evidence、文档库、record、升级与 Skill 刷新 | [governance-lifecycle.md](./references/governance-lifecycle.md) 和需要时 [record-guide.md](./record-guide.md) |
| 编写、修改、校准项目脚本或 authority；查询事实能力/消费数、AST facts 与脚本观测 | [script-authoring.md](./references/script-authoring.md) |
| 默认资产、反模式/安全/测试 finding、策略提升 | [project-defenses.md](./references/project-defenses.md) |
| Agent 路由、摘要合同、用户选择、子 Agent 与停止条件 | [agent-workflow.md](./references/agent-workflow.md) |
| 多仓库、多服务、Task/Debt、`review --evolution` | [collaboration-and-evolution.md](./references/collaboration-and-evolution.md) |
| 语言 parser、测试 provider、LSP/compiler/SCIP 语义能力 | [language-and-assurance.md](./references/language-and-assurance.md)；若外部 toolchain 不可用，先运行 `openarch toolchains`，再按项目语言读取 `references/toolchains/{python,go,rust,java}.md` 的对应文件 |
| 追溯方法论原文 | [methodological-sources.md](./references/methodological-sources.md) |
| 功能-理论总览、新增命令/方法论梳理 | [theory-and-feature-map.md](./references/theory-and-feature-map.md) |

## 完成条件

对改动范围运行相称的语言检查、测试和 OpenArch 验证。项目已配置 `quality_rules` 时运行 `openarch rules scan --check`；要观察事实目录健康度时可用 `openarch rules check --unused`（零消费者事实为 WARN 提示）；文档或经验改动按实际 `DocumentStore` 做相似检查。不要手工删除 `pending evidence` 或 `baseline` 分片来获得干净提交；先调查内容身份、可达性和协调边界。
