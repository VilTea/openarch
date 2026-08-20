# 理论-功能地图

> 本页是**导航页**，不是新规则，也不是内容副本。权威内容仍在 `SKILL.md` 与各 reference 中；本页只回答“功能对应哪里、方法论对应什么理论”。

## 1. 功能面：命令 → Skill 内容

| 功能 | Skill 入口 | 参考 |
|---|---|---|
| `init` | 最小闭环第 1/2 步 | [governance-lifecycle.md](./governance-lifecycle.md) |
| `context` | 调查与判断 | [agent-workflow.md](./agent-workflow.md) |
| `contract` | 认知点原则、fail-closed | [project-defenses.md](./project-defenses.md) |
| `scan` | 指标罗盘、证据边界 | [metrics-and-evidence.md](./metrics-and-evidence.md) |
| `review` | 抓主要矛盾、报告消费纪律 | [project-defenses.md](./project-defenses.md)、[collaboration-and-evolution.md](./collaboration-and-evolution.md) |
| `check` | 最小闭环、决策与门禁 | [metrics-and-evidence.md](./metrics-and-evidence.md)、[agent-workflow.md](./agent-workflow.md) |
| `rules` | 认知点净减少、项目防线 | [script-authoring.md](./script-authoring.md)、[project-defenses.md](./project-defenses.md) |
| `docs` | 经验闭环、DocumentStore | [governance-lifecycle.md](./governance-lifecycle.md)、[record-guide.md](../record-guide.md) |
| `test` | 测试入口显式化 | [language-and-assurance.md](./language-and-assurance.md) |
| `toolchains` / `lsp` | 证据边界、`PARTIAL/UNAVAILABLE` | [language-and-assurance.md](./language-and-assurance.md) |
| `update` | 治理生命周期升级 | [governance-lifecycle.md](./governance-lifecycle.md) |
| `coordination` | 协作与演化、显式边界 | [collaboration-and-evolution.md](./collaboration-and-evolution.md) |
| `anti-patterns` / `calibration` | 最小防线、只报告不伪造 | [project-defenses.md](./project-defenses.md)、[metrics-and-evidence.md](./metrics-and-evidence.md) |

## 2. 理论面：方法论 → 理论 → 功能落点

| 方法论 | 理论/原文 | 功能落点 |
|---|---|---|
| 实事求是 | 《反对本本主义》《改造我们的学习》 | `context`、`scan`、`check`、`review` |
| 保留不确定性 | 香农信息量、fail-closed | `contract`、`check`、`review` |
| 认知点原则 | 认知负荷理论、SSOT、DDD 统一语言 | `contract`、`rules`、`docs`、`test` |
| 抓主要矛盾 | 《矛盾论》 | `review`、`rules`、校准 |
| 集中优势兵力 | 毛泽东军事思想 | `rules scan`、最小防线 |
| 具体问题具体分析 | 《矛盾论》 | `language-and-assurance`、`review --evolution` |
| 一般号召与个别指导 | 《关于领导方法的若干问题》 | `rules skeleton`、fixture |
| 实践、认识、再实践 | 《实践论》 | `check`、`docs record` |
| 持久战 | 《论持久战》 | `project-defenses`、CI/hook |
| 统一语言 / SSOT | 信息论、DDD | `contract`、schema、`rules facts` |

## 3. 使用规则

- 本页只做导航，不写指标公式、命令帮助或方法论解释。
- 新增命令/方法论时，先更新本页，再决定是否改 `SKILL.md` 或 reference。
- 内容冲突时以 `SKILL.md` 与对应 reference 为准，本页不构成权威。