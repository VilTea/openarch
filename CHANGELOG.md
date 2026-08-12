# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
