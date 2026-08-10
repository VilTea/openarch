# 安装 OpenArch（源码构建）

英文说明见 [INSTALL.md](./INSTALL.md)。

OpenArch 安装持久 `openarch` CLI 以治理项目。项目级 Skill 一律由 CLI 安装，才能使用该项目的 `presentation.locale`。

本文档只覆盖**源码构建路径**：克隆仓库、用 bun 编译单文件二进制、安装并初始化受治理项目。npm 仓库发行暂缓（发行形态跟踪见 `docs/plans/2026-08-08-typescript7-migration.md`）。

## 前置条件

- [bun](https://bun.sh)（`bun build --compile` 编译单文件）
- Node.js 20 或更高
- `pnpm` 9.x（仓库锁定 `packageManager: pnpm@9.0.0`；`corepack enable` 会从 `package.json` 激活）
- Git

项目命令都在受治理仓库根目录执行。

## 1. 编译二进制

在 OpenArch 源码仓中：

```bash
corepack enable
pnpm install
pnpm release:binary
```

`pnpm release:binary` 用 `bun build --compile` 把 CLI 编译为单文件可执行程序（运行时依赖——包括符号级分析所用的 TypeScript 编译器 API——都打进二进制，安装时无需 `node_modules` 依赖树）。产物在 `artifacts/binary/openarch-<平台>-<架构>/`：

- `openarch(.exe)` — 编译后的可执行文件
- `resources/` — 打包的 tree-sitter WASM 语法、脚本资产与 Skill

脚本会在一次性临时项目里探测构建产物：`--help`、`rules skeleton`、各语言 `scan`（typescript/go/rust/python）与 `zh`/`en` Agent 的 Skill 安装——在真正安装前验证二进制能加载打包语法与资产。

## 2. 安装二进制

保持构建目录完整（`openarch(.exe)` 与同级 `resources/` 在一起）。若要让全部本地项目和 Agent 会话使用持久命令：

```bash
pnpm release:local-command
```

该命令构建并验证 bundle，再原子安装到 `%LOCALAPPDATA%\OpenArch\bin` 并写入用户 `PATH`。首次安装后重新打开终端或 Agent 会话，然后验证：

```bash
openarch --version
```

手动安装：把 `artifacts/binary/openarch-<平台>-<架构>/` 复制到任意位置（可执行文件必须与 `resources/` 同目录），再把它加入 `PATH`。

## 3. 初始化受治理项目

```bash
# 把 claude 换成你的 Agent：claude / codex / cursor / opencode / reasonix
openarch init --agent claude
openarch context
```

`--agent` 可选 `claude`、`codex`、`cursor`、`opencode`、`reasonix`。命令只写入所选项目目录，例如 `.claude/skills/openarch/`；它读取 `.openarch/config.yml` 的 `presentation.locale` 并安装对应的 `zh` 或 `en` Skill 树。更新时原子替换整个旧 OpenArch Skill 目录，清除退役文件。缺失或非法配置稳定回退 `en`；`--lang` 只改变本次 CLI 输出，绝不改变已安装的 Skill。

## 3.1 Agent Skill 安装（Agent 必读）

本文档面向 Agent。CLI 安装完成后，**你需要**把 OpenArch Skill 装进自己的工作环境，让治理方法论在本项目可用：

1. **为自己的 harness 安装 Skill** —— 用你的目标执行 `init`，Skill 会落入你的项目级 skills 目录：

   | harness | 命令 | Skill 位置 |
   |---------|------|-----------|
   | Claude | `openarch init --agent claude` | `.claude/skills/openarch/` |
   | Codex | `openarch init --agent codex` | `.codex/skills/openarch/` |
   | Cursor | `openarch init --agent cursor` | `.cursor/skills/openarch/` |
   | OpenCode | `openarch init --agent opencode` | `.opencode/skills/openarch/` |
   | Reasonix | `openarch init --agent reasonix` | `.reasonix/skills/openarch/` |

   命令只写入所选项目目录，读取 `presentation.locale` 并安装匹配的 `zh`/`en` Skill 树。OpenArch 升级后重跑以刷新 Skill（退役文件被原子清除）。

2. **验证 Skill 已就位** —— 依赖它之前，确认你的 harness skills 目录存在且含 `SKILL.md`：

   ```bash
   ls .claude/skills/openarch/SKILL.md    # 换成你的目标路径
   ```

   若缺失，重跑对应的 `init --agent` 命令并阅读任何错误输出。

3. **工作中遵循 Skill** —— 已安装的 Skill 就是你的行动手册：治理工作前先读它，运行 `openarch context` 建立项目事实，再按路由选择 `scan` / `review` / `check` / `rules` / `docs`。`check` 输出是全量信号面——即使 Verdict PASS 也要读 WARN、TEST_BLOAT、反模式 finding 与信号；`PARTIAL`/`UNAVAILABLE` 是事实边界，不是 clean。

其它兼容 Agent 使用明确的项目相对目录：

```bash
openarch init --skill-dir .my-agent/skills
```

需要代码仓 pre-commit hook 时，初始化成功后再执行：

```bash
openarch init --install-hook
```

## 4. 治理持久化

`.openarch/config.yml` 的 `governance.persistence` 是运行产物是否进入 Git 的唯一权威。新项目默认 `tracked`。个人项目使用：

```bash
openarch init --mode personal --install-hook
```

该命令写入 `governance.persistence: local`，并只在 `.git/info/exclude` 管理 OpenArch 自己的 `.openarch/` 区块。hook 仍封存语义证据并执行已配置门禁，但不暂存生成的 baseline、history 或审计产物；它不会改变 DocumentStore，也绝不自动移除已跟踪路径。

团队审查模式使用 `openarch init --mode team --install-hook`，或设置 `governance.persistence: tracked`。本地运行状态可由 `openarch scan` 重建。

## 5. 外部工具链

外部编译器和语言服务器是本机事实，不是项目依赖。先查看当前项目 languages 所需的工具：

```bash
openarch toolchains
```

`openarch update` 是只读版本检查：对比已安装版本与远端 release 分支的最新版本，打印更新步骤；绝不自动安装。升级后重跑 `openarch init --agent <harness>` 刷新已安装的 Skill 树（退役文件被原子清除）。

创建用户级配置，再按需填写外部可执行文件的绝对路径：

```bash
openarch init --toolchains user
```

当前 checkout 需要不同路径时使用 `openarch init --toolchains project`。它创建 `.openarch/toolchains.local.yml`，并只加入本机 Git exclude，不会提交机器路径。CI 仍可使用 `OPENARCH_<TOOL_ID>_PATH`，其优先级高于两个文件。已安装的 OpenArch Skill 会在发现不可用时，按 Python、Go、Rust、Java 的项目语言读取对应配置说明。

## 6. 验证

初始化后运行 `openarch context` 获取只读项目事实。实现过程中使用 `openarch check --worktree --report`；暂存后使用 `openarch check --staged --report`。公开命令为 `openarch init`、`context`、`scan`、`review`、`check`、`rules`、`docs`、`toolchains`（`coordination`、`lsp`、`calibration`、`anti-patterns` 为 advanced 可见）。
