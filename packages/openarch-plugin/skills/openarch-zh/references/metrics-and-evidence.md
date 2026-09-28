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

### 分支权重口径（本节是该口径的唯一权威表述）

`maxFuncBranch` 的取值是**加权和**，不是分支个数：

| 形态 | 权重 |
|---|---|
| 普通 `if` / `switch` 本体 / `match` 本体 | `1.0` |
| 卫语句（`if` 体首条语句是 `return`/`throw`/`break`/`continue`） | `0.3` |
| `case` / `default` 标签、`match` 臂 | `0.3` |

判据由 `StructuralFacts.createGuardClauseDetector` 唯一实现，语言只声明「哪些节点算跳转」与「哪些节点是包裹层」；因此**带花括号与不带花括号的等价形态必须同值**（校准 2026-09-25：此前 TS/JS 只识别无花括号形态、Java 只识别花括号形态，导致给同一行加花括号就能改变分数）。若你看到同一语义的两种写法权重不同，那是判据缺陷，应上报而不是围绕它做重构。

`maxFuncBranchOwner` 是同一份事实的归属投影，给出该函数的 `name`、`line` 与形态分解 `ordinaryIf`/`guardIf`/`caseCount`，可用 `ordinaryIf × 1.0 + (guardIf + caseCount) × 0.3` 复算 `weighted`。它是 report-only，不进入 gate 计算；它的用途是让「按 WARN 拆分」之前先看清代价。

### 认知点代理（read 与写都要用）

结构指标只是认知负担的**代理**，不是认知点本身。读到结构信号时按认知点原则核对：

- 该概念的权威定义在哪一处？是否出现了第二个平行实现（同样的判据/名单/口径写在两个文件里）？
- 本次改动新增的抽象是否**至少有两个真实调用者**？只有一个调用点的私有助手通常是**认知点净增加**，即使它降低了 `maxFuncBranch`。
- `connectedness`（`moduleShape = 1 - connectedness`）上升说明文件更碎；`D_MR` 的行数上升说明代码变多。机械分解可以同时让 gate 变绿并让这两个信号变差——此时应报告取舍，而不是把绿灯当作完成。

#### 单调用点助手占比与「不连通形态」必须并读

两者是**同一张内部调用图**的两个投影，由 `domain/cohesion.ts` 的 `computeInternalCallShape` 一次算出（`connectedness`、`cohesion`、`singleCallSiteRatio`）：

- `moduleShape = 1 - connectedness` 回答「内部函数是否还在一起」；
- `singleCallSiteRatio` 回答「这些函数是真抽象还是机械分解」（分母 = **至少被文件内调用过一次**的函数数）。

**关键判读**：纯机械分解的典型形态是**高连通 + 高单调用点占比**——每个助手都被主函数调用一次，全在同一调用分量里，于是 `moduleShape` 接近 0（看着很健康）而占比接近 1。只看连通性会把「一堆只用一次的助手」判成健康。反过来，占比**不可判定**（文件内没有任何调用点、或旧基线没有该事实）与 `moduleShape` 偏大是两件不同的事，报告会显示为「不可判定」而不是 `0`。

它是 **report-only 伴读值**：不新增 `CRLStateWeights` 维度、不新增 `P95Values` 槽位、不登记 gate 规则变量。理由是它属于「解释」而非「裁决」（宪法：新指标进 gate 需先有跨项目样本），而且改权重指纹会作废已封存校准。它出现在 `check` 的 review 行（与「不连通」同行）与 `diff` 的认知点形态子句（`singleCallSiteRatioDelta`）。**判断某个文件的占比是否偏高，请与项目自身的 P95/分布比较（同项目内相对判读），不要引入绝对阈值。**

`nestingDepth` 只统计块与函数边界（`blockTypes`：语句块、函数/方法、箭头函数、if/for/while/switch、class、try/catch），不统计表达式或对象字面量嵌套。链式 `map`/`flatMap` 中每个箭头函数计一层，因此纯数据装配文件可能得到高 `nestingDepth` 而不等价于认知负担。校准 `deep-nesting` 阈值时按 `>=` 语义（达到阈值即触发），并按本口径解读 P95；对纯数据装配类文件保留人工豁免判断。

#### 局部负担 WARN 的三种读法（校准 2026-09-27，逐项实测取证）

- **规则量的是「每函数最大值」（`max_func_branch`），所以拆分本身就能清线**：实测一次重构让文件总量**保持不变**（`weightedBranchTotal` 13.7 → 13.7）、非本地调用反而上升（41 → 47），仅靠 `maxFuncBranch` 4.0 → 1.3 就让 WARN 消失。清线只说明「没有单个函数超过阈值」，**不等于文件复杂度下降**；请并读报告同屏给出的 `声明行(概念数代理)`（`declarationLoc`，多了就是概念净增）与 `单调用点助手占比`。
- **条件可能是合取**（如 `crl_local > 0.45 && exposure > 0.6`）：某文件不再被点名，**不代表它的每个分量都回到了阈值内** —— 实测例子是 `crl_local` 已降到 0.45 以下、而 `exposure` 仍是 0.603。要判断是否真的改善，请并读该文件的「局部 / 暴露」两项。
- **分量可能已饱和**：外部透传按 `0.15 × min(1, N/P95)` 计入局部负担，达到 P95 后（报告行标 `已截断`）继续降低该维度**不会**改善这一线 —— 它是「没有余量」，不是「还不够好」。本仓实测 **402 个生产文件里 `exposure > 0.6` 的只有 35 个（8.7%）**，所以这条线有区分度：**不要**因为它偶尔贴近阈值就判定阈值失效。
- 需要复测某一文件或整仓的上述数字时，用仓库自带工具（只读、复用 gate 读取路径）：`pnpm measure:structure -- <file...>`、`pnpm measure:structure -- --all --exposure`；读不到 P95 时它显示 `UNAVAILABLE` 而不是 `0`。

普通 `scan` 只更新观察到的 `P95`；封存的校准 epoch 仍是未变文件的分母。`scan --seal-calibration` 是经审查的团队动作。观察值与封存值偏离为 `CALIBRATION_SHIFT`，仅报告。**生产文件 <50 的 enforce 总体是小样本**：gate 输出 caution（sealed/bootstrapped），P95 不稳定，阈值仅观察，不建议新增 BLOCK。

## 退役与闭环状态（校准 2026-08-15）

- 已退役 CEL 变量：`branch_count`、`crl_state`、`crl_inputs`、`cohesion`、`function_count`、`symbol_scope`——写进 gate 规则即配置错误。
- `testMetrics` 持久化已退役：测试治理只读重采，不写回 baseline；`TEST_BLOAT` 保持 `openarch test --bloat` 的 report-only 膨胀诊断，不进治理信号汇总。
- `cohesion` 不再写入新 baseline 分片；旧分片仅读取兼容。

### 测试的 DRY/DAMP 分界（`TEST_BLOAT` 的 `codeSimilarityRatio`）

测试的 DRY 边界与生产代码**相反**，这条分界由工具表达，不要每次靠经验重新划线：

- **装配 / 管线**（`@Mock` 三件套、`@Before` 装配、H2/DDL 建表、连接与结果读取样板）**应 DRY**：抽成 SSOT 的收益明确。
- **断言与测量协议**（`assert*`、`verify`、计数与结果解读）**应 DAMP**：每条用例要能独立读成一条规格；把断言藏进共享 helper 会制造隐式耦合，语义漂移不会再被任何单测发现。

因此 `codeSimilarityRatio` **只对可证明是装配的重复计分**，判据是 provider 确认的**用例体范围**（`test-case-spans` 事实域），并在同一行给出四个桶：

| 桶 | 含义 | 计分 |
|---|---|---|
| 装配（用例体外） | 块完全落在已识别用例体之外 | ✅ |
| 未分类 | 该文件**未识别出任何用例**（体界判据不适用），且块内有调用 | ✅（但显式标出"并非已证实是装配样板"） |
| 用例体内 | 块与已识别用例体相交（含 arrange 与测量协议） | ❌ **不计分** |
| 断言语义重复 | 块内出现已识别的断言/验证调用点 | ❌ **不计分**——抽出去只会制造隐式耦合 |

判据（`assertionRecognition`）覆盖 JUnit 断言族、Mockito `verify` 族、`@Test(expected=…)`、以及同文件/跨文件断言包装函数；用例体来自 provider（JUnit 取方法体、TS 系取用例回调体，均**不含签名与注解行**）。**只有至少识别出一个用例的文件才启用体界判据**——否则"整文件都在用例体之外"会把测试体重复误计成该抽的装配，方向正好相反。

**三条边界必须读**：用例体证据 `PARTIAL`（有未识别或采集失败的文件）、`未识别出用例的文件: N 个`、`块语义证据缺失: N 个文件`（Go/Rust 无对应语法）。这三种情形下的重复按"未分类/总量"计分并如实标注——它是**事实边界，不是 clean**。

**读法**：`codeSimilarityRatio` 触发了才需要看桶。用例体内与断言桶偏高**不需要**动作——报告会这么写；只有装配/未分类桶偏高才提示抽 fixture。历史上的缺陷正是"把断言与用例体重复也算作该抽"，把 Agent 逼向自相矛盾的目标。

### 膨胀因子的可测性按语言判定

五个因子里 `codeSimilarityRatio` 与 `sizeDispersion` 语言中立；其余三个按**语言形状**判定可测性，不可测时报 `UNAVAILABLE` + 原因，绝不写成 0：

| 因子 | 可测语言 | 不可测原因 |
|---|---|---|
| `weakAssertionRatio` | TS 系（**只收有官方出处的 `toBeTruthy`/`toBeFalsy`**；2026-09-27 起不再收无依据的 `toBeDefined`）、Java（`assertNotNull`/`assertTrue`/`assertFalse`） | 其余 `language_not_supported_by_pattern` |
| `fixtureBoilerplateRatio` | 仅 TS 系形状（`mkdirSync`/`writeFileSync`/`git` 调用 + 文本 minhash） | 其余 `language_not_supported_by_pattern` |
| `growthRatio` | 仅 TS 系路径的历史 | 其余 `no_language_matched_history` |

**比较边界（必须读）**：`weakAssertionRatio` 的阈值 0.03 与 `fixtureBoilerplateRatio` 的 0.08 都出自 **TS/JS 总体**的校准；阈值没有语言维度（加语言维度属"新增 P95/阈值维度"红线，需项目所有者决策）。因此当 Java 值触发时，可确认的只是"弱断言占比 = v"这一**事实**，不能直接断言它超标——按 Java 总体重新校准是项目所有者的决定。实测参考：JUnit 自身套件 `v = 0.169`，即该阈值在 Java 上会被远超，这正是它需要独立校准的证据而非结论。

**Java 的 `fixtureBoilerplateRatio` 仍未实现**（有意记录）：TS 判据依赖 `fs`/`git` 调用词表与语言相关的调用文本规范化；Java 侧没有可类比的固定词表，凭想象给它编一套词表会把"惯例"伪装成"事实"。回访条件：出现真实 Java 项目的夹具样板治理需求，并由项目所有者确认词表。

## 探索性策略校准

当 `rules_warn`/`rules_block` 为空、基线作用域当前且存在完整 `P95`/前三项时，`review` 会展示观察基准。它们只是项目校准的输入，不是 OpenArch 默认阈值，也不是跨项目可复制的数值。智能体应先说明容忍度、样本范围、误报处理和回扫计划，再请项目所有者选择一条最小 `WARN`、两条独立 `WARN` 或暂缓并记录理由。首轮不自动创建 `BLOCK`；没有完整 P95 时保持 `UNAVAILABLE`，不从单文件或其他项目猜测。

多语言或多服务仓库用 `structural_policies` 分开校准总体。每个 profile 声明语言集合，并可通过项目相对 `scope.include`/`scope.exclude` 缩小到已明确的区域；语言和 scope 取交集。不要从目录名、包名或 import 图猜测 service。每个生产文件必须恰好命中一个 profile：零命中或多个命中都是 `UNAVAILABLE`，不能借用邻近语言、邻近服务或默认阈值。新增 scope 后先完整 scan 建立其独立 P95，再决定 observe 或 enforce。

## 变更诊断 `D_MR`

`D_MR` 是仅报告的生产变更诊断，使用同一 `P95` 族，分别展示局部负担改善和恶化且不相互抵消。`Δα_struct` 只解释；`connectedness` 不进入 `D_MR`。新文件只有 after 事实，缺少可比 before 事实时必须保持 `UNAVAILABLE`。测试和辅助文件永不参与。

用 `D_MR` 检查已变文件的职责拆分、控制流、嵌套、尺寸或编排。没有独立校准证据时，不得把它接入门禁或加入 `I_push`。
