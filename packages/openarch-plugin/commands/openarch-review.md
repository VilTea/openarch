---
name: openarch-review
description: |
  运行 openarch review 调查结构负担、项目规则 finding 与测试治理覆盖边界。
  使用 --evolution 查看重复共同变化候选。
---

## 流程

将 review 的指标视为待解释的证据，不将单个数值或某一类模块形态直接等同于腐化。

### Step 1: Scope check

确认是首次治理复盘，还是用户明确要求的 `--evolution` 历史协调面调查。

### Step 2: 跑 review

```bash
openarch review
```

### Step 3: 解读结果

报告命令实际输出的结构候选、规则 finding、测试覆盖边界和下一步；不得把未经校准的 finding 当成策略裁决。

### Step 4: Agent 自主判断

判断是否有值得沉淀的经验：已验证的项目决策、重复出现的失败模式，或在明确因果下得到验证的改进。先记录项目事实、上下文和证据；只有跨项目抽象仍成立时，才另行提炼通用模式。

### Step 5: 状态报告

- **DONE**——review 完成，无沉淀需求
- **DONE_WITH_CONCERNS**——review 完成，有可沉淀经验但 Agent 需要用户确认
