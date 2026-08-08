# openarch lsp daemon —— 多 harness hook 接线（2026-08-07）

`openarch lsp start/stop/status` 管理 jdtls 转发 daemon（Java 符号级分析的
长驻 LSP 进程）。每个 harness（Claude Code / Codex / opencode / Reasonix）
通过各自的 hook 机制在会话生命周期调用同一组命令。

## 幂等与安全设计

- **start 幂等**：daemon 已运行（状态文件 pid 存活）→ 复用，不重复启动；
  owner 去重追加（多 harness 各记一次）。
- **stop 引用计数**：状态文件记录 `owners`（harness 名，环境检测
  reasonix/claude/codex/opencode/manual）——`lsp stop` 只移除当前调用者，
  **owners 清空才杀 daemon**；一个 harness 的会话结束不会杀掉另一个还在
  使用的 daemon。无 owner 的 stop（手动 `openarch lsp stop`）保持直接杀。
- **项目语言门禁**：`lsp start` 检测项目语言（`readProjectLanguages`）——
  jdtls **绝不在非 java 项目启动**（hook 对每个会话触发，非 java 项目输出
  检测到的语言并跳过，exit 0）。
- **语言配置提醒**：项目已初始化（`.openarch/config.yml` 存在）但未显式声明
  `languages` 时，`lsp start` 打印提醒（"建议在 config.yml 配置 languages 以
  稳定 LSP 预热行为"）后继续——hook 场景该提醒是给 Agent 的引导信号，不阻塞。
- **工具链缺失 fail-soft**：项目使用 java 但未配置 jdtls 工具链时——
  harness（SessionStart hook）环境打印提示并跳过（exit 0，不中断会话）；
  手动执行保持 fail-closed（exit 3 明确报错）。
- **崩溃兜底**：harness 异常退出（SessionEnd 未跑）→ daemon 残留——下次
  `lsp start` 检测 pid 存活直接复用；手动 `openarch lsp stop` 清理。

## 各 harness 配置

### Claude Code / Reasonix（.claude/settings.json）

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "openarch lsp start" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "openarch lsp stop" }] }
    ]
  }
}
```

### Codex（~/.codex/config.toml 或 项目 .codex/config.toml）

```toml
[hooks]
SessionStart = [
  { hooks = [{ type = "command", command = "openarch lsp start" }] }
]
SessionEnd = [
  { hooks = [{ type = "command", command = "openarch lsp stop" }] }
]
```

配置层级（后加载覆盖前）：`~/.codex/config.toml`（用户）→ 项目树向上找
`./.codex/config.toml`（不可信目录禁用）。

### opencode（插件——config 无生命周期 hook）

opencode 的 hooks 是插件 API（`event` hook），配置层没有 SessionStart 命令。
在 `.opencode/plugins/`（或 `~/.config/opencode/plugins/`）放一个插件：

```ts
// .opencode/plugins/openarch-lsp.ts
import type { Plugin } from "opencode"
import { spawn } from "node:child_process"

const run = (args: string[]) => {
  const child = spawn("openarch", ["lsp", ...args], { detached: true, stdio: "ignore" })
  child.unref()
}

export const OpenArchLspPlugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.payload?.type === "session.start") run(["start"])
    if (event.payload?.type === "session.idle" && event.payload?.data?.reason === "closed") run(["stop"])
  },
})
```

（事件名 `session.start`/`session.idle` 按 opencode 版本 GlobalBus payload 调整；
也可用 agent/command 的模板在会话开始时显式调用。）

## 验证

```bash
openarch lsp status    # 运行中：pid/port/startedAt；未运行：提示
openarch lsp start     # 幂等；非 java 项目跳过
openarch lsp stop      # 引用计数；其他 harness 持有时仅移除当前 owner
```
