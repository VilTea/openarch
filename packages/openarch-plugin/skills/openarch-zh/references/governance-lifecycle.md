# 治理生命周期

> “一切实际工作者必须向下调查。”——《农村调查》

在初始化、持久化、hook、语义证据、DocumentStore 或经验记录前阅读本页。

## 初始化与持久化

`openarch context` 是只读项目事实调查；它不刷新 baseline、不创建证据、不选择工作流，也不授权策略变更。

`.openarch/config.yml` 中的 `governance.persistence` 是唯一权威：`tracked` 只自动暂存 hook 期间变化的**决策产物**（config.yml、anti-patterns/test-governance 规则、calibration 校准样本、implicit-deps 声明）；**运行产物**（baseline/history/audit/pending/scan-status/document-store.json）永不自动暂存，可由 `openarch scan` 幂等重建。`local` 只管理 `.git/info/exclude` 的 OpenArch 区块。两者的 hook 都验证证据和策略。

`presentation.locale` 同时选择人类、Agent 的默认 CLI 输出和由 `init --agent` 安装的 Skill 语言树（`zh` 或 `en`）。`--lang` 与 `OPENARCH_LANG` 只临时改变 CLI 展示，不改变 Skill、指标、策略、门禁或 JSON 合同。仅用显式 `init --agent <known>` 或 `--skill-dir <项目相对目录>` 安装 Skill；不得猜测 Agent 目录或写入用户全局目录。

## 策略配置实操

`structural_policies` 的规则字段是 **`condition`（CEL 表达式子集）**，不是 `n`；`mode` 决定是否裁决：`enforce` 评估规则并产生 WARN/BLOCK，`observe` 只覆盖 population 不评估规则（首次校准"试行"用 `enforce` + `warn` 级别即可，不自动建 BLOCK）。`scope.include/exclude` 用 minimatch，单文件可直接写字面路径：

```yaml
structural_policies:
  - id: ts-core
    mode: enforce
    languages: [typescript]
    scope:
      include: ["src/**"]
    rules_warn:
      - name: max-func-branch
        condition: "max_func_branch > 12"
```

**每个生产文件必须恰好命中一个 profile**（零命中或多命中都是 `UNAVAILABLE`，不会借用邻近语言或默认阈值）；多语言/多服务项目须显式声明全部 population。阈值按**本项目 baseline 的 P95** 校准，不是跨项目可复制的默认值；`review` 的 P95/Top-3 是校准输入。

**配置变更后必须 `openarch scan --rebuild`**：增量 scan 按文件内容 `SHA-256` 短路，`structural_policies`/`file_kinds`/`analysisScope` 变化不会触发重算——配置改了但 gate 仍报 `policy_calibration_missing` 或沿用旧 scope 时，先 `scan --rebuild` 再排查其他原因。profile id/scope 变更也会使旧校准失效，同样需要重建。

`--docs-scope` 参数格式是 **`<scopeId>=<相对路径>`**（如 `fund-claude-agent=agent`）：等号前是 scopeId，等号后是文档库内相对路径；不带 `=` 会校验失败。

`init` 不会自动探测 TypeScript/JavaScript（它们无项目指示文件）；`languages: []` 表示"尚无已支持语言"，此时 `scan` 完成 0 文件。TS/JS 项目需手动配置 `languages: [typescript]` 后重新 `scan`。

## 基线、证据与 hook

`scan` 发布结构基线；完整基线代只由 `scan` 原子更新。`check --worktree` 与 `check --staged` 产生可替换的 `pending` 候选指标覆盖层和语义证据，不改写规范基线分片。需要当前项目状态的 `gate`、`review`、图重建读取“完整基线代 + 仍与源码 `SHA-256` 匹配的 `pending` 覆盖层”；需要稳定总体的 `scan`/演化分析读取完整基线代。提交前先用暂存候选投影完成门禁，再需要路径和 `SHA-256` 完全匹配的证据才能封存历史；完整 `scan` 发布后清掉旧覆盖层。

原子发布不等于基线代永远完整：读者必须验证索引、分片集合、路径计数和内容身份。分片缺失、损坏、代矛盾或历史标记不可解析时，报告“不可用/部分”状态，不得手工删文件或把缺失事实解释为干净。规范基线的恢复和修复属于带锁的完整 `scan` 或显式恢复流程，`pre-commit` 只验证候选并封存匹配证据。

结构事实与测试 provider 事实分轨后，旧版本中把 `testMetrics` 纳入快照身份的已知 baseline 只读兼容一次；下一次完整 `scan` 会重发布新的结构身份。其它身份不一致仍是不可用，不得通过删除分片或降低校验绕过。

中断后的 `baseline.staging-*` / `baseline.backup-*` 只作为可解释的临时 generation 事实：`context --json` 会报告 active、可读代和每个临时代的合法性与年龄，读取不会移动或删除它们。`status` 会把超时的 `scan-status.json` running 标记显示为 stale；这只是中断信号，不是失败或 clean，后续完整 `scan` 才能在写锁内恢复或发布。

封存后，历史适配器按 `governance.history.raw_window_days` 保留近期原始证据，并将更早的 CRL 贡献压缩为数学等价的检查点；它不按年龄丢弃趋势。检查点与保留记录的重放等价于完整封存历史，原始文件从工作树清理后仍由 Git 审计。`_compaction.v1.json` 是中断恢复的逻辑发布点：读取时不会双计，下一次成功运行会完成物理清理。默认窗口为 180 天；高频项目可在配置中设为正整数天数。

### 历史损坏恢复

旧版本写出的损坏历史记录、`_checkpoint.v1.json` 或 `_compaction.v1.json`，在升级后会使 `readAllHistory` fail-closed：读取不会跳过单条记录、降级为空历史或自动覆盖原文件。遇到这类错误时按以下顺序恢复：

1. 先复制整个 `.openarch/history/` 到项目外的恢复目录，保留报错中的文件路径、提交号和时间；不要先删除或重命名坏文件来获得 `PASS`。
2. `tracked` 项目用 `git log -- .openarch/history` 找到最后一个已知良好提交，再用 `git restore --source=<known-good-commit> -- .openarch/history/<file>` 恢复受影响文件。检查点、压缩标记及其列出的原始记录必须按同一发布集合核对，不能只恢复其中一个标记。
3. `local` 项目从外部备份恢复；若没有可验证副本，不要手工编造 JSON 或把坏记录静默丢弃。历史 CRL 此时只能标记为 `UNAVAILABLE`，不能解释为零或 clean。
4. 恢复后重新运行 `openarch review` 或 `openarch check` 验证历史可读性。若只需要重建结构基线，可以另行运行 `openarch scan`；`scan` 不会重建缺失的历史 CRL。

不得手工删除 `pending evidence`、基线分片、历史或审计输出来获得干净提交。相同输入的重复检查必须幂等；修改 hook 或例外前调查内容身份、时间、`adapter` 合同、可达性和协调过程。

不论持久化模式，`pending/`、`scan-status.json` 和锁文件都是可替换运行态；`init` 在项目 `.openarch/.gitignore` 中维护这一最小忽略集。因此嵌套项目不依赖父 Git root 的 ignore，而 baseline、history、audit 等可审计产物仍遵守 `persistence`。

## 文档与经验

编辑前先解析 DocumentStore。项目本地库是 `docs/openarch`；共享库需要显式 `scope-id`，且只能读取绑定的 `scopeRoot`。缺绑定是 `UNAVAILABLE`，不是扫描相邻项目的许可。

若当前项目有自己的能力资产，只有该项目的公共能力、工作流、provider 或脚本合同变化时才更新该项目资产，并运行 `openarch docs check --changed <path>`。接入项目不维护已安装的 OpenArch Skill、runtime/plugin 镜像或产品能力清单；发现产品内容过期时向上游报告，不在接入项目内修改。只有明确维护产品发行的仓库才按其发行流程更新这些来源。使用 `docs record --category patterns|anti_patterns|decisions` 前先完成可验证复盘；文档写完后才检查相似度。类别和写作要求见 [record-guide.md](../record-guide.md)。
