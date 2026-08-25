# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（待补充）

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
