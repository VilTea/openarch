<div align="center">

# OpenArch

**给你的 AI 代理一条防腐防线——代码漂移时，它还能低成本地重新挖好。**

面向 AI 辅助团队的本地优先治理框架：承认软件腐化不可避免，并给每个代理提供一条轻量、可随时重建的防线——以信息论为度量根基、以确定性本地证据为验证、以代理真正会读的行动手册为承载体。

`openarch` — 一个命令，五语言符号级分析，18 条内置规则，零 LSP 门禁，全链路可复现。

*English: [README.md](./README.md)*

</div>

---

## 前提：腐化不是一次能修完的 bug，而是一股需要持续抵抗的力

每一次改动单独看都"合理"。复杂度悄悄累积。三月合理的规则，六月就被绕过。这不是质量疏忽——这是**熵在做它该做的事**。放任不管，任何系统都会滑向无序。

多数工具把它当成一次性问题：跑一次 linter、设一道质量门禁、然后完事。这正是它们失效的原因——门禁老化、规则僵化、下一个代理绕着它走。

OpenArch 从相反的假设出发——**腐化无法避免，所以防线必须便宜到能反复重建**。不是一堵只建一次的高墙，而是一条可以随时挖、会失守、也能在任何地方重新挖好的战壕。重建治理的成本必须低到让你永远找不到借口不重建。

### "防腐"在这里指什么

| 你会遇到的腐化 | OpenArch 如何抵抗 |
|----------------|-------------------|
| **局部负担膨胀** —— 一个函数悄悄变成 god-function | CRL 局部负担度量，语言级 P95 校准（零硬编码阈值） |
| **权限边界泄漏** —— 某模块伸进别人的受保护路径 | 静态 import 分析强制的权限规则，fail-closed |
| **样板增殖** —— 测试把同一套 setup 抄八遍 | TEST_BLOAT + minhash 相似度检测 |
| **冲击不可见** —— 一次签名变更打断了你没看到的消费者 | I_push / C_push 变更冲击 + 符号级消费者确认 |
| **经验流失** —— 同一个坑每个周期都绊倒同一个代理 | 可复用规则脚本 + 代理工作前会读的 Skill 行动手册 |

## 理论：状态是基线，变化是信号

> “信息是用来减少不确定性的东西。” —— 克劳德·香农《通信的数学原理》（1948）

系统当前状态告诉你身在何处；**它正在如何变化**才告诉你该盯什么。OpenArch 运行在两条互补的轨道上——状态快照与变化增量：

- **状态是基线，变化是信号** — `openarch scan` 建立状态基线（CRL、结构、TEST_BLOAT）；`openarch check` 度量相对基线的变化（I_push、C_push、D_MR、校准漂移）。判断基于变化——但变化需要状态作参照才有意义。两者互补，不互斥。
- **对数压缩** — 原始计数通过对数函数压缩为信号强度，没有任何单一极端值能主导判断。
- **保留不确定性** — 事实按身份、来源、scope、生命周期分类；`PARTIAL` / `UNAVAILABLE` 是事实边界，绝不装扮成 clean。证据不足的规则保持 unavailable，不伪造通过。
- **零硬编码阈值** — 每个阈值都按项目自身观测分布校准（语言级 P95），让防线贴合项目而非套用一个普适假设。

## 一条代理能重新挖好的防线——因为它是行动手册

OpenArch 交给代理的不是规则清单，而是一个**Skill**——代理真正会读的方法论——安装进代理自己的工作区：

```bash
openarch init --agent claude   # claude | codex | cursor | opencode | reasonix
```

Skill 携带工作纪律：*判断前先跑 `openarch context`、遵循路由表、把 `check` 输出当全量信号面、绝不把"没有裁决"当成"干净"。* 它横跨每个代理平台——一套行动手册，五种 harness。

这就是**门禁**（一堵会老化的墙）与**能力**（前线移动时代理能重新挖好的战壕）的区别。代码漂移时，你不必等新门禁——代理已经知道如何重新建立防线。

## 确定性、本地、可审计——出于设计

主流 AI 代码工具是云端审查 bot：代码离开你的楼，裁决来自你看不见的 LLM。OpenArch 从构造上正相反：

- **门禁里没有 LLM。** 结构分析、变更冲击、规则执行都是确定性的——编译器/LSP provider 与 tree-sitter，本地运行，任何机器可复现。
- **本地优先。** 工具链路径是本机事实，永不提交。`openarch scan` 从源码重建一切产物。
- **Fail-closed。** 证据缺失或含糊时，答案是 `PARTIAL` / `UNAVAILABLE`，绝不是自信的猜测。
- **五语言符号级。** TypeScript（编译器 provider，精确）、Python（pyright）、Rust（rust-analyzer）、Java（jdtls）、Go（静态上界，fail-closed）——精确到已确认的消费者。

## 快速开始

> Agent 与用户：请阅读 [INSTALL.zh-CN.md](./INSTALL.zh-CN.md) 完成 bun 编译二进制的构建与 `openarch` CLI 安装。英文安装指南见 [INSTALL.md](./INSTALL.md)。

CLI 安装完成后：

```bash
# 初始化受治理项目（--agent 可选：claude / codex / cursor / opencode / reasonix）
openarch init --agent claude
openarch context

# 建立首轮基线
openarch scan
openarch review

# 每次变更后验证
openarch check --worktree --report    # 实现中
openarch check --staged --report      # 暂存后
```

## 让 AI 代理参与治理

### 项目级 Skill（推荐）

```bash
openarch init --agent claude
```

写入 `.claude/skills/openarch/`，自动匹配项目语言（`zh`/`en`），原子更新。支持 `claude`、`codex`、`cursor`、`opencode`、`reasonix`。

### 用户级 Skill（插件）

[OpenArch Agent Plugin](./packages/openarch-plugin/README.md) 提供静态宿主可发现 Skill（`openarch-zh`/`openarch-en`）与用户级安装器（`openarch-agent-install`）。

### 代理工作流（Skill 内嵌纪律）

- 先 `openarch context`，再选择 scan / review / check / rules / docs
- `check` 是**全量信号面**：Verdict 不是完成判据，PASS 也要读 WARN、TEST_BLOAT、finding 与信号
- `PARTIAL` / `UNAVAILABLE` 是事实边界——处理它们或显式记录，绝不伪造 clean

## 命令行

```text
公开命令：init · context · scan · review · check · rules · docs · toolchains
高级命令：coordination · lsp · calibration · anti-patterns
```

每个命令的详细用法：`openarch <command> --help`。

## 多语言与工具链

| 语言 | 符号级维度 |
|------|-----------|
| TypeScript | 编译器 provider（精确） |
| Python | pyright 跨文件可靠 |
| Rust | rust-analyzer + crate:: 提取 |
| Java | jdtls 转发 daemon |
| Go | 静态上界 + file-heavy 兜底（fail-closed） |

外部工具链是**本机事实**：`openarch toolchains` 查看，`openarch init --toolchains user` 配置。

## 项目结构

```text
packages/core/            核心：扫描、指标、反模式引擎、符号级分析、脚本运行时
packages/cli/             CLI 命令面
packages/openarch-plugin/ 宿主 Skill 资产 + 用户级 Skill 安装器
services/coordination/    Go 协作服务（task/lease/evidence，可选远端）
docs/                     用户向文档（安装、命令参考、契约）
```

## 文档

- [安装指南（源码构建，可复现）](./INSTALL.zh-CN.md)
- [English Install Guide](./INSTALL.md)
- [协作编排命令](./docs/coordination-cli.md)
- [LSP 预热与多 harness hook](./docs/lsp-daemon-hooks.md)
- [扩展脚本契约](./docs/extension-script-contract.md)

## License

[MIT](./LICENSE)

Copyright (c) 2026 OpenArch Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
