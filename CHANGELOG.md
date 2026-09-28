# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（待补充）

## [0.2.0] - 2026-09-28

实地缺陷整改批次（每一条都先在真实项目或真实语料上复现、再修，逐条源码核实；证据记录属内部资料，不随本仓库提交）。
### Added
- **单调用点助手占比（report-only 伴读值）**：`domain/cohesion.ts` 升级为**内部调用图形状的唯一权威** —— `computeInternalCallShape` 一次遍历同产 `cohesion`/`connectedness`/`singleCallSiteRatio`，`computeCohesion` 与 `computeConnectedness` 退化为它的投影（顺带消除两处各自建邻接表的重复）。`FunctionInfo` 在同一遍历里多记 `callCounts`（每个 callee 的原始调用点个数；刻意不"先记总数再按 callee 均摊"——那会编造分布）。占比 = 单调用点函数数 / **至少被文件内调用过一次**的函数数；文件内无调用点时是**不可判定（缺席 / `null`）而不是 `0`**。
  - **与既有指标的有机结合（刻意避免指标堆叠）**：它是 `moduleShape = 1 - connectedness` 的**伴读值**——同一张内部调用图的互补投影，必须并读：纯机械分解的形态是「图仍然连通 + 单调用点占比升高」，只看连通性会把一堆一次性助手读成健康。落点全部复用既有表面：`check` 的 review 行（与「不连通」同行）与 `diff` 的认知点形态子句（`singleCallSiteRatioDelta`），不新开小节。
  - **不新增 `CRLStateWeights` 维度、不新增 `P95Values` 槽位、不登记 gate 规则变量**（改权重指纹会作废已封存校准；新指标进 gate 需先有跨项目样本），也不设绝对阈值——是否偏高按同项目内的相对分布判断。判读纪律已写入 `references/metrics-and-evidence.md`（zh/en）。
- **`maxFuncBranchOwner`（report-only）**：baseline 分片新增「最大加权分支的归属与形态」——`name`/`line`/`weighted`/`ordinaryIf`/`guardIf`/`caseCount`，使 WARN 能说出是哪个函数越界，并让加权值可用 `ordinaryIf × 1.0 + (guardIf + caseCount) × 0.3` 复算。该事实一次持久化、多处消费（gate WARN 明细、脚本事实 `structureMetrics`），不进入 gate 计算。
- **`D_MR` 并列认知点形态**：变更诊断新增 `shape`（`moduleShapeDelta`、`functionCountDelta`），在 `diff` 报告中与局部负担并列呈现、**不并入求和**，使「机械分解让 gate 变绿但文件更碎、声明数上升」当场可见。缺失一律为 `null`，不用 0 冒充。
- **阈值可见性（report-only）**：`check --report` 新增「阈值与当前 P95」小节，逐条给出已声明阈值、当前 P95、**倍数**与**超阈文件数**，并在复合指标（如 `crl_local`）没有 P95 口径时如实标注"不适用"而不臆造倍数。阈值读取与 `metricIdsInCondition` 同源（`metricCatalog.numericGateThresholdsInCondition`），不引入第二套 CEL 解析。
- **`baseline.freshnessReason`**：`freshness` 为 `unknown` 时给出原因码（`no_readable_index` / `scope_not_compatible` / `baseline_missing_snapshot_identity` / `source_snapshot_unavailable`），`context` 文本与 JSON 同时输出，不再让"算不出新鲜度"沉默。
- **`check --report` 提示未入基线的测试文件**：此前只有 `openarch test` 报 `test_files_missing_from_baseline`，不主动跑 test 就会漏掉；判据与 `test` 共用 `unbaselinedTestFiles`（单一权威）。
- **证据缺口落到声明级（B3）**：新增 `changeSurfaces.symbolEvidenceGaps[]`（`{file, language, kind, anchors, reason}`，`kind` 区分 `provider-unavailable` 与 `static-bound-empty`）、`unavailableLanguages[].files`（受影响文件，不再只知道语言）、`impactPlan[].evidenceGap`；`diff` 报告把「空消费者列表 = 未知」与「已确证的 0 消费者」显式区分开，且 `static-bound-empty` 不再让文件看起来"已完全解析"。`computeChangeSurfaceForProfiles` 与 `buildImpactPlan` 共用新的 `symbolEvidenceDossiersForProfiles` 单一权威（reason 不再二次推导，也不存在第二处"provider 是否可用"的判断）。
- **`--change-override-file <json>`**：批量提供路径 → 变更类型映射（`{"path": "kind"}` 或 `[{"path","kind"}]`），与重复的 `--change-override` 合并，非法输入 fail-closed。
- **`docs record --no-comments`**：生成不含 `<!-- 必填 -->` 引导注释的记录模板（默认行为逐字节不变），并输出一行填写提醒。
- **跨语言 parser fixture**：`guardClauseParity`（五语言同语义同比）与 `declarationVisibility`（Java/Rust/TS 成员可见性语义）成为回归护栏。
- **`ParserService.queryText`（可选端口能力，缺省 fail-closed）**：`LspSymbolUse.collectDeclarations` 的三处 risk/声明查询此前只能靠"provider 手上有没有解析器"隐式分派，无法在测试里注入语法树；查询入口现提到 port 上（可选字段）。**缺省语义是 fail-closed：缺省 ≠ 空结果**——未提供时须回退读盘 `query()` 或把该事实标记为不可判定，不得静默当成"查无此事"。证据：port 通道与读盘通道返回值 `toEqual`；真实管线跑通时 `diskReads === []`（确实走了注入的语法树）；`queryText` 对**不存在**的路径仍能命中（证明读的是已加载 AST，不是文件系统）。
- **文档归一化单一权威 `document-store/MarkdownStructure.ts`**：`scanMarkdown` 单遍行扫描 + 状态机——围栏按 CommonMark 判据且**只认已证明闭合**者；HTML 注释用 `<!--`…`-->` 状态机，**围栏内与行内代码片段内不生效**，且**只删成对区间**（未闭合 ⇒ 什么都不删）；frontmatter 只在文档开头、闭合行整行 `---`、且能被 `js-yaml` 解析为**映射**（512 行有界）。`DocumentFingerprint` / `DocumentFill` 的文本正则不再是判据来源，判定逻辑不再有两份。
- **`.vue` 提取路径夹具（6 个）**：`vue-basic-script` / `vue-script-setup-ts` / `vue-mustache-script-literal` / `vue-attribute-script-literal` / `vue-comment-script-literal` / `vue-hostile-control` —— 该路径此前**零覆盖**（缺陷正是从"无夹具"里漏出去的）；并用"干净对照夹具 + 整个 `FileAst` 逐字段相等"证明模板字面量不影响 `loc`/分支/导入图。
- **可配置语言形状 v1（`shapes`，2026-09-27 所有者批准）**：项目可声明 `shapes.<java|typescript>.weak_assertion_methods` **覆盖**内置弱断言名单（此前 AssertJ/Truth/自研 helper 只能靠内置名单猜，声明即覆盖、不是追加）。**身份独立于分析范围**：只有声明了才把 `shapesFingerprint` 写进 baseline meta（未声明 ⇒ 不写该键、判据逐条不变 ⇒ **现有项目零迁移**，不升 `scope-v3`）；兼容判据仍只有 `application/baselineCompatibility` 一处，与 scope 并列消费并报 `baseline_shapes_incompatible`（`check` / `test` / `context` 共用）。判据按**语言**生效（声明 Java 不动 TS），报告披露生效来源（`bloat.weakAssertionShapesSource`，可选追加字段，`test-governance-json` 版本不 bump、不新增 schema 字段）。**阈值不随形状走、不新增阈值维度、不新增 `test_file_patterns`**（测试文件识别仍只有 `file_kinds` + provider `supports()` 一个入口）。v1 只接线判据真正消费的两个键与一类形状；其余一律 fail-closed 报错（理由见 Fixed）。
- **`scripts/release-branch.mjs`（release 策展构建器）**：`release` 与 `main` **没有共同祖先** —— `release` 是"每版本一个 `release: OpenArch X.Y.Z`"的策展快照线，也是**唯一推送到远端**的线，因此"更新 release"不是 merge 而是重建策展子集。脚本按**声明式排除清单**（`.agents/`、`.claude/`、`.obsidian/`、`docs/internal/`、`AGENTS.md`、`CLAUDE.md`，每条都写明理由）把 main 的策展子集写进独立 worktree，应用 release 专属编辑（四份 manifest 的版本号、CHANGELOG 的 `[Unreleased]` → 版本段、`docs/README.md` 里指向 `./internal/` 的链接降级为纯文本），最后跑**引用完整性检查**。`--plan` 只报告差异；**不提交、不推送、不打 tag**（发布是不可逆动作，留给人）。动机是手工策展**没有守卫**：2026-09-27 的树级比对一次就抓到三类漏项（`docs/README.md` 里指向内部文档目录的悬空链接、发行 Skill 引用的 `docs/language-parser-extension.md` 不在 release、两个已被收敛掉的 per-host `INSTALL.md`）。
  - **三处实现上的硬约束（都是实跑撞出来的，不是设计猜想）**：① 所有 `git` 调用必须带 `-c core.quotepath=false` —— 否则中文名路径被转义成 `"docs/internal/\344…"`，前缀匹配**漏掉 23 个中文名内部文档**（第一版 `--plan` 把 `docs/internal` 计数写成了 0 就是证据）；② 策展子集（811 个路径）**不能当命令行参数**传给 `git checkout`（Windows 实测 `spawnSync ENAMETOOLONG`），改用 `git restore --pathspec-from-file=- --pathspec-file-nul` 走 stdin；③ 检查分 **hard/soft 两档并带豁免清单**：`.claude/skills/...` 是文档要告诉用户的**安装落点**而非本仓引用，`CHANGELOG.md`（发布说明）、`__tests__/**`（用 `existsSync` 守卫、在 release 上自动跳过）与脚本自身（它就是排除清单的定义处）不计入 hard —— 第一版把三者混在一起，19 项里 11 项是误报，**会喊狼来了的守卫比没有守卫更糟**。
### Changed
- **`METRIC_CONTRACT_VERSION` → `metric-contract-v5`**（**破坏性**）：卫语句判据收敛为唯一权威实现 `StructuralFacts.createGuardClauseDetector`，语言只声明 `jumpTypes` 与 `containerTypes`。0.1.5 的五个平行实现里有两个互为镜像 —— TS/JS 只识别无花括号形态（`children[0]` 读到 `{`），Java 只识别花括号形态 —— 因此**同一条卫语句的两种等价写法得到不同权重**，给一行加花括号即可让 `maxFuncBranch` 降低 70%。修复后带/不带花括号同值。
  - **迁移**：旧 baseline 会被判为 `metric_contract_incompatible`（或沿用旧事实），必须 `openarch scan --rebuild`，并重新审视已封存 P95 校准（`localBurdenFingerprint` 哈希 `maxFuncBranch`，会报 report-only 的 `CALIBRATION_SHIFT`）。**Java 与 TS/JS 项目的 `maxFuncBranch`/`weightedBranchTotal` 会整体下降**，历史阈值与校准注释需要重新评估；DSH 插件侧 `KNOWN_METRIC_CONTRACT` 已同步为 v5。
- **Java/Rust 成员可见性**：成员可见性不再无条件继承外层类型。Java 类/枚举/record 成员默认包级私有、只有显式 `public` 才对外；接口/注解成员仍隐式 public。Rust 结构体/枚举字段同理（trait 成员仍隐式公开）。此前公有类里的 `private static` 助手会被判为 `public_method_sig` 并进入公共合同与 `I_push`（λ 60 而非 10/50），产生虚假「验证计划」。`DeclarationSyntax.isPublic` 现接收 `DeclarationVisibilityContext`（外层可见性 + 容器类型），五个语言策略改为按各自语义判定。
- **`docs` 未填写判定**：由「是否残留引导注释」改为「剥除注释后必填小节是否仍为空或仅占位符」。模板小节清单（标题 + 引导语）收敛为 `DocumentFill.RECORD_SECTIONS` 单一权威，生成器与判定共用，二者不再漂移。
- **测试治理断言识别**：JUnit 断言名与 Mockito 验证名收敛为 `test-governance/assertionRecognition.ts` 单一权威（原先 14 个名字在 `junit.ts` 与 `assertionContext.ts` 各写一份），跨文件 helper 识别补上 Mockito 验证（按 helper 文件自身的 `org.mockito` import 门控）。
- **`openarch test --json` 逐条 finding**：`decision.findings[]` 提供 `{file, case, kind, line, evidence, confidence}`，包含 review-only 与 exempted 条目（此前非策略 finding 只有一个计数，无法定位用例）。契约 id 仍为 `test-governance-json-v1`（纯追加字段，遵守 authority 的「非破坏字段同版本内追加」纪律）。
- **结构指标口径随发行物下发**：`references/metrics-and-evidence.md`（zh/en）新增「分支权重口径」权威小节与「认知点代理」小节 —— 权重表（普通 if/switch 本体 1.0、卫语句 0.3、case/match 臂 0.3）、复算公式、以及「新增抽象至少两个真实调用者」「`connectedness`/`D_MR` 变差而 gate 变绿时应报告取舍」的阅读规则。
- **WARN 语义**：四条 `gate.recommendation.*` 由命令式（"拆分该函数的职责…"）改为调查式（"先查该函数的分支为何集中…"），并在触发行标出 `[WARN][enforce]` / `[WARN][observe (no verdict)]` —— 裁决模式此前在渲染前就被丢弃，导致强制规则与观察候选项无法区分。报告在 Verdict 行下方新增唯一一句「WARN 不是必须执行的整改指令」声明。顺带修掉共享渲染器里硬编码的中文（英文报告此前会混出汉字）。
- **技能侧同源化**：`SKILL.md` 的「质量优化决策门」把「自动执行并汇报」限定为 `rules_block`/hook/显式 BLOCK，WARN 一律先调查、由项目所有者决定修复/记录接受/经审计重新校准。**英文 `SKILL.md` 此前完全没有这一节**（只有中文侧存在该放大器），现已补齐并逐字对齐。
- **语言扩展指南**：卫语句判据已上移为共享实现，策略只声明 jump/container；fixture 矩阵新增「花括号与无花括号形态必须同权」的强制断言。
- **`TEST_BLOAT` 因子可用性**：五个因子各自带 `AVAILABLE`/`UNAVAILABLE`+原因（如 `language_not_supported_by_pattern`），不可测时**省略取值而不是写 `0.000`**；`score` 改为按可用权重归一化 `Σcontribution / Σw(available)`，并在全可用时跳过除法以保证 TS/JS 分数**逐位不变**；`TestBloatEvidence` 增加块行区间与样本并投影进 `--json`（含 `availableWeight`、`parts[].availability/reason`）。文本输出对不可测因子打印语言中立的 `UNAVAILABLE` 并列出原因。
- **`codeSimilarityRatio` 的 DRY/DAMP 块语义**（校准 2026-09-25）：测试的 DRY 边界与生产相反——装配/管线应 DRY、断言与测量协议应 DAMP。分子现在**只计可证明是装配的重复块**，判据是 provider 确认的**用例体范围**（复用既有 `test-case-spans` 事实域，经 `testGovernance` 传入 bloat，不新开解析）：装配（用例体外）计分；`用例体内` 与 `断言语义重复` **不计分**并单列（明确提示"不该为它抽 helper"）；**未识别出用例的文件不启用体界判据**（否则"整文件在体外"会把测试体重复误计成该抽的装配），其调用块记入"未分类"——计分但标注未证实，不会消失。三条边界如实出现在报告中：用例体证据 `PARTIAL`、未识别出用例的文件数、块语义证据缺失文件数（Go/Rust 无对应语法）。
  - 顺带消除三处重复：相似度的三个消费者（计分 / 分桶 / 文件证据）共用一次切块与指纹；`0.06` 阈值与块窗口收敛为单一来源；语言→语法映射复用 `assertionRecognition` 同一权威（跨文件 helper 解析与块语义分类不再各写一份）。
  - **语义变化需要重新校准**：`codeSimilarityRatio` 改为"非断言且不在用例体内的重复占比"，历史 0.06 阈值按旧口径定（仓库自身 TS 夹具实测 1.25 → 0.375）。`TEST_BLOAT` 按需计算、**不持久化**，因此不动 baseline/契约/校准 profile；判读纪律与四条边界已写入 `references/metrics-and-evidence.md`（zh/en），并留有内部校准记录。
  - 顺带消除两处重复：相似度的三个消费者（计分 / 分桶 / 文件证据）现在共用一次切块与指纹；`0.06` 阈值与块窗口收敛为单一来源（此前证据门控与因子定义各写一次）。
  - **语义变化需要重新校准**：`codeSimilarityRatio` 的取值改为"非断言重复占比"，历史 0.06 阈值是按旧口径定的。`TEST_BLOAT` 按需计算、**不持久化**，因此不动 baseline/契约/校准 profile；判读纪律已写入 `references/metrics-and-evidence.md`（zh/en）。
- **破坏性**：`assessDefinitionSurfaceContracts(cwd, files, contracts, parser)` **新增必需第 4 参数 `parser`**。import 判据从"整文件文本正则"改走 `parser.parse(file) → FileAst.imports[].source`（与 `static-imports.v1` 同源）后，判定必须拿到解析器。该函数**经 `index.ts:72` 的 `export *` 在公开面上**——按名字 grep `index.ts` 查不到，**不要据此判断"非公开"**；仓库内无生产调用方（仅测试），外部消费者需同步传 `ParserService`。
- **源码级 risk 判定不再接收整份源码文本**（D5/D6）：`adapter/symbol-use/*` 的 `LspSourceRisk` 由 `{reason, detected(source)}` 改为 `{reason, pattern, syntax(matches)}` —— **结构上不再存在接收整份源码文本的入口**；Rust `#[cfg]` 两处逐字重复的全文正则合一为 `RUST_CFG_RISK_QUERY`；Go 的 build 约束/generated 改用注释节点 + TS 侧行锚定（实测 TS query 的 `#match?` 只有子串语义、**无锚定**，因此锚定必须落在 TS 侧）。
- **成员可见性判据改吃声明捕获**（D11）：`isInternal` 的入参由裸文本切片改为 `LspDeclarationVisibility{name, modifiers, …}`，`modifiers` 来自声明捕获 —— 不再"在声明名同一行、名字之前的文本里找修饰符"（Java 多行 `public\nvoid foo()` 曾被判 internal，漏掉公开面变更）。Rust 新增 `isInternalRustVisibility`（`pub(crate)`/`super`/`self`/`in …` 仍 internal，只有 `pub` 是公开面）。**该 helper 已按要求收回公开导出**（改经 `rustDefinition.isInternal` 覆盖同一张可见性表，不新增公开面）。
- **文档归一化判据升级：已配置文档库需重建索引**（C-1）：归一化**只对已索引文档生效**，因此升级后必须重建索引 + 重跑相似度校准，候选面**可能漂移**。本仓实测口径（与 **committed 正则版**对拍、输入同为 HEAD、工作树干净）：**131/260 指纹变化**，**全部**由"已闭合围栏内的代码块被结构化剥离"触发，frontmatter 触发数为 **0**；**相似度候选面 193 对 → 193 对，零漂移**。**早前的 4/260 与 148/260 均不可作数**（前者对拍的是中间迭代，后者把目标文件 HEAD 算了进去）。`DocumentFill.isUnfilledRecordDocument` 对**未闭合围栏/未闭合注释 fail-closed 判未填写**（宁可拦住，不猜"已填写"）。
- **文档门禁人口口径变化**（有意）：`RECORD_ORIGIN` 由 `/openarch docs record/` 扩为 `/openarch (?:docs )?record/` —— **纳管 legacy 格式**（前置调研实测共享文档库 26 篇真实记录中 **24 篇**用旧格式 `来源: openarch record`；判据 `33b3f759` 出生时就只认新格式 ⇒ 这是**格式迁移缺口**，不是有意排除；提交级证据：`d7c3cea6` 2026-07-18 净变化 1 行改掉生成器输出）。必填小节匹配改为容忍**尾部括号注解**（`normalizeHeading` 单一权威；反例 `教训与反思` / `复盘教训` / `教训-[通用经验]` / `教训（通用经验）与反思` 全不误匹配）。⇒ 原先静默漏掉的未填写记录**可能新增 `exit 1`**（这正是缺口本身）。`docs check` 同时新增**人口披露**（**report-only**：退出码逻辑一字未动，`--json` 键集合不变，`--unfilled` 不含披露行）。
- **`CelAdapter` tokenizer 改为 `charCodeAt` 单遍扫描**：逐字符正则 → 单遍，实测 min **12.0ms → 2.5ms**（**4.24–4.74×**）。等价性由"测试内保留**改前实现快照**作 oracle + token 序列 JSON 逐字相等"保证（真实条件 14 条 + 合成 >120 条 + **全 BMP 单字符 65536 穷举** + 2 字符矩阵 + 仓库内 42 条真实 CEL 条件，`mismatches = 0`）。**对拍中发现审计未记录的第三个既有特性**：旧实现比较判定的 `/[><=!]=?/.test(src.slice(i, i+2))` **未锚定**，因此 `a>5`（无空格）会产出 value 为 `a` 的 op token 而被 parser 拒绝 —— **已逐字保留、未"顺手修"**（修它会改变 CEL 编译的接受集）。
- **`SKILL.md` frontmatter 合法化**：`.agents/skills/source-command-openarch-review/SKILL.md` 的 `description` 是多行标量且续行未缩进 ⇒ `deficient indentation (3:1)`（ESM 与 CJS 两个构建抛**同一**错误 —— "构建差异"的说法不成立，是文档本身非法）。已给 2 行续行加缩进（语义折叠为同一字符串）；全仓 27 篇有 frontmatter 的文档现为 **0 拒绝**。该文件无镜像，无需同步（4+4 skill 镜像已复核仍逐字节一致）。
- **DSH 插件面与宿主契约对齐**：工具 `parameters` 由 `{type:"object",properties:{…}}` 包壳改为 DSH 的逐属性 DSL（`defineTool` 的 `ParameterSchemaSpec`），`presentResult` 改读 `result.meta` / `isError`。**此前 `register()` 的宽容掩盖了两件事**：包壳不满足 `parameterSchemaSpecToJsonSchema` ⇒ `validateArgs` 参数校验**完全不存在**（隐性依赖宿主宽容）；裁决标题从未渲染（渲染前读的是 `result.verdict`，而结算结果在 `result.meta` 里）。修复后编译出的 wire schema 与模型可见的命令面**逐字不变**（6/6 工具，键集合相同），属"隐藏依赖显性化"而非能力变化。**`dsh-plugin.schema.json` 的 `tools[].parameters` 随之改为 DSL 形态——对把该 schema 当输入的第三方是破坏性变更**（仓库内无消费者；已按契约纪律在 Changed 面显式标注）。另删除从不被宿主读取、也无任何消费者与用例的 `cardKind`。宿主 section order 继续使用字面量 90/108（`SECTION_ORDERS` 不含第三方注册位，改走中心化入口需上游支持，本轮维持现状并记录）。
- **结构事实测量工具（`pnpm measure:structure`）**：`packages/core/scripts/measure-structure.mts`，**只读**且完全复用 gate 的读取路径（`currentFileMetrics` 的 worktree 投影 + baseline `meta.p95` + `loadGateConfig()` 权重），因此不是第二套指标实现。输出逐文件的 `weightedBranchTotal` / `maxFuncBranch`(+归属) / `declarationLoc` / `singleCallSiteRatio` / `nestingDepth` / `loc` / 外部透传 / `localBurden` / `exposure`；`--all --exposure` 额外给出分量分布。**存在理由**：认知点/指标复盘引用的那些数字此前的探针用完即删 ⇒ 报告里的数字**不可由库内命令复现**；现在任何人可一条命令重跑。诚实边界：读不到 P95（未 `scan` 或 index 不可读）时 `localBurden`/`exposure` 显示 `UNAVAILABLE`，**不用 `0` 冒充**。
- **指标读法随发行物下发**：`references/metrics-and-evidence.md`（zh/en 各 4 份镜像逐字节一致，`pluginSkillSync.test.ts` 守）新增「局部负担 WARN 的三种读法」——① 规则量的是**每函数最大值**，拆分本身就能清线（实测：文件总量 13.7 → 13.7、非本地调用 41 → 47，仅因 `maxFuncBranch` 4.0 → 1.3 就 WARN 消失），故清线 ≠ 复杂度下降，须并读 `declarationLoc` 与 `singleCallSiteRatio`；② 合取条件下「不再被点名 ≠ 每个分量都回到阈值内」（实测 `crl_local` 已 <0.45 而 `exposure` 仍 0.603）；③ 分量饱和（外部透传达 P95，报告标 `已截断`）后继续降它没有收益。并附本仓实测分布：**`exposure > 0.6` 只有 35/402 个生产文件（8.7%）**，说明该线仍有区分度（**不要**因为它偶尔贴近阈值就判定阈值失效）。**这条同时更正了我在复盘初稿里的判断**：我当时由几个触发文件都落在 0.603–0.606 推出"该线近乎恒真"，实测分布否定了它 —— 那是选择效应（它们正是因为 >0.6 才被点名）。
- **`@openarch/core` 公开面改为显式导出清单**（`index.ts` 的 72 条 `export *` 全部展开）：此前"内部符号"即公开面 —— 这些模块里的**任何**导出（含为可测性新增的 `javaDefinition`、`rustDefinition`、`RUST_CFG_RISK_QUERY`、`commentLinesOf`、`tokenize`、`Token`、`GO_MOD_SCAN_MAX_LINES`）都会成为公开 API，且新增导出不会触发任何提示。现改为逐模块显式 `export {…}` / `export type {…}`：公开符号 **704 → 605**，移除的 99 个经**全仓词边界取证**（TypeScript AST 枚举 417 个再导出符号 → 105 个零消费者 → 其中 99 个在整仓任何位置都不出现）。保留的 6 个（`DebtDocument`/`EvidenceLevel`/`LeaseCredential`/`SessionCredential`/`TaskDetail`/`TaskSummary`）只有跨语言同名命中（Go struct 与文档文本），按"多保留、绝不误删"处理。**对下游是潜在破坏性变更**：仓库内 0 消费者由 `tsc --noEmit` 与全量测试守住，但**仓库外/已发布 npm 上的外部消费者是否使用这 99 个符号无法验证**（见 Known Issues）。护栏由此变为构造性的：新增公开导出必须显式写进 `index.ts`。`CelAdapter` 此前已单独收窄为只导出 `CelAdapterLive`（`tokenize`/`Token` 的消费者是模块自身与 deep-import 的 token 级对拍测试）。
- **四个局部负担热点按"先锁行为、再动结构"拆分**（纯结构，无行为变化）：`domain/semanticChanges.ts` 的 `parameterArity`（单函数加权分支 17.2 → 3.0）、`adapter/parser/GoModuleResolver.ts` 的 go.mod 扫描器（8.9 → 2.2）、`adapter/semantic-relations/RustSemanticRelationProvider.ts`（纯语法半层拆为 `RustSemanticSyntax.ts`，provider 由 601 行降到 252 行）、`adapter/parser/VueScriptExtractor.ts`（单函数加权分支 6.0 → 3.3、嵌套深度 10 → 6）。每个都**先加特征化回归矩阵**（期望值取自改动前实现的真实输出，而不是"应该输出什么"）再动结构，并由收口方独立复跑差分对拍（输入 41,405 / 5,032 / 6,166 例，`mismatches = 0`）。本仓 `scan --rebuild` 后 `check --report` 由 `Verdict: WARN（3 项）` 变为 **`Verdict: PASS`**。三个新增的模块级导出（`scanGoMod`、`parameterArity`、`GoModScan`/`VueScriptBlock`）仅供测试 deep-import，**不进 `index.ts`**，公开面不变。
  - **边界（如实记录，不当作已解决）**：① Rust 拆出的新模块 `crl_local` 贴着阈值（实施方自测 0.5427 vs 规则 0.55，工具未点名），"热点被搬运"的成分仍在。**后续只读调研更正了本条里的三个数字**（见下一条提交）：语法模块实测 **394 行 / 38 个导出声明**、provider 实测 **262 行**，且它的**直接非本地调用是 47 个**（不是 29 —— 那是我在写本条目时按错误口径记的数）。调研结论：`externalPassthrough` 组件在公式里封顶 0.15（`0.15 × min(1, N/P95)`，P95=36.1），把 47 压到 42 组件**完全不变**，即使把 21 个共用助手 `captureOf` 之外的调用全部下移也只降到约 0.145 ⇒ **"把透传下移到窄接口"不足以让本文件退出规则视野**，真正的裁定只能靠 `scan --rebuild` + `check --report`（当前 PASS）。② `VueScriptExtractor` 的 `exposure` 几乎未变（0.604 → 0.603，仍 > 0.6），规则清除只来自 `crl_local` 跨过 0.45。③ 拆 `parameterArity` 时发现注释里 `max(1, 2).size` 的说法与实测（返回 2）不符，**已按所有者决定只改注释、不改行为**。
- **评估结论（无代码改动）**：`empty_test_body` 扩到 TS/Rust **不做** —— 实测 **0 命中**（本仓 195 个 TS 测试文件的空体用例 = 0，serde 150 个 Rust 文件的空体用例 = 0）⇒ 维持既有能力边界：只有能证明"体里零语句"的 provider 才发该 kind。这是**能力边界**，不是"已覆盖 TS/Rust"。
- **退出码语义随发行物下发**：`gate-response.md`（zh/en，各 4 份镜像逐字节一致）新增「退出码」一节 —— `0`/`1`/`2`/`3` 的含义、`check` 的合并规则（取最强 `3 > 2 > 1 > 0`，含配置审计与 `--tests`）、以及"`0` 不等于健康、`3` 不等于改动有问题（它是事实边界）"。此前发行版指导能力里**完全没有退出码语义**，Agent 无法区分 `PASS`/`WARN`/`BLOCK` 与"治理不可用"。6 个命令 Skill 各加一行**指向**该节而不复制表格（一个事实一个入口）；`exit-code.ts` 的映射注释同步修正（原文把 `3` 只写成"内部错误"，漏了 `UNAVAILABLE` 与配置类错误）。
- **`check --help` 补上 hook 调用面**：`--pre-commit`（pre-commit hook 入口：为暂存内容封存匹配的语义证据；无暂存变更时不做事，与 `--staged` 互斥）与 `--reconcile-baseline`（baseline generation 孤立条目只报告、不原地删除）此前**功能存在但帮助文本里没有** —— 而 `--pre-commit` 正是 `openarch init` 装进项目 `.git/hooks/pre-commit` 的调用命令，属"用户可见的生成物用了隐藏开关"。同时新增一条**完整性守卫**（`skillDocClaims.test.ts`）：`check --help` 与发行版 `gate-response.md` 的 8 份镜像必须都列出 `0/1/2/3` 与 `PASS`/`WARN`/`BLOCK`/`UNAVAILABLE`；该守卫**只证明完整性、不声称措辞等价**（后者要解析自然语言，做不到就不假装做到）。
- **"codex 是首选 Agent"的历史遗留清掉**（例子与文档，**不改任何行为**）：`init`/`openarch-agent-install` **没有也不需要默认目标**——`installAgentSkill` 缺 `--agent`/`--skill-dir` 直接报错，实测 `openarch init` 不带 `--agent` 不写任何 agent 目录，设计 living spec 已声明"不猜测当前 Agent"。此前残留的是**表述**：插件 `README.md`、site 使用手册与 `install-local-binary.mjs` 探针里以 `codex` 为首选示例，插件 `README.md` 的目标清单还是旧的 5 个（漏 `reasonix`），site 的宿主表缺 `dsh` 行、注释里的目标列表也缺 `dsh`，`package.json` 的 `keywords` 漏 `reasonix`。现全部对齐到权威顺序（`claude`/`codex`/`cursor`/`opencode`/`reasonix`/`dsh`），并在 README 与 site 明写"没有默认目标，必须显式指定宿主"。
- **per-host INSTALL 文档收敛为一份**：插件新增 `INSTALL.md`（项目级/用户级两种命令 × 6 个宿主的目标与落点表格 + "没有默认目标"的理由），删除 `.codex/INSTALL.md` 与 `.opencode/INSTALL.md`（同一段文字换一个词的平行副本，仓库内零消费者；而 `.claude/`、`.reasonix/` 被 `.gitignore` **任意深度**忽略，导致"一个宿主一个目录"的对称布局根本做不成）。`package.json` 的 `files` 相应从 `.codex`/`.opencode` 换成 `INSTALL.md`。
### Fixed
- **`docs/README.md` 有 4 条断链**（在 main 上就断）：索引把 `phase1-spark-guide.md`、`demo-scenario-spec.md`、
  `protracted-strategy-assessment.md` 与 `archive/design2-v5.0-vision.md` 写成 `./X`，而这四个文件实际在
  `docs/internal/` 下 ⇒ 点开是 404。现改为 `./internal/X`（9 条相对链接现在全部可解析）。
  这是 `release-branch.mjs` 的引用完整性检查**第一次运行就抓到**的既有缺陷。
- **发布仓的 gate workflow 永不运行**：`.github/workflows/openarch-gate.yml` 触发
  `pull_request.branches: [main]`，而**远端只有 `release`**（`git ls-remote --heads` 实测）⇒ 该 workflow 在
  GitHub 上从不触发，发布仓的 CI 实际只剩 Pages 一条。现触发分支改为 `[release]`。
- **插件文档的 npm 安装路径不成立**：实测 `npm view @openarch/cli|@openarch/plugin|@openarch/core` 全部 **404**
  （三个包都未发布到 registry；`openarch@1.0.7` 是同名无关包），而插件 `README.md` 与 `INSTALL.md` 写着
  `npm install --save-dev @openarch/cli` / `npm install --global @openarch/plugin`。现改为**发行产物路径**
  （`/path/to/openarch-cli-<version>.tgz` 等，与 `scripts/release-notes.mjs` 声明的"可安装产物 = Release Assets"
  一致），并显式写明"未发布到 npm registry"——避免发布物里再出现一句兑现不了的安装说明。
- **随行文件里的内部路径引用**（8 个文件 11 行）：`CHANGELOG.md`(4)、`CelAdapter.test.ts`、
  `RustModuleResolver.ts`、`MarkdownStructure.ts`、`ast.ts`、`languageShapes.ts`、`goTesting.ts`、
  `rustCargoTest.ts` 中指向 `docs/internal/**` 的路径改为路径中立的表述。依据两条：① `release` 树里
  `git grep docs/internal` = **0**（历次策展确实做过这一步）；② `languageShapes.ts` 引用的那份草案在 main 上
  **本身就是未跟踪文件** ⇒ 该引用在两条线上都是悬空的。
- **用户级 Skill 安装器漏掉 `reasonix`**（复验实跑）：`openarch-agent-install --target reasonix` 直接 **exit 2**，而 core 的 `AGENT_SKILL_TARGETS` 与 CLI `--agent` 一直支持它 ⇒ reasonix 用户**根本装不了用户级 Skill**。根因是"支持哪些 Agent"有两份清单：插件 bin 刻意不依赖 `@openarch/core`（要在 `npx` 安装前就能跑），于是它自带副本，而**没有任何东西盯着两边相等**。现补 `reasonix`（`REASONIX_HOME ?? ~/.reasonix`，与项目级 `.reasonix/skills`、CLI `detectHarness()` 同一约定），并新增**行为守卫**：对权威列表里的每个目标真跑一次安装器、断言落点存在（任一边增删目标立刻变红；不比对清单文本，那只等于再抄一遍）。
- **本机安装脚本不回收历史备份**（复验实测）：`install-local-binary.mjs` 只清理**本次**这一份备份，早先因文件占用没删掉的 `.openarch-backup-*` 会永久留下——本机实测积了两份、**各 125.4MB（共 251MB）**。现安装成功后清扫同级所有 `.openarch-(backup|staging)-*`（只匹配点号开头的残留，绝不触碰在用的 `bin`；删不掉只告警，不让一次成功的安装在收尾阶段失败）。实测：两个 7 月遗留被回收，安装仍 exit 0。
- **声明"无判据对应"的语言形状键只改身份、不改判断，报告还打印一句假陈述**（独立 e2e 复现，非实施方自报）：`shapes.python` / `shapes.ts`（错拼）此前被**接受** ⇒ `scan` 写入非空 `shapesFingerprint`（baseline 身份当场作废、需重建），而 `test --bloat` 照旧打印"内置默认（未声明 shapes）"、判据一点没变。现按该模块自己已声明的原则 fail-closed：只接受判据真正消费的 `java`/`typescript`，其余报错；`javascript`/`vue` 这类同族别名额外给出"族键名是 `typescript`"的提示（JS/Vue 项目的真实陷阱）。披露文案同时改为"本项目未声明**被测语言**的 shapes"——`builtin` 不等于"项目未声明 shapes"（多语言仓库可能声明了另一个语言）。**键的口径同时更正**：它是**断言语法族**名，不是任意 `languages` id（原 docstring 的说法与实现不符）。
- **`TEST_BLOAT` 证据行的绝对个数是事实的两倍**（**既有缺陷**，非本批引入）：`patternProbe` 累加**每个 capture** 的行数，而本模块每个模式都有 2 个 capture（`@fn`/`@p` + `@call`）⇒ 报告打印"弱断言 4/6 处"而事实是 2/3（本仓独立夹具实测；模式逐字未变，故比率与分数一直正确——但**报告里的一句数字与事实不符**）。现按匹配的 `@call` 计数并加断言锁住。
- **非法配置在 `scan` 里只打印 `分析失败 [UnknownError]`、原因整句丢失**（独立 e2e 复现）：失败改用与 gate **同一处** `GateConfigurationError`（同一类、同措辞，退出码仍为 fail-closed 的 `3`），并给 CLI 的错误渲染补上 `reason`/`message` 兜底——此前只读 `cause`，于是 `Effect.fail(new Error("…"))` 的消息被整句吞掉（这是一类缺陷，不只 shapes）。
- **`LanguageShapeError.kind` 把"永不会接线"的类别标成"本版未接线"**：`test_file_patterns`（Q3 明令不新增）此前与 `assertion_methods`（将来可能接线）共用 `not_wired`，会让人等一个不会到来的版本；现区分 `unknown_shape_class` 与 `not_wired`，语言键非法改用 `invalid_language_key`（原名 `unknown_language_shape` 实际用于语言键，名不副实）。
- **形状披露行手抄阈值 `0.03`**：同一节下表 `Tᵢ` 列已是阈值唯一权威，而 `weakAssertionRatio` 重校准仍在待办里 ⇒ 手抄的数字会在重校准当天变成一句假陈述。现只陈述"阈值不随形状走，取值见下表"，并加断言禁止该行出现任何小数。
- **Java 无花括号卫语句被全额计费**（`if (c) return;` 记 1.0 而非 0.3）。
- **TS/JS 带花括号卫语句不被识别**（主流风格，ESLint `curly` 默认）——即 0.3 的卫语句权重在 TS/JS 中几乎从未生效。
- **Java 方法重载导致文件永久无法自动分类**（`declarationKey` 不含签名）——0.1.5 中任何含一个重载方法/构造器的 Java 文件都会报 `declaration identities are ambiguous`，即使改动在别处。现在按"签名精确配对 → 单侧被包含则纯增删 → 两侧各剩一个沿用旧 `(id, kind)` 配对 → 否则 fail-closed"的**唯一权威**顺序对齐：新增一个重载、或改一个参数类型都不再需要人工 override，真正无法证明时才失败。
- **歧义只给一句常量、且一个文件毒化整批**：歧义现在带上 `{id, 竞争签名, 建议类别}` 与可读原因，交给 `--change-override`；单文件不可分类只降级自己，兄弟文件保留自动分类。
- **override 账本失真**：原来把"传入的 override 总数"当成"生效数"，且自动分类成功时根本不审计 override；现在区分 `consumed`（真正生效）与 `ignored`（指向本次 diff 内但未被使用），并在成功路径同样审计。
- **`review` / `scan --report` 面的 WARN 仍是命令式且无裁决模式**（dogfood 发现）：E1 的措辞改造只覆盖了 gate 报告那一面，`governance.architectureTriggered` 仍写"建议: 修复该文件…"。现已改为调查式措辞并标注 `[WARN][enforce]`/`[WARN][observe]`（与 gate 面共用同一套 `gate.policy.{mode}` 键），使"WARN 不是整改指令"在两条报告面上口径一致。
- **阈值可见性的"超阈文件数"忽略规则分类器**（dogfood 发现）：它按原始指标在全部生产文件上计数，而规则可能带 `path_class` 等条件——实测 `domain max_func_branch > 5` 被报成 28/358（实为"全体生产文件 > 5"），真值只有它实际触发的那 1 个。现改为直接取 `gatePerFile(...).triggered` 按规则名计数：单一权威、天然包含分类器条件，并删除随之失效的第二份比较实现。
- **`@Test(expected = X.class)` 未被识别为断言**，导致 JUnit 4 异常断言测试被误报 `missing_assertion`；`missing_assertion` finding 现携带用例行号。
- **已填写的 `docs record` 记录被判为未填写**，使 `docs check --changed/--staged` 以退出码 1 拦住完整内容的提交。
- **`--record-config` 帮助文本与实现不符**：原文声称"把本次校准写入项目配置"，实际只写 hash-only 的配置审计事件，从不持久化校准值；帮助文本已改为与 `configAudit.ts` 一致。
- **`scan --rebuild` 抹掉 baseline 新鲜度信号**：`sourceSnapshotSha256` 此前只在增量路径写入，而 `scan --rebuild`（以及因 `config.yml` 变化自动退化全量）是技能文档**明确要求**的配置变更后动作，于是 `baseline.freshness` 按构造永久为 `unknown`。现在只要会真正持久化（完整扫描）就计算该身份。
- **Git 失败不可诊断**：`context` 的 staged/worktree 探测失败时只回传 `spawnSync git ETIMEDOUT` 这类原始消息，看不到命令、超时值、stderr 与耗时；现在 reason 包含 `git <args> | timeout=<ms> | elapsed=<ms> | code=<code> | <message> | stderr=<首行>`，且超时值只有一个权威常量。
- **`context` 文本模式误诊**：任何 Git 失败都会被说成"当前目录不是可读取的 Git 工作树"（超时也被这样误诊）；现在只陈述实测到的失败原因。
- **未配置规则被读成 clean**：`review`/`scan --report` 的反模式节在"没有任何规则被执行且没有规则失败"时明确标注 `NOT_CONFIGURED: 未安装任何项目规则；0 不代表 clean`（规则加载失败或 provider 不可用时已有各自明细行，不重复声称未配置）。
- **非 TS/JS 项目的 `TEST_BLOAT` 数学上不可触发**：`fixtureBoilerplateRatio`/`weakAssertionRatio`/`growthRatio` 的输入探针是 TypeScript 形状或只统计 `.test.ts`，对 Java/Python/Rust/Go 恒为 0，可非零权重上限恰好等于触发阈值（`0.30+0.20 = 0.50`，而触发条件是 `> 0.5`）——"绿"曾是权重表的算术结果而非事实。归一化后同一 Java 夹具得 `0.40/0.50 = 0.80 > 0.5`，触发可达。
- 卫语句判据、断言名单、JUnit/Mockito import 匹配三处平行实现收敛为单一权威入口（认知点原则：一个概念一个入口）。
- **适配器建议给出不存在的 provider id，照抄即 BLOCK**（真实外部项目核实）：`SUGGESTED_ADAPTERS` 手写字符串拼 id，java 建议 `junit`（注册 id 是 `java-junit`）、rust 建议 `rust-cargo-test`（注册 id 是 `rust-testing`）。用户按报告照抄后命中"未知测试 provider"错误分支 ⇒ `verdict=BLOCK`、覆盖 0/256、spans UNAVAILABLE——**报告自己给的建议把自己判 BLOCK**。现改为只引用各 provider/runner 模块导出的 `*_ID` 常量，并新增"建议的每个 id 必须能在 catalog 解析、原样回填后 selection 无错"的合同级回归断言；Java 的 runner 保持留空（Maven/Gradle 是项目决策，不是语言事实）。
- **裁决依据与事实不符**：`decision.errors` 非空时 verdict 来自错误而非 finding，报告却一律渲染"仅基于已收集的 finding"。现明确写为"BLOCK 来自 N 项治理错误，见下"。
- **`@Test(expected=…)` 判据与自身注释意图不一致**：注释写的意图是"测试体非空才算已识别验证"，实现却用 `method_invocation` 计数，导致体里只有构造调用的用例（`new ErrorReportingRunner(null, …)`）被误判为空体并报 `missing_assertion`（JUnit 自身套件 22 处）。现改用 `(_)` 通配子树子节点判"体里至少有一条具名语句"。
- **断言包装只解析一跳**：`用例体 → assertFileIsDirectory → checkFileExists`（体内才是 `assertThat`）这类两跳链被判无断言。现按同文件传递闭包求解，并排除自递归。同一处另有**同名多声明覆盖**的误报通道（`FailOnTimeoutTest` 的 6 个 `evaluate()`）——改按名字取并集（漏报方向安全）。
- **`--json` 帮助文本承诺了条件性存在的键**：`suggestedAdapters` 仅在 `test_governance` 未配置时出现，帮助文本现写明缺省语义。
- **`@Rule` 委托式断言未识别**（项目所有者批准 D-G1）：`thrown.expect/expectMessage/expectCause`、`collector.checkThat/checkSucceeds/addError` 都是 JUnit 4 官方断言 API，但断言被委托给规则对象，体里没有 `assert*` 调用 ⇒ JUnit 自身套件实测 **52 条误报**。现在**该文件声明了 `@Rule`/`@ClassRule`** 时这些名字算断言（门控是文件级事实，与既有的 `mockitoImported` 同形状）。
- **空体与"有断言"混在同一个 kind**（D-G6）：用例体**没有任何语句**时 finding 的 kind 现为 `empty_test_body`，`missing_assertion` 只保留"有语句但无断言"。JUnit 套件实测 193 条空体多是被测夹具类，混在一起信噪比约 1:1。**迁移口径**：按 `missing_assertion` 配置的策略不再命中空体，要治理空体须显式声明 `empty_test_body`。能力边界：只有能证明"体里零语句"的 provider 才发本 kind（Java 已支持；Python 无法表达空体——`pass` 本身就是语句；Go 不设该策略）。
- **Java 布局被文件名后缀规则覆盖**（D-G5）：`classifyFileKind` 只看后缀，把 `src/main/java` 下的生产文件算进测试总体（JUnit 自己的 `org/junit/Test.java` 注解定义、`runners/AllTests.java` 等 4 个，`testFiles` 虚高 256 vs 252）。修法是把布局表达为**推导规则**（`readProjectFileKindRules` = 配置规则 + 布局规则）而不是默认分类器里的分支——这样分类语义的变化会**自动进入 `createAnalysisScope` 的指纹**，受影响的 baseline 会如实报 `baseline_scope_incompatible` 并提示完整 scan，不会静默保留旧 `fileKind`。只在 `src/main/java` 与 `src/test/java` 共存时推导；项目显式 `file_kinds` 规则优先。
- **非 TS 项目的弱断言因子不可测**（D-G2）：`weakAssertionRatio` 的探针写死成 TypeScript 形状，Java 项目即使有活跃 provider 也恒报 `language_not_supported_by_pattern`。现在按语言分派：Java 用 JUnit 形状（`assertNotNull`/`assertTrue`/`assertFalse` 占断言调用比），regex 由 `WEAK_JUNIT_ASSERTION_METHODS` **派生**（不手抄名字）。TS 项目已校准的分数逐位不变。**比较边界（有意记录）**：阈值 0.03 出自 TS/JS 总体校准、没有语言维度（加语言维度属"新增 P95/阈值维度"红线），Java 值触发时只能确认"占比 = v"这一事实；实测 JUnit 自身套件 `v = 0.169`。Java 的 `fixtureBoilerplateRatio` **仍不实现**（TS 判据依赖 `fs`/`git` 词表与语言相关文本规范化，凭想象编词表会把惯例伪装成事实）。
- **覆盖不完整时 verdict 仍是 `PASS`**（D-G4）：免责现落在**裁决行本身**（`未评估全部测试：no_active_provider；…；PASS 不代表 clean`），不再指望读者把上一行"覆盖状态: UNAVAILABLE"与本行连起来看；不动机器契约与退出码。
- **provider 产出的用例体范围不进机器契约**（D-G3）：新增 `openarch test --spans`（人类报告列出 `文件:起始行-结束行`，`--json` 投影进 `collection.testCaseSpans.value`/`spanCount`）——按需取，默认不输出。按契约目录纪律第 3 条属**非破坏性追加**，`test-governance-json-v1` 不 bump。
- **assumptions 被当成缺失断言**：`Assume.assumeTrue(false)` 是前置条件（"跳过该用例"）而非验证。**有意保留边界**，已在 `assertionRecognition` 与 skill 文档写明（此前该位置的注释还把 `@Rule ExpectedException` 记作"不实现"，与实现漂移）。
- **空候选集被报成 `Test-case spans: AVAILABLE`**（D-G9，跨语言核实 `vue3-vitesse`）：`Array.every` 在空数组上是**空真**，于是"没有任何 provider 运行过"（3 个测试文件都未入 baseline）被报成"已评估且为空"。现在候选集为空 ⇒ `unavailable` + 原因，绝不把"没评估"伪装成"评估了且为空"。
- **配置解析失败被吞成"未配置"**（D-G12，跨语言核实 `openarch-java-guide`）：`status.ts` 的 `configured` 只看文件是否存在，于是无法解析的 `config.yml`（实测重复映射键）被报成 `配置: 可用`，而同屏的架构策略行报"无法读取 config.yml"——同一份报告自相矛盾；`test` 更把"你的配置坏了"说成"你没配置"（`test_governance_not_configured`）并因语言静默回退而报 0 个测试文件（实际 2 个）。现在：`context` 增加 `invalid` 配置状态（`context-json-v1` 非破坏追加，消费方按非 `available` fail-closed），`test` 把解析失败作为配置错误 ⇒ `BLOCK` + `[CONFIG ERROR]`。**不翻转** `configured` 的含义——"文件不存在"与"文件读不出来"必须说成两句话。
- **两个不同总体的数字并排打印且无来源标注**（D-G8）：`可发现测试文件`（实时分类）与 `provider 成功处理`（baseline 的 test 条目）是两个总体（实测 252 vs 256、3 vs 0）。现在两者各自标注来源，不一致时增加一行「总体差异」。**该行的归因文案随后由 D-G18 改写**（当时写的"provider 只采集 baseline 中已存在的测试文件"已不再成立）。
- **未入 baseline 的测试文件不产生任何 provider 事实**（D-G18，项目所有者批准）：provider 采集的候选集取自 **baseline 的 test 条目**，而 `TEST_BLOAT` 早已使用**实时发现**集合 ⇒ 同一份报告里两套口径，且会话内新增的测试文件在 `scan` 之前**完全**没有 provider finding（实测 `vue3-vitesse`：可发现=3 / provider 处理=0）。现在候选集统一为 `discoverProjectTestFiles()` 的结果（按各 provider 的 `supports()` 过滤），口径分裂消除；未入 baseline 的 finding 带来源标记 `unbaselined: true`（已入 baseline 的不设该键 ⇒ 缺省即旧语义，逐字节兼容）。同步面：`TestFindingInputSchema`（可选字段）、`test-governance-json-v1` 的 `decision.findings[]`（非破坏追加，**不 bump**，`review-surface` 顶层字段预算未动）、DSH 插件投影（`decision.findings[].unbaselined` + `decision.unbaselinedFindingCount`，全部落在开放的 `decision` 内 ⇒ `dsh-state.schema.json` 无需改动）。覆盖语义同步：`providerCoverage.candidateTestFiles` 现在是实时候选，`test_files_missing_from_baseline` 仍如实表示"未对账"（覆盖保持 `PARTIAL`，仍需 `scan`），「总体差异」行不再把差异归因于 baseline。未入 baseline **不等于** clean 或零：它是事实边界，只报告、不阻断、不改变退出码。
  - **验收**：`vue3-vitesse` 由 `provider 处理 = 0` 变 **`3`**、`testCaseSpans` 由 `UNAVAILABLE` 变 **`AVAILABLE`**；同时 `test_files_missing_from_baseline` **仍保留**（"采集到" ≠ "已对账"）。
  - **两道新护栏**：① DSH 投影新增的键全在开放的 `decision` 内 ⇒ `dsh-state.schema.json` 未改，另加"**顶层键集未变**"的防漂移断言；② 新增回归断言证明**未入 baseline 的 finding 进不了校准证据**（构造性保证：来源标记在 `unbaselinedOf` 一次派生，证据侧只接受已对账条目）。
- **新 kind `empty_test_body` 缺调查建议**：它此前只出现在 `Review finding: N (empty_test_body=…)` 里而没有下一步（违反"所有 signal 必须响应"）。现补 `empty-case-body` 调查建议（夹具 vs 漏断言两条出路 + 按文件豁免建议）。
- **"scope 不兼容"在不同命令下可见性不同**（D-G8③）：同一件事实（baseline 记录的分析范围是否仍是当前的）曾有三份实现——`gateApp.baselineReadiness`（私有）、`status` 的 scope 标签、`scriptFacts.scopeMatches`。结果 `check` 会报 `baseline_scope_incompatible` 而 `test` 静默继续。现新增 `application/baselineCompatibility.ts` 作为唯一权威（判据 + 索引字段映射都在一处），三处改为消费它；`test` 覆盖在范围不兼容时降级为 `partial` 并给出 `baseline_scope_incompatible`（缺一个文件都没处理时仍为 `unavailable`，原因里含该条）。判据顺序与条件逐条照搬，gate 行为不变。
- **验证项目里的重复解析**（D-G13）：`status.ts` 曾在一个函数里把同一份 `config.yml` 解析两次，四个读者各自 `load` + `catch`。现新增 `readProjectConfig(path)` 单一权威（`missing`/`invalid`/`ok`）与 `projectConfigPath()`，`configuredFileKindRules`、`readConfiguredLanguages`、`loadTestGovernanceConfiguration`、`architecturePolicyStatus`、`loadGateConfig` 全部改为消费它。`readConfiguredLanguages` 在 `invalid` 时**仍回退指示文件探测**（行为不变，只去重）。
- **语言自动探测只看项目根**（D-G11a）：根目录没有构建标记的多模块项目探测到 0 种语言（`openarch-java-guide` 的 `pom.xml` 只在 `complete/`、`initial/` 下）⇒ 可发现测试文件 0，而实际有 2 个（声明 `languages: [java]` 后递归扫描完全正常，故不是覆盖率漏洞）。现在 `context` 增加一行**提示**（复用注册表的 `projectIndicators`，只下探一层、只报未覆盖的语言）并投影进 `context-json` 的 `nestedLanguageHints`。**提示不改变 `languages`**，因此不影响 `extensions`、scope 指纹与既有 baseline。
- **Agent 面丢掉逐条 finding 与用例体事实**（D-G15）：DSH 插件只投影 `findingCount` + `triggered`，而默认项目（`rules: {}`）的 `triggered` 为空 ⇒ Agent 看到"458 条 finding"却**一条都看不到**，上一轮"逐条可定位"的修复在 Agent 面上被抵消。现补有界的 `decision.kinds` 直方图 + `decision.findings`（前 20 条，含 file/case/kind/line/confidence/证据摘要）+ `findingsTruncated` + `testCaseSpans`（availability/reason），文本面同样给出构成、样本与体界判据状态。**连带修正**：`testGovernance` 在 DSH 状态 schema 里是 `additionalProperties: false`，新增顶层字段必须同步 schema，已补条目并加"投影通过 state schema"的防漂移测试。
- **新项目 `check` 因配置审计未初始化而 exit 3**（D-G16）：`init` 从不记录初始哈希，而 `uninitialized` 返回 3 并被并入退出码 ⇒ 干净项目 `init → scan → check` 得到 `Verdict: PASS` 却 **exit 3**（实测复现）。这把"没有可比较的哈希"这一**事实边界**当成了失败，与 `PASS` 的语义冲突。现在 `init` 成功时记录一次配置哈希（失败不阻断初始化），`uninitialized` 只提示并返回 0（真正检测到 `drift` 仍返回 1）。
- **`check --staged` 对同一条 git 命令 spawn 两次**（N12）：`check` 解析一次暂存变更集（保护路径判据），`diff` 又解析一次（语义证据）——多一个子进程，且两次读取之间索引可能变化，同一份报告的两段会基于不同快照。现在 `diffCommand` 接受调用方已解析的结果（与 `--worktree` 分支传入可分析路径同一做法）。`GIT_TRACE2_EVENT` 实测 `git diff --cached --name-only` 由 2 次降为 1 次。
- **`scriptFacts` 里的第二份范围比较**（D-G8③ 后续）：`scopeMatches` 曾本地重写 `fingerprint === current && complete === true`，现改为消费共享权威的 `scopeState`（逐字等价、不可能漂移）。它是 `createProjectFacts` 的内部输入而非脚本可见事实，故对脚本无语义影响。
- **生产死代码**：删除 `listTestFiles`（只匹配 `.test.ts`，生产入口是 `discoverProjectTestFiles()`）与 `testGrowthRatio`（把 availability 压成 number——非 git 时返回 0，正是"把不可测序列化成 0"的旧反模式）；对应测试改为直接断言事实边界（非 git ⇒ `growthRatio` 为 `UNAVAILABLE` 且 value 缺省）。`spawnSyncHidden` 是公开导出，保留。
- **`git rev-parse --show-prefix` 有两份平行实现**（D-G17a）：core `changeSet` 取一次前缀纯拼接，而 CLI `semanticEvidence` **每个路径**都 spawn 一次（N 个路径 ⇒ N 次 `rev-parse` + N 次 `git show`）；实测一条 `check --staged` 里出现 2 次相同调用。现在 `infra/gitRepositoryPath.ts` 是唯一权威（`gitRepositoryPrefix` / `repositoryPathOf` / `gitRepositoryPath`），两处消费并把前缀提到循环之外。**D-G17b（staged `changeSet` 每次运行解析两次）的决策记录见内部整改计划 §11.4。**
- **契约 import 检查把"注释/字符串命中"当成"已接入"**（D4）：`definitionSurfaceContracts.ts` 删除了对整个文件文本的 `importPattern.test(source)`（审计里唯一"正则命中 = 治理结论"的点，漏报方向是假阴性），改走 `parser.parse(file) → FileAst.imports[].source`（与 `static-imports.v1` 同源）。**fail-closed**：读不到/解析不了的角色文件产出"无法判定"finding，而旧实现在这种情况下静默 `continue`（等于当作"已接入"）。
- **`governancePersistence` 会把用户 `config.yml` 写成无法解析的状态**（D7）：守卫从"正则判单行 flow"改为**解析结果判据**，并在写入前新增 `assertPersistenceWriteSafe`（对**待写入文本**重新解析并核对三条不变量，任一不满足即 **fail-closed 不落盘**）；顺带修掉"改掉的是嵌套 `governance.history.persistence`、却从未设置 `governance.persistence`"的静默写错键路径。**证据形态需注意**：审计原文写的反例（`}` 顶格）在实装 `js-yaml 5.2.1` 下先抛 `deficient indentation`、**不可达**；真正可达且实测能写坏文件的是 **flow 续行缩进版**（旧实现静默追加第二个顶层 `governance:` 键 ⇒ 读回 `duplicated mapping key`）。两条路径均有断言：不落盘 + 文件逐字节不变 + `^governance:` 只出现 1 次。
- **`.vue` 的 `<script>` 提取把模板 HTML 当 JS**（D3）：旧实现用裸 `indexOf("<script>")` / `indexOf("</script>")`，HTML 注释、模板字符串与标签属性里的 `<script>` 都会骗过它，错误文本直接进 `parseVue`/`queryVue` 污染 `loc`/分支/导入图。现重写为**单遍 O(n)** 扫描器，只跳过三类**可证明**上下文（HTML 注释不可嵌套 / 插值按 JS 引号规则 / 标签内部引号感知），闭合标签按 HTML raw-text 规范处理。
- **manifest 读取靠子串猜测**（C-5）：`RustModuleResolver.ts` 改用 **`smol-toml`**（已是 core 依赖）按 `package` 表存在性判定，删掉 `/\[package\]/` 子串猜测；`GoModuleResolver.ts` 改为**单遍有界**扫描器（512 行、块深度、行注释、带引号路径）。两者解析不了都返回"未解析"，**绝不当作"没有依赖"**。
- **同一份文档文本被重复归一化**（C-8）：`DocumentFingerprint.ts` 删除对同一文本的**重复** `codeFeaturesOf` 调用，并消除 `indexedDocument` 的第二处重复归一化；golden 逐位不变。
- **`check --staged` 每次运行解析两次变更集**（D-G17b）：`collectGitChangeSet` 增加**进程内备忘录**并导出 `resetChangeSetCache()`（消费者：CLI 命令派发点、测试 `afterEach`）。`GIT_TRACE2_EVENT` 实测 `check --staged`：`--name-only` 1×、`--name-status` **2→1×**、`--show-prefix` **2→1×**。
- **长文本被重复读盘**：`testBloatMetrics` **4→2 次/文件**；`semanticRelationPipeline` + `JavaSemanticRelationProvider` **3→1 次/文件**。
- **`agentSkill` 把"配置读不出来"说成"项目没配置"**（与 D-G12 同类）：`projectSkillLocale` 自己 `load(...)` + `catch { return "en" }` ⇒ 一份声明了 `presentation.locale: zh`、但 YAML 写坏的仓库会被**静默装上英文 Skill**，而报告只显示 `en`。现在读取走 `readProjectConfig`（config.yml 唯一读取权威）：`missing` 才用英文默认值，`invalid` 如实报错且**不落盘任何目录**，只有"已声明但不支持的取值（如 `fr`）"才确定性按英文处理（这是策略，有用例守）。同处把一条标题写成 "missing or malformed"、用例体却只覆盖 `fr` 的断言改正为两件事分别覆盖。
- **两个测试用 `process.cwd()`/相对路径定位仓库文件**：`packages/core/__tests__/semantic-relations/openarchWorkspace.integration.test.ts` 用 `resolve(process.cwd(), "..", "..")` 求仓库 root，`packages/cli/__tests__/unit/packageContract.test.ts` 用裸相对路径 `package.json` / `../core/package.json` ⇒ 只在特定 cwd 下成立，换 cwd 即 `ENOENT`（实测在仓库根 cwd 下分别解析到 `E:\workspace` 与 `E:\workspace\llm\core\package.json`）**假失败**，会被读成回归。现改为按**测试文件自身位置**（`import.meta.url`）求路径，并已在仓库根与无关 cwd 两种 cwd 下各复跑一次通过。
- **`typeAnchorFor` 对裸标识符静默切掉首字符**（`adapter/semantic-relations/RustSemanticSyntax.ts`）：取段用无条件 `head.slice(lastSeparator + 2)`，而无 `::` 路径时 `lastIndexOf("::") === -1` ⇒ `slice(-1 + 2) = slice(1)`。**具体症状**（探针实测 `startIndex: 1000`）：`Request` → `{name:"equest",startIndex:1000}`、`Self` → `{name:"elf"}`、`Result<u8>` 在 `<` 处截断后 → `{name:"esult"}`、`Vec<Request>` → `{name:"ec"}`；单字符类型名直接**不可判定**（`u8` → `undefined`，段退化为 `"8"` 后正则不匹配）。fix 为 `const segment = lastSeparator >= 0 ? head.slice(lastSeparator + 2) : head;` —— **名字与 offset 是同一表达式的两个症状**：旧 offset 在无 `::` 时多加 1，只是裸标识符上正则 `…\s*$` 的 `match.index` 恰好把它抵消；一旦该段内出现前导空白（如 `"  &'static mut Vec<Request>"`），旧实现把锚点定位到名字**前一个空格**上。引用/裸指针解包、`<` 截断、结构形态跳过表与 `undefined` 返回**一字未动**。
  - **证据（差分对拍，"除缺陷类外逐位相同"）**：从 `git show HEAD:…` 逐行取出改前实现为临时基线模块（仅重命名标识符，与 HEAD 逐行对拍**仅 8 行差异、全部为重命名**），与改后实现同输入对拍 **`checked=4735` / `mismatches=1780`**。逐条分类**全部**落在同一根因的三类，**无第四类、无未分解项**：① `old.name === new.name.slice(1)` 且 `startIndex` 相同 **900** 条（正是原任务预登记的形态，100% 吻合）；② 名字相同、`new.startIndex === old.startIndex + 1` **615** 条（旧 offset 落在名字**前一个字符**上，即同一个 `+2` 的 offset 症状）；③ 单字符类型名由 `undefined` 变为可判定 **265** 条（其中 145 条新名字长度为 1）。独立不变量复核：`new.startIndex` 在输入文本上的同长切片**逐字等于** `new.name`（**2380/2380，0 违例**），而旧实现有 **1515/2380** 违例；offset 相对旧值的偏移量非 `{0, +1}` 的为 **0** 条。⇒ 超出预登记字面形态的 ②③ 两类**不是新引入的行为**，而是同一 `slice(1)` 在 `match.index > 0` 与单字符名上的必然投影；修复同时把"名字"与"offset"归位。**收口方独立复核（另一套判据、3,130 例）**：不变量"返回的 `startIndex` 必须指向该名字、且该名字在该位置是极大标识符"——改前 **1,386 处违规**、改后 **0 处**；差异全部属于"旧名是新名的真后缀（丢了前导字符）"或"同名但旧 offset 指错字符"两类，**第三类 0 条**。
  - **回归**：`__tests__/semantic-relations/rustSyntaxMapping.test.ts` 的锚点矩阵由 **34 条扩到 53 条**（19→32 条命中、15→21 条 `undefined`，覆盖矩阵 14→15 个用例），重新钉为完整名字，并补齐裸标识符/`Self`/泛型/作用域路径/前导空白/带生命周期与 `mut` 的引用/`*const`·`*mut` 裸指针/结构形态（`(A, B)`、`[A; 4]`、`dyn T`、`impl T`、`!`、`_` 仍为 `undefined`）；新增用例「keeps the anchor name and its offset on the same character」（16 条 `name` 与 `startIndex` 双断言 + 16 条"`text` 在 `startIndex` 处的同长切片必须等于 `name`"不变量 + 6 条结构形态仍 `undefined`）锁死该缺陷，并在候选装配层断言**全部 4 条**曾丢字符的候选名 `Request`/`Vec`/`Option`/`Box`。无断言被削弱或删除。
- **共变集证据测试依赖真实仓库历史**（flaky 根因）：`packages/core/__tests__/application/evolutionEvidence.test.ts` 的两个用例调用 `enrichCoordinationCandidates(process.cwd(), …)`，其 `unavailable` 结论取决于**本仓库历史里恰好没有那个 revision** —— 输入随每次提交变化（逐提交验证时确实失败过 1 次，同提交 3 次复跑又通过）。现改为自建 fixture git 仓库（复用既有 `withGitRepo`，仍走真实 git 失败路径），revision 换成绝不可解析的全零对象名，并新增"分析根必须位于临时目录"的断言 ⇒ 该文件 `process.cwd()` 出现次数 **0**。证据：连续 5 次运行全绿 + 换 cwd（仓库根）运行全绿；断言数 9 → 13，**无一条被删除或放宽**。
- **Go 测试名判据比官方更严**：原判据 `^Test[A-Z]` 会漏掉**合法**测试 `Test_foo` / `Test1`（官方措辞是 "any function of the form `func TestXxx(*testing.T)` where **Xxx does not start with a lowercase letter**"，`_` 与数字都不是小写字母）。现改为负向断言 `^Test(?:[^a-z]|$)`；`Testify`（`Test` + 小写字母）仍不算。`Benchmark`/`Fuzz`/`Example` 官方是另一套命名规则，本 provider 未覆盖，**未一并扩大**。
- **Go 断言识别此前只看调用名**：官方 FAQ 逐字 "Go doesn't provide assertions"——失败信号来自 `*testing.T` 的方法（`Error/Errorf/Fatal/Fatalf/Fail/FailNow`），而比较逻辑写在 `if` 的**条件**里（官方 Overview 范例 `if got != 1 { t.Errorf(...) }`）。现改为**三层判据**：调用名 + **接收者∈该函数参数表解析出的 `*testing.T` 名集合** + `if` 条件形态。⇒ 自定义类型的 `x.Error()` 不再被误收；`if a != b { ... }` 这类**体内没有失败调用**的比较决策点现在能被识别（旧口径完全看不到它）。实现边界如实注明：tree-sitter 查询不暴露父节点，因此用可闭合的形状（"守卫体内没有该接收者的失败调用 ⇒ 该守卫自身是一个比较断言点"）表达，且与失败调用**用 offset 包含配对，不重复计数**（`if a!=b { t.Errorf }` 与裸 `t.Errorf` 各计 1）。
  - **连带的事实口径变化（如实披露）**：断言归属由"行号包含"改为"**offset 归属**"（与同一 provider 的 findings 循环、`controlFlow.ts` 同一权威）⇒ **表驱动父用例的 `assertionCount` 由 1 变 0**：其断言全在 `t.Run` 的子测试闭包里，而闭包的 `t` 是**它自己的参数** —— 父用例体内确实没有任何失败调用。这正是三层判据第②层（接收者∈参数表）的直接后果，不是放宽。若要"子测试断言上浮父用例"，那是**新的归属机制**，需另立一批（回访条件）。
  - **契约/迁移**：无。`assertionCount` 是运行时重算、**不进 baseline**；`test-governance-json-v1` 结构未变；阈值（`weakAssertionRatio`/`codeSimilarityRatio` 等）与 bloat 因子未动（bloat 的弱断言探针不消费 provider 的 `assertionCount`）⇒ **无需 `scan --rebuild`**。可观察面是 `test --json` / `test --list` 的用例集合与 `p95.assertionCount`。
  - **仍不变的边界**：`testing.TB` 参数、`panic` 作为断言、Benchmark/Fuzz/Example 的收集 —— 三者都需要项目先确认口径（内部语言形状调研 §1.4/§4.4）。
- **Rust 断言宏族漏了 `assert_matches!` / `debug_assert_matches!`**：官方把它们与 `assert!`/`assert_eq!` 并列，并指出检查"值是否符合某个模式"时通常优于手写 `match` + `panic!`（依据见内部语言形状调研）。此前它们不在名单里 ⇒ 只写 `assert_matches!(…)` 的用例 `assertionCount` 记 0。**`matches!` 刻意不收**：它是返回 `bool` 的表达式宏、本身不产生失败信号（`assert!(matches!(…))` 由 `assert` 计入），把它算作断言会把普通布尔计算误判成验证。
  - **事实口径影响（实测）**：`assertionCount` 对"只用这两个宏"的用例 **0 → 1**；**不改变任何 finding** —— 缺失断言判定用的是 `bodyCalls`（宏调用本就计入"有验证意图"），所以 `missing_assertion` 的集合与改前逐条相同（特征化矩阵把这一点单独钉住）。`assertionCount` 运行时重算、不进 baseline；契约/阈值/版本无变化 ⇒ 无需 `scan --rebuild`。
- **Rust 测试文件识别不读 `Cargo.toml`**：此前 `supports()` 只按路径收 `tests` 目录下的 `.rs`。官方语义是 `#[test]` 为 libtest 唯一收集判据、**而"文件是否属于测试目标"由 Cargo 决定**：`tests/*.rs` 默认各自是集成测试目标；`[package] autotests = false` 时**不再自动**（此时只有 `[[test]]` 显式声明的目标会被构建）；`[[test]] path` 可声明**任意路径**的目标（省略 `path` 时按官方约定回退 `tests/<name>.rs`）；`[[test]] harness = false` 是**自定义 harness** 目标、不是 libtest，其 `#[test]` 不会被收集。现在按此读取最近的 `Cargo.toml`（按目录记忆化，与 `GoModuleResolver` 同构）。
  - **事实口径影响**：`autotests = false` 的项目里，未被声明的 `tests/*.rs` 不再纳入 provider 覆盖与 spans；`[[test]] path` 声明的、位于 `tests/` 之外的目标开始纳入；`harness = false` 目标一律排除。**清单不存在或解析不了 ⇒ 回退路径判据**（不据此排除任何文件，保持未解析清单项目的既有行为），该回退语义写在提供方注释里。
  - **契约/迁移**：**无身份变化** —— `supports()` 不是 scope 指纹的输入，`fileKind` 仍由 `file_kinds` 规则决定 ⇒ 无需 `scan --rebuild`；可观察面是 `test --json` / `test --list` 的测试文件集合与覆盖状态。
### Known Issues
- **`@openarch/core` 公开面收窄的仓库外影响未验证**：99 个被移除的导出在**仓库内**零消费者（AST 枚举 + 全仓词边界取证 + `tsc --noEmit` + 全量测试），但**已发布 npm 包的下游是否使用它们无法在仓库内验证**。若下游曾 import 这些内部符号，升级后会得到 `TS2305: Module has no exported member`（fail-closed，不会静默错值）。回访条件：出现第一个仓库外消费者报告时，按需把对应符号显式加回 `index.ts`（一次一行）。
- **`PLACEHOLDER_BODY` 不含 `待填写`**：`待填` 之后接 `写` 不匹配（长备选无锚）⇒ `## 教训\n待填写` 仍被判"已填写"。
- **围栏绕过（必填小节整体被成对闭合围栏包住 ⇒ `.some()` 空洞为真）**：已量化为 **0/480 个 md、0/26 篇真实记录** ⇒ 决定**维持不收紧**。表述为"**当前无可观测影响**"，**不是"已证明安全"**。

## [0.1.5] - 2026-08-23

协调服务 Task 生命周期健壮化。

### Added

- **本地协作测试脚本**：`scripts/local-collaboration-test.mjs`——同一项目两个 worktree + 两个脚本化 Agent，验证 scope → task submit → claim → 语义锁 → 编码提交 → evidence → complete 完整闭环，以及同文件抢锁 fail-closed。
- **Subagent 本地协作 Dogfood**：`scripts/setup-subagent-collab.mjs` + `scripts/cleanup-subagent-collab.mjs`——用两个真实 subagent 在临时 worktree 中并行完成 Core `getCalibration` 与 CLI `task show --json`，严格走协调服务闭环并验证完成。
- **语义锁等待/搁置验证**：`openarch coordination lease acquire --wait <seconds>`（客户端轮询等待，服务端仍快速失败）；`scripts/lock-wait-defer-test.mjs` 验证“等待释放后获取”和“先搁置做其他任务再重试”两种 Agent 行为。
- **语义锁 target 规范化**：语义锁 target 必须使用 `file:` / `function:` / `type:` 前缀标识；服务端统一小写前缀、将 `file:` 的 `\` 规范为 `/`，未加前缀的标识拒绝。
- **质量优化决策门**：`AGENTS.md` / `openarch SKILL.md` 固化“门禁修复自动执行、启发式优化由用户决策、结束回复固定输出质量优化清单”的开发流程，避免质量规范依赖用户反复提醒。
- **Windows 子进程统一入口**：`packages/core/src/infra/childProcess.ts` 提供 `execFileHidden` / `execHidden` / `spawnSyncHidden`，所有产品 Git/命令子进程默认 `windowsHide: true`，从根上防止终端闪烁回归。
- **Task 状态细化**：新增 `completed_local` 中间状态，最终 `completed` 必须从 `completed_local` 进入；两个完成状态都要求持有语义锁；`localHeadSHA`/`completedHeadSHA` 由 CLI 从 Git 确定性推导；新增 `task complete-local`、`task complete`（最终）、`task sync`。
- **Task 依赖协同**：proposal 支持 `dependsOn`；服务端在 claim/complete-local/complete 前校验依赖已完成并检测依赖环；新增 `task wait` 等待依赖完成。
- **Task 创建与任务规格**：新增 `openarch coordination task create <task-spec.json>`；proposal 支持 `goal/scope/constraints/verification/deliverable`；完成事件绑定 `leaseId` 执行实例。
- **Task 事件流 v2 哈希链**：`sequence` / `eventHash` / `prevEventHash`，canonical JSON 作为 eventHash 与签名 payload；读取与写入都强制校验链完整性、状态机合法性和 proposal 不可变性。
- **Task 详情端点**：`GET /v1/tasks/{repositoryId}/{serviceId}/{taskId}` 返回 proposal 摘要与完整 v2 事件链。
- **结构化错误契约**：Task 相关 HTTP 错误统一为 `{ error, code, retryable, requestId }`；错误码含 `invalid_request` / `not_found` / `state_conflict` / `scope_missing` / `service_unavailable`。
- **Task 写操作自动重试**：core `submitTask/claimTask/completeTask` 对 retryable 错误自动重试 3 次（指数退避 100ms/400ms），重试共享 `X-Request-Id`。
- **CLI `task show`** 与 claim/complete 的 `--proposal-sha256` 自动解析。
- **Task 签名多公钥验证**：支持 `--task-verify-key "<keyId>:<base64pub>"` 轮换验证旧事件。
- **服务端结构化日志**：`slog` JSON 输出到 stderr，Task 操作带 requestId。

### Changed

- Task 生命周期事件 schema 升级到 `2`，不再兼容 v1（协调服务仍为 dogfood，无正式使用者）。
- 服务端 Task 读取/列表遇到断链、坏签名或 proposal 与已验证 SHA 不一致时整体 fail-closed。
- **Evidence 校准 HTTP 接口统一结构化错误**：`{ error, code, retryable, requestId }`；坏输入返回 `invalid_request`，Git/权威写入或刷新失败返回 retryable `authority_unavailable`，校准投影读取失败返回 `service_unavailable`。
- Evidence/refresh/calibration 成功与失败都带 `X-Request-Id`，服务端用 slog JSON 记录证据摄取、仓库刷新与校准读取。
- **文档沉淀流程拆分**：`docs check --unfilled` 只验证模板完整性，`docs check --similar` 只计算相似候选；`docs record` 输出分别引导“填写后查未填项、提交前查相似候选”，避免在空模板上过早触发相似度。

### Fixed

- `POST /v1/evidence` 之前把 Git push/权威写入失败也映射成 HTTP 400；现在正确返回 503 `authority_unavailable` + `retryable=true`。
- 服务端权威写入在客户端断开/超时时不再中断：`AppendEvidence` / `AppendTaskLifecycle` 用 `context.WithoutCancel` 完成 add/commit，避免 docs-repo 留下 staged 未提交的服务端事件。
- Windows 终端闪烁：为 CLI/core 所有 git 子进程与开发脚本的 `spawnSync`/`execFileSync` 补齐 `windowsHide: true`，避免每次执行 `openarch`/`git` 时弹出控制台窗口。
- Windows 终端闪烁（服务端）：协调服务 Go git 子进程设置 `CREATE_NO_WINDOW`，避免无控制台服务触发 git 时反复弹出终端窗口。

## [0.1.4] - 2026-08-20

共享语义关系流水线、定义面信号与发布自动化版。

### Added

- **语义关系 provider 共享流水线**：Python/Go/Java/Rust 全部迁移到 `semanticRelationPipeline.ts`（Template Method + Strategy + Hooks），消除四个语言各写一套 LSP 生命周期/解析/报告的平行实现。
- **定义面事实/契约分层**：`definitionSurfaceFacts.ts` 复用 minhash/LSH 做定义面相似组召回；`definitionSurfaceContracts.ts` 提供通用契约判定；OpenArch 自身语义关系契约以项目脚本落地，core 不硬编码项目文件名。

### Changed

- CoordinationClient 收敛 `getJSON/postJSON/listCollection`，CLI `coordinationContext` 复用 core descriptor 校验，消除双写。
- 移除 OpenArch 特定 `parallel-language-facts` / `authority-bypass` 默认模板，改由项目脚本承载；避免通用发布模板过拟合。
- Go `LeaseCredential` 补齐 JSON tag，与 SessionCredential 对齐。

### Fixed

- 定义面契约初版误把 TypeScript compiler provider 当作 LSP provider；已收窄为 LSP 型 provider 并验证无回归。

## [0.1.3] - 2026-08-17

多语言语义关系与机器契约版。

### Added

- **semantic-relations.v1 多语言扩展**：在 TypeScript 基础上新增 Python/Pyright、Go/gopls、Java/JDT LS、Rust/rust-analyzer 四个 LSP provider；关系族扩展 `embeds`/`instantiates`，符号类扩展 `struct`/`enum`/`trait`，并在真实 Python/Go/Java/Rust workspace 校准直接关系事实。各 provider 保持有界直接静态范围与 partial/unavailable 边界。
- **gopls 常驻与通用 LSP daemon**：`openarch lsp <start|stop|status> [java|go]`；jdtls 转发 daemon 内核泛化为 `jdtls|gopls` 双 kind。Go semantic-relations 默认走 gopls 原生 `-remote=auto`（daemon 持有索引、`shutdown:"self"` 只回收 proxy）；`OPENARCH_GOPLS_DAEMON=off` 回退单次 `gopls serve` 供有界测试与校准。
- **机器契约目录**：`openarch contract --json` 汇总 context / test-governance / provider-list / rules-facts / docs-check 五份 JSON 契约的 id/version/status；外部插件按 schema 未知版本 fail-closed。
- **DSH 插件（DeepSeek Harness）**：v5.3 baseline 契约、`openarch_test` 治理工具、dashboard 与 `governance-state` 数据通道；多工作区独立缓存、会话 cwd 工具路由、root 白名单 fail-closed 与 cordis bundle patch。
- **治理闭环与冲击量重构**：Task/Debt/protected_paths 闭环、I_push 报告路由、localBurden 单一口径、D_MR 按 policy 校准、impactScale 与 sealed replay 对齐、无消费指标退役与小样本校准保护。
- **事实注册表与按需事实编排**：self-describing fact registry、`openarch rules facts`/`rules check --unused`；生命周期理由与 builtinConsumers；`string-key-calls-ts-js.v1` 语言限定 fact id（旧 id 保留兼容别名）；invocation-bindings 仅在被脚本显式 requires 时收集。
- **文档治理闭环**：`docs check --unfilled` 与相似候选处置（`docs decide`）；record 模板本地化并强化未填写检测。

### Changed

- 结构解析：构造器空体等 false positive 校准；scan hygiene、语言回退与测试适配器建议按 provider 边界呈现。
- staged-analysis 按阶段抽取 record collector，事实收集与呈现职责分离。

### Fixed

- Python/Pyright provider 补上 `initialize`/`initialized` 会话初始化，修复冷启动挂起；有候选时 complete 以 definition 请求全成功 + 仓库目标为准，空索引不再误判为零关系。
- Go 大 module 冷启动从单次 `gopls serve` 失败切换到常驻 daemon 后能返回事实，但 diagnostics/definition 预算未达时仍如实保持 partial。

## [0.1.2] - 2026-08-12

跨文件分析与跨环境可靠性版。

### Added

- **跨文件断言包装识别**：测试文件 import 的 helper 模块中，导出的函数体内含精确断言即视为断言包装（语法级、不依赖命名）——覆盖 TypeScript/JavaScript（vitest/node:test）、Java（JUnit）、Python（pytest）；同文件包装与跨文件包装统一判定。
- **`openarch test --list`**：列出全部已注册测试治理 provider（id + 说明），供 `test_governance.providers` 配置参考。

### Fixed

- **静态消费者候选路径不匹配**（`staticConsumerFilesFor`）：此前以绝对路径与 baseline 相对 imports 比较恒失败，LSP demand 跨包预热失效；现统一以相对路径为准，团队共享 baseline 跨机器一致。
- **模块解析负结果缓存**：Go/Python/Rust/TS 不再缓存"未找到项目标记"的失败结果——`go.mod`/`pyproject.toml`/`Cargo.toml`/`tsconfig` 在首次解析后出现不再永久解析失败。
- **预筛保守保留**：Go 同包引用（无 import 边）、多文件变更集、隐式依赖配置场景不再误剔除变更文件。
- **跨环境清理**：移除跟踪含本机绝对路径的个人/本地配置文件；toolchain 模板示例改用环境变量。

## [0.1.1] - 2026-08-12

体验反馈修复版（针对真实使用者项目实战反馈：node:test 项目断言识别、vue 项目语言覆盖）。

### Added

- **node:test 测试治理**：新增 `node-test` provider（`assert.*` 断言识别，消除 node:test 项目 missing-assertion 假阳性）与 `node --test` runner。
- **vue 语言支持**：`.vue` SFC 提取 `<script>`/`<script setup>` 按 js/ts 语义分析（行号对齐）；模板-only 组件正常入库；`languages: [vue]` 生效。
- **增量 scan 配置感知**：`.openarch/config.yml` 内容 hash 写入 baseline meta；配置变更时增量 scan 自动退化全量重建并提示。

### Fixed

- **冷启动 git 基线**：无 baseline 时从 git HEAD blob 重建 before 度量，`check` 在首次 clone 后即可计算冲击量（不再因缺 baseline 失败）；无 P95 分母时 D_MR 诚实报告"缺少可比 before"而非静默 0.00。
- **configSnapshotSha256 持久化**：baseline index schema 补字段，配置感知真正生效。
- **跨平台路径**：`pathe` 统一路径 key（Windows 盘符大小写导致的 inDegree 查表 miss）；toolchain 检测兼容 bun 单文件二进制。

## [0.1.0] - 2026-08-05

首个可发布版本。本地发行与二进制发行两条管线均已验收；registry 发布待后续决策。

### Added

- **治理命令族**：`init` / `context` / `scan` / `review` / `check` / `rules` / `docs` / `toolchains` 八个默认入口；`calibration` / `coordination` 两个高级入口（advanced，需显式启用）。
- **结构治理**：`scan` 建立完整 `BaselineSnapshot`（分片 + index 原子切换、异常回滚、`docs status` 可查询运行时状态）；`review` 输出架构门禁、Top-3 局部负担与 P95 基准、反模式 / 测试治理 finding。
- **变更治理**：`check` 统一变更验证（I_push / D_MR / ω_layer 权重、策略门禁、配置审计、测试治理、pre-commit hook）。
- **符号级变更面**：`check --semantic` 结合 git diff 与编译器 / LSP 证据计算 C_push 变更冲击面；Go/Rust/Python/Java 各语言 LSP 索引语义已按实测校准（`requiresDiagnosticReadiness`）。
- **LSP 可靠性**：结构化 `incompleteReferences` 信号、静态上界交叉校验（符号级 0 消费者但有静态上界时输出 `unconfirmed` 而非零值）、金标集成测试、可配置请求/索引超时；Windows `.bat` 启动与 env 大小写兜底。
- **隐式依赖引擎**：`rules scan` 反模式 / 隐式依赖 / 测试治理 finding；`change-surface.v1` 事实能力与示例规则 `no-unlinked-consumer`。
- **协调服务（预览）**：`coordination` 命令族（status / bootstrap / refresh / scope / evidence / task / claim / complete / lease）；未配置服务时 fail-closed（exit 3），本地 scan/check/review 永不依赖服务。
- **Skill 资产**：双语（zh/en）OpenArch Skill 树；`@openarch/plugin` 提供 `openarch-agent-install`（codex / cursor / opencode / claude 目标，staging+backup 原子安装）。
- **发布管线**：`release:local`（lint + test + 三包 pack + 装包验收）、`release:binary`（bun 单文件编译 + 资源 + 5 语言语法探测 + 双语 Skill 验收）。

### Changed

- 变更面指标语义收敛：`I_push` 衡量变更文件冲击（文件级 inDegree）；`C_push` 衡量被修改符号的消费者冲击面，且**不做文件级兑底**——符号级证据不可用时输出不可用而非误导值。

### Security

- 提交前置 pre-commit hook 强制语义证据；authority 边界禁止 `node:fs` / `node:child_process` 直入规则脚本。

[0.1.0]: https://github.com/openarch/openarch/releases/tag/v0.1.0
