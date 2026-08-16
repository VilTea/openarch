# 指标与证据

> “调查就是解决问题。”——《反对本本主义》

解释 `I_push`、`CRL_state`、`D_MR`、`P95`、校准信号或生产门禁 `WARN` 前阅读本页。

## 证据边界

`Fact` 是可观察、可版本化的输入；`metric` 是可复现的派生量；`finding` 是规则或 provider 结果；`signal` 仅供诊断；只有 `policy` 产生 `PASS`、`WARN`、`BLOCK`。不得把信号、局部 provider、演化候选或其他项目阈值直接接入门禁。

未知仍是未知。parser、compiler、`LSP` 或 Git 证据缺失时必须报告 `UNAVAILABLE` 或 `PARTIAL`，不能伪装为零计数、低冲击或干净 finding。

## 变更冲击 `I_push`

`I_push = Σ λ_ast × branchMagnitude × α_struct × log2(inDegree + 1) × ω_layer` 是可解释的变更传播上界，不是 `LOC` 或质量分；`λ_joint` 冻结为研究项，不进入活跃公式。

- `λ_ast` 来自实际声明级 diff：接口新增或删除为 100，类新增或删除为 80，公开方法签名为 60，函数签名为 50，字段新增或删除为 40，依赖删除为 15，函数体为 10，已确认兼容增量、分支或依赖为 5，注释或格式为 0。guard 或 case 新增按实际加权分支增量缩放。
- `α_struct` 是带结构置信度的反向 `Reach`，回答“谁可能受影响”；它解释暴露度，不能证明腐化。
- `inDegree` 使用边际递减；`ω_layer` 必须来自项目证据，不能是产品默认；`utilisation`、`spread` 与 `γ_quality` 仍为研究项。

`I_push` 是 report-only 路由证据，不进入 gate（`metricCatalog` 已将其标为 report-only）。高冲击时核对变更类别、公开合同、反向 `Reach`、直接消费者和层权重，据此路由验证强度：拆分独立工作、加强验证，或记录必要冲击的理由；不得靠重命名真实合同变更压低数值。

规模参照：diff 报告同时给出 `intensity = I_push / Σ(λ_ast × branchMagnitude)` 与项目内同规模 sealed 分位（`impactScale`，按变更文件数分桶、checkpoint 按 `sourceEntryCount` 加权）；无同规模样本是未定义，不是 0 分位。跨项目绝对比较需真实多项目规模回归，不能用本项目分位冒充通用结论。

## 符号范围影子指标 `symbol_scope`

符号范围影子公式为 `S_symbol = λ_ast × α_struct × log₂(symbol_consumer_count + 1) × ω_layer`。它仍是可快速重构的内存实验模型，不作独立兼容承诺。`symbol_consumer_count` 是 `provider` 在完整 `declaration/reference coverage` 下确认的去重仓库引用数；静态 `reverse-import consumers` 只作为并列 `staticComparableImpact`，不与 `symbol consumers` 相加。公式不引入未经校准的 `γ_quality` 或 `coverage` 折扣；任一 `profile identity`、共同总体、公开面或 `coverage` 不完整时，`metric` 保持 `PARTIAL/UNAVAILABLE` 且不输出数值。**该指标是 retired 研究影子（校准 2026-08-15）**：`metricCatalog` 标记 role=retired，写进 gate 规则即 `unsupported_gate_metric`；当前没有 CLI/策略消费者，仅保留实验接口，不改变 `I_push`、CRL、D_MR、baseline、history 或 gate。

## 当前负担与趋势 `CRL_state`

`CRL_state` 用项目 `P95` 归一化生产文件，并分离解释视图：

- `localBurden = maxFuncBranch + nesting + loc + externalPassthrough` 是唯一可进入经校准门禁的当前负担族。四个原始输入统一经 `localBurdenInputsOf` 归一化：loc=实现行（排除声明行）、externalPassthrough 已确认值回退 passthroughCalls；gate/review/D_MR/校准同口径。
- `exposure = α_struct` 解释核心位置；有用枢纽不能只因被依赖而受罚。
- `moduleShape = 1 - connectedness` 解释内部调用形态；独立工具函数不应被迫制造调用。
- 历史 `CRL` 是时间衰减的变更负载，不是当前结构判决。

`maxFuncBranch`、`weightedBranchTotal` 和 `topLevelBranch` 是不同事实，不得互相替代或维护平行分支表。只有 parser 确认的直接非本地调用计入 `externalPassthrough`；成员或动态派发保持未知。

`nestingDepth` 只统计块与函数边界（`blockTypes`：语句块、函数/方法、箭头函数、if/for/while/switch、class、try/catch），不统计表达式或对象字面量嵌套。链式 `map`/`flatMap` 中每个箭头函数计一层，因此纯数据装配文件可能得到高 `nestingDepth` 而不等价于认知负担。校准 `deep-nesting` 阈值时按 `>=` 语义（达到阈值即触发），并按本口径解读 P95；对纯数据装配类文件保留人工豁免判断。

普通 `scan` 只更新观察到的 `P95`；封存的校准 epoch 仍是未变文件的分母。`scan --seal-calibration` 是经审查的团队动作。观察值与封存值偏离为 `CALIBRATION_SHIFT`，仅报告。**生产文件 <50 的 enforce 总体是小样本**：gate 输出 caution（sealed/bootstrapped），P95 不稳定，阈值仅观察，不建议新增 BLOCK。

## 退役与闭环状态（校准 2026-08-15）

- 已退役 CEL 变量：`branch_count`、`crl_state`、`crl_inputs`、`cohesion`、`function_count`、`symbol_scope`——写进 gate 规则即配置错误。
- `testMetrics` 持久化已退役：测试治理只读重采，不写回 baseline；`TEST_BLOAT` 保持 `openarch test --verbose` 的 report-only 膨胀诊断，不进治理信号汇总。
- `cohesion` 不再写入新 baseline 分片；旧分片仅读取兼容。

## 探索性策略校准

当 `rules_warn`/`rules_block` 为空、基线作用域当前且存在完整 `P95`/前三项时，`review` 会展示观察基准。它们只是项目校准的输入，不是 OpenArch 默认阈值，也不是跨项目可复制的数值。智能体应先说明容忍度、样本范围、误报处理和回扫计划，再请项目所有者选择一条最小 `WARN`、两条独立 `WARN` 或暂缓并记录理由。首轮不自动创建 `BLOCK`；没有完整 P95 时保持 `UNAVAILABLE`，不从单文件或其他项目猜测。

多语言或多服务仓库用 `structural_policies` 分开校准总体。每个 profile 声明语言集合，并可通过项目相对 `scope.include`/`scope.exclude` 缩小到已明确的区域；语言和 scope 取交集。不要从目录名、包名或 import 图猜测 service。每个生产文件必须恰好命中一个 profile：零命中或多个命中都是 `UNAVAILABLE`，不能借用邻近语言、邻近服务或默认阈值。新增 scope 后先完整 scan 建立其独立 P95，再决定 observe 或 enforce。

## 变更诊断 `D_MR`

`D_MR` 是仅报告的生产变更诊断，使用同一 `P95` 族，分别展示局部负担改善和恶化且不相互抵消。`Δα_struct` 只解释；`connectedness` 不进入 `D_MR`。新文件只有 after 事实，缺少可比 before 事实时必须保持 `UNAVAILABLE`。测试和辅助文件永不参与。

用 `D_MR` 检查已变文件的职责拆分、控制流、嵌套、尺寸或编排。没有独立校准证据时，不得把它接入门禁或加入 `I_push`。
