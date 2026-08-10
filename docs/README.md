# OpenArch 框架 — 指导性文档索引

本目录存放 **正式开发启动前** 的方法论与实施指导，不含可执行代码。

## 活跃文档

| 文档 | 用途 |
|------|------|
| [phase1-spark-guide.md](./phase1-spark-guide.md) | 星火燎原：根据地选择、三步路线图、开发前准备清单（含 init/hook/MR 仪式） |
| [demo-scenario-spec.md](./demo-scenario-spec.md) | Phase 1 验证场景规格（CRL「温水煮青蛙」demo） |
| [protracted-strategy-assessment.md](./protracted-strategy-assessment.md) | 持久战略：阶段判断、转折点、检查点（四阶段含 Phase 4） |
| [../design.md](../design.md) | 完整设计 v5.2（v5.0 愿景 + v5.1 工程评审合并） |

## 归档文档

| 文档 | 用途 |
|------|------|
| [archive/design2-v5.0-vision.md](./archive/design2-v5.0-vision.md) | v5.0 愿景版（保护路径 / Git 协议 / Phase 4 / Skill 集成）。已并入 v5.2，保留作历史参考。 |

**当前状态**：实现已完成（0.1.0 可发布）——治理命令族、符号级变更面、LSP 语义校准与发布管线均已落地；本文档保留为文档索引与命名/演进约定。

## 命名约定

| 项 | 名称 | 说明 |
|----|------|------|
| 项目/框架 | **OpenArch** | 产品名 |
| CLI 命令 | **`openarch`** | 避免与 Unix `arch`（机器架构）冲突 |
| 数据目录 | **`.openarch/`** | 配置、baseline、history、hypothesis、wisdom、meetings，提交 Git |
| npm 包（待定） | `openarch` 或 `@openarch/cli` | 见 phase1-spark-guide §5.2 |

## 版本演进

| 版本 | 状态 | 说明 |
|------|------|------|
| v5.0 | 归档（[archive/](./archive/)） | 愿景版：保护路径、Git 协议、Phase 4、Skill 集成 |
| v5.1 | 归档（已并入） | 工程评审修订：指标职责表、packages 结构、性能约束、不做清单 |
| **v5.2** | **当前**（[../design.md](../design.md)） | v5.0 + v5.1 合并版 |
