# OpenArch 框架 — 指导性文档索引

本目录存放 **正式开发启动前** 的方法论与实施指导，不含可执行代码。

## 活跃文档

| 文档 | 用途 |
|------|------|
| [phase1-spark-guide.md](./phase1-spark-guide.md) | 星火燎原：根据地选择、三步路线图、开发前准备清单（含 init/hook/MR 仪式） |
| [demo-scenario-spec.md](./demo-scenario-spec.md) | Phase 1 验证场景规格（CRL「温水煮青蛙」demo） |
| [protracted-strategy-assessment.md](./protracted-strategy-assessment.md) | 持久战略：阶段判断、转折点、检查点（四阶段含 Phase 4） |
| [internal/design.md](./internal/design.md) | 完整设计 v5.3 living spec（v5.2 定稿 + 2026-08 dogfood 修订：cut/revised/active 分类） |

## 归档文档

| 文档 | 用途 |
|------|------|
| [archive/design2-v5.0-vision.md](./archive/design2-v5.0-vision.md) | v5.0 愿景版（保护路径 / Git 协议 / Phase 4 / Skill 集成）。已并入 v5.2，保留作历史参考。 |

**当前状态**：0.1.2 已发布——防腐主线命令族、符号级变更面、LSP 语义校准、发布管线与 Go 协调服务 M0（Task verified/claimed/completed、lease/session/SSE）均已落地；剩余未实现设计按 v5.3 §1.6 的 cut/revised/active 分类执行。

## 命名约定

| 项 | 名称 | 说明 |
|----|------|------|
| 项目/框架 | **OpenArch** | 产品名 |
| CLI 命令 | **`openarch`** | 避免与 Unix `arch`（机器架构）冲突 |
| 数据目录 | **`.openarch/`** | 配置、baseline、history、hypothesis、wisdom、meetings，提交 Git |
| npm 包 | **`@openarch/cli`**（core：`@openarch/core`，插件：`@openarch/plugin`） | npm registry 发行暂缓，本地 tarball 已可用（`pnpm release:local`） |

## 版本演进

| 版本 | 状态 | 说明 |
|------|------|------|
| v5.0 | 归档（[internal/archive/](./internal/archive/)） | 愿景版：保护路径、Git 协议、Phase 4、Skill 集成 |
| v5.1 | 归档（已并入） | 工程评审修订：指标职责表、packages 结构、性能约束、不做清单 |
| v5.2 | 定稿后被 v5.3 覆盖（[internal/design.md](./internal/design.md)） | v5.0 + v5.1 合并版 |
| **v5.3** | **当前 living spec**（[internal/design.md](./internal/design.md)） | 2026-08 dogfood 修订：未实现设计的 cut/revised/active 分类 |
