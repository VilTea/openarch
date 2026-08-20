# OpenArch DSH 插件（`dsh/`）

把 OpenArch 的本地治理事实带进 DeepSeek Harness：**模型工具层**（赋能）、**治理信号层**（常驻提示）、**可视化层**（状态条 + 看板）。

设计原则沿用 OpenArch 本体：

- **只报告事实，不替用户裁决** —— PASS 只表示已声明策略未触发；PARTIAL/UNAVAILABLE 是事实边界。
- **fail-closed** —— 任何一节读不到就显式缺失（`null` + error），绝不伪装成 clean。
- **有界输出** —— 所有集合有上限（history 20 条 / Top-N 12 个 / 分片采样 4000），状态快照永远可 JSON 化。

## 目录结构

```text
dsh/
  host/
    openarch-state.mjs         治理状态读取器（纯 Node 逻辑，无依赖，可单测）
    openarch-test-cache.mjs    测试治理结果本地缓存（.openarch/dsh-test-governance.json）
    openarch-contract.mjs      JSON 契约面：从 dsh-config.schema.json 推导配置白名单（strictConfig）
    openarch-tools.mjs         模型工具层入口（装配 + 客户端数据通道 RPC/HTTP）
    openarch-tools-run.mjs     执行层：子进程/后台任务生产者/verdict 映射/接缝
    openarch-tools-render.mjs  渲染层：canonical JSON → 模型文本投影
    openarch-tools-context.mjs openarch_context 工具构造器
    openarch-tools-gate.mjs    openarch_check / openarch_review 工具构造器
    openarch-tools-scan.mjs    openarch_scan 工具构造器（后台任务优先）
    openarch-signals.mjs       systemPrompt 治理简报（order 90，每步装配时求值）
  client/
    openarch-dashboard.mjs     状态条（composer.dock）+ 看板（shell.overlay）
  schema/                      JSON Schema（插件开发合同，随包发布）
    dsh-plugin.schema.json       插件清单：模块导出契约 + 工具面元数据
    dsh-config.schema.json       apply(ctx, config) 的 config 契约
    dsh-state.schema.json        GovernanceState 快照契约
  examples/
    dsh-plugin.manifest.json   本插件自身的完整清单（可复制为模板）
  __tests__/                   单元测试（vitest；状态测试用本仓库真实 .openarch 工件）
  README.md                    本文件
```

## 数据合同：`GovernanceState`（`readGovernanceState`）

Host 端 `createGovernanceCache` 采集一份有界快照，经两条通道对 Client 开放：

| 挂载方式 | 通道 |
|---|---|
| 动态 Cordis 包 | `harness.handle("openarch/governance-state")` → Client `host.call(...)` |
| 静态挂载 | Host 注册 `webServer` 路由 `GET /api/openarch/governance-state` → Client `fetch(...)` |

快照形状（全部叶子字段，节选）：

```jsonc
{
  "root": "<cwd>",
  "initialized": true,            // 无 .openarch/config.yml 时 false，其余节全空
  "collectedAt": "<iso>",
  "cli": { "ok": true, "context": { /* openarch context --json 原样 */ } },
  "baseline": {                    // .openarch/baseline/_index.json 投影
    "scanAt": "...", "nFiles": 547, "nProductionFiles": 326, "nTestFiles": 174,
    "languages": ["typescript","javascript","go"],
    "calibration": { "current": { "branch": 5.575, "nesting": 9, "loc": 207, "alpha": 0.639 },
                     "previous": { ... }, "gate": { ... } }
  },
  "scanStatus": { "status": "failed", "phase": "publishing", "completed": 547, "total": 547 },
  "config": { "locale": "zh", "languages": [...] },   // config.yml 正则提取（不引 yaml 解析器）
  "history": [ { "entryId": "diff-v3-...", "timestamp": "...", "files": 9,
                 "sumAbsDeltaI": 335.2, "maxDeltaI": 209.2, "maxDeltaFile": "...",
                 "deterioration": 0.002, "improvement": 0 } ],   // 最多 20 条，mtime 排序
  "top": [ { "path": "...", "branchCount": 21.8, "loc": 277, "nestingDepth": 7,
             "alphaStruct": 0.15, "inDegree": 2, "outDegree": 17, "connectedness": 0.275 } ],
  "distribution": { "branchCount": { "min": ..., "max": ..., "mean": ..., "buckets": [...] },
                    "loc": { ... }, "sampled": 547, "total": 547 }
}
```

不变量：

- history 与 Top-N 都是**投影**（只挑叶子字段），不回传全量 diagnosis/deltas。
- 客户端只消费这份快照，不直接读 `.openarch`（文件访问留在 Host）。

## JSON Schema（插件开发合同）

`dsh/schema/` 提供三份 JSON Schema（draft 2020-12），随 `@openarch/plugin` 一起发布。插件作者不需要猜契约：

| 文件 | 校验对象 | 典型用法 |
|---|---|---|
| `dsh-plugin.schema.json` | 插件清单（`schemaVersion`/`id`/`modules`/`tools`/`promptSections`/`slots`） | 新插件的 `plugin.manifest.json`；`modules[]` 对应 `.mjs` 的 `export const name/inject` + `apply(ctx, config)` |
| `dsh-config.schema.json` | `apply(ctx, config)` 的 config | 校验 `agent.cordis.yml` 里的配置块（转成 JSON 后） |
| `dsh-state.schema.json` | `GET /api/openarch/governance-state` 快照 | 客户端看板/测试 fixture 校验；含初始化/未初始化两个 oneOf 分支 |

编辑器用法（VS Code / IntelliJ 直接识别 `$schema`）：

```jsonc
{
  "$schema": "./node_modules/@openarch/plugin/dsh/schema/dsh-plugin.schema.json",
  "schemaVersion": 1,
  "id": "my-arch-plugin",
  "modules": [
    { "id": "my-tools", "kind": "host", "entry": "./host/my-tools.mjs", "inject": ["tools"] }
  ],
  "tools": [
    { "name": "my_check", "description": "...", "parameters": { "worktree": { "type": "boolean" } } }
  ]
}
```

本仓库自带一份完整样例 `dsh/examples/dsh-plugin.manifest.json`（内容与当前 `openarch-tools` 注册面一致）。`dsh/__tests__/openarch-schemas.test.ts` 内置一个只支持本仓库 schema 关键字子集的轻量校验器，持续把 schema、`DEFAULTS` 与真实 `GovernanceState` 产出对起来，防止文档漂移；它不引入 `ajv` 依赖，也不替代生产端校验。

运行时硬编码同样以 schema 为单一事实源：`openarch-contract.mjs` 从 `dsh-config.schema.json` 推导配置白名单（未知键 warn 并丢弃，替代散落在各模块里的键名单）；`dsh/__tests__/openarch-contract.test.ts` 把 manifest 与真实模块导出（name/inject）、工具注册面（描述/参数/输出 schema/超时/并发）、prompt section 与 slot 注册逐项交叉校验，契约改动会在测试里立刻显形。

## 模型工具合同（`openarch-tools`）

| 工具 | 参数 | 返回 | 并发/超时 |
|---|---|---|---|
| `openarch_context` | — | `{ok, initialized, root, context}` | 并发安全 / 60s |
| `openarch_check` | `worktree`(默认)·`staged`(互斥)·`tests` | `{ok, exitCode, verdict, command, report, stderr}` | 独占 / 300s |
| `openarch_review` | `evolution` | 同上 | 独占 / 300s |
| `openarch_scan` | `rebuild` | 后台任务：`{background:true, jobId}`；无 jobs 服务时同步同 check 形状 | 独占 / 900s |

- verdict 映射与 CLI 契约一致（`packages/cli/src/exit-code.ts`）：**0 PASS · 1 WARN · 2 BLOCK · 3/信号 ERROR**。
- 报告文本有界（16 000 字符尾部）；CLI 进程级失败（spawn 失败、超时）返回 `{ok:false, verdict:"ERROR", error}`。
- `openarch_scan` 后台任务对接 DSH `jobs` 注册表（`kind: "openarch"`，流式 `readOutput`、可 `job_kill`）。
- 工具卡由 `presentCall`/`presentResult` 提供（generic card + verdict 标题），v1 不接管 `tool.call.toolview` 键，避免遮蔽报告正文。
- 测试接缝：`ctx.get("openarch.exec")` / `ctx.get("openarch.spawn")` / `ctx.get("openarch.cwd")`，缺省用真实 `node:child_process`。
- DSH 服务访问约定：硬依赖（`tools`/`systemPrompt`/`webServer`/`slots`/`timer`）声明在 `inject`；可选服务与测试接缝（`jobs`、`workspaceRegistry`、`openarch.*`）统一用 `ctx.get(...)`，缺失时回退默认实现。

## 测试治理缓存

`openarch_test` 的评估结果是**运行时投影**，不是 gate 证据。为避免 DSH 重启后看板丢失上次结果，插件会把最近一次有界投影写入：

```text
<项目根>/.openarch/dsh-test-governance.json
```

- 写入时机：`openarch_test` 成功解析 `test-governance-json-v1` 后；
- 读取时机：`openarch-tools` 启动时按默认 cwd 读取，看板据此重建测试治理分区；
- 缓存损坏/缺失：fail-closed 显示“尚未运行 openarch_test”，不伪装成 clean；
- 清除方式：删除该文件即可（或下次成功运行覆盖）。

## 信号层合同（`openarch-signals`）

- `systemPrompt.section("openarch:governance", order: 90)` —— persona(0) 之后、工具指导(100–199) 之前。
- 文本是每步装配时求值的快照简报（≤7 行）：baseline 新鲜度、worktree/staged 变更、已声明策略、工具指引。
- 未初始化 / 未采集到时返回空串 → 装配丢弃空 section，不污染提示。
- 默认 120s 周期刷新；`openarch-tools` 每次执行命令后 `invalidate()`，下一次装配即拿新事实。

## 可视化层合同（`openarch-dashboard`）

| 占位 | id | 内容 |
|---|---|---|
| `conversation.composer.dock` | `openarch-governance` (order 2) | 状态条：baseline 徽章 / wt·st 变更 / rules，点击开合看板 |
| `shell.overlay` | `openarch-dashboard` (order 60) | 看板：概览 · P95 current vs gate 对照条 · 结构 Top-N 表 · Σ\|ΔI\| 历史 · branchCount 分布 |

- 默认 20s 轮询 `governance-state`；`shell.overlay` 是 click-through 层，面板根节点自接 `pointer-events: auto`。
- 未初始化项目两个占位都渲染 `null`，普通会话零打扰。
- 样式走 `--dsw-*` 主题变量 + 回退值，不覆盖全局主题；包内样式 `styles.insert` 随包清理。

## 挂载方式

> **Agent 预设已移除**：`openarch-agent-install --target dsh --preset` 不再可用（DSH 预设尚未稳定）。当前唯一正式路径是下面的 Bundle 看板；动态 Cordis 包仅用于本会话内验证/原型。

### 1. 动态 Cordis 包（本会话内验证 / 原型）

- Host：`cordis_define` 的 `code.host` 使用本目录 Host 模块的函数体（动态运行环境无 `node:fs`/`child_process`，需把文件访问与进程执行改为 `ctx.get("fs")` + `ctx.get("subprocess")` 服务；工具注册必须经 `harness.defineTool(...)` 包装）。
- Client：`code.client` 取 `client/openarch-dashboard.mjs` 函数体、去掉末尾 `export` 行即可（文件无 import，仅用 Builtin `React`/`host`/`styles`）。
- **动态 Client 半没有网络（`fetch` 不可用）**：数据通道必须是包内私有 RPC——同一动态包必须包含一个 Host 半注册
  `harness.handle("openarch/governance-state", ...)`，Client 用 `host.call` 直连；fetch 回退只对静态打包（真实浏览器环境）有效。2026-08 实测：client-only 包 + fetch 回退会以 “fetch is not available in a dynamic client half” 失败。
- **不要注册 locale 命名空间**（组件文案硬编码）：重复注册会在更新时抛 `locale namespace "openarch" already has locale "zh"`。

### 2. 静态包 / Bundle 看板（正式发行形态，含 dashboard）

`@openarch/plugin` 是一个可发布的 DSH bundle 插件：`cordis.patch.yml` 声明 dashboard/signals/tools 三行；数据通道走 `webServer` 路由（Host 已自动注册，无需额外配置）。

安装方式是把包加入 DSH profile 的 bundles（例如 `dsh.profile.bundles` 或 `dsh plugin add @openarch/plugin`）。发布包中的 `exports["./client"]` 指向**已构建**的 `lib/client.js`，该文件已按 DSH 客户端契约自注册：

```js
window.__ModuleLoader__.load({
  id: "@openarch/plugin",
  factory: (require) => { /* ... */ }
});
```

DSH 的 `client-modules` **不会扫描或编译源码**；它把 `exports["./client"]` 指向的文件原样作为 `/plugins/<id>/client.js` 伺服给浏览器。因此客户端必须预先构建为 `window.__ModuleLoader__.load(...)` 自注册 bundle，并通过 `exports["./client"]` 暴露。源码 `dsh/client/openarch-dashboard.mjs` 不是这种 bundle，不能直接作为静态 client 使用。

本地重建客户端产物：

```bash
pnpm --dir packages/openarch-plugin build:client
```

发布前 `prepack` 会自动执行该构建，`pnpm pack` 产物中的 `lib/client.js` 即为可用 bundle。

## 验证

```bash
# 单元测试（含真实 .openarch 工件夹具）
pnpm -r --filter @openarch/plugin test

# 仓库级验证（按 openarch 自身治理）
pnpm openarch check --worktree --report
```

## 路线图

- v2（待上游）：上游 `check/review` 增加 `--json` 稳定契约（`packages/cli/src/report/gateReport.ts` 已具备结构化输出对象，只需加序列化出口）；本插件直接消费，去掉文本 verdict 推断。
- v2（客户端）：`tool.call.toolview` 键接管 `openarch_*` 工具卡（verdict 徽章 + 触发文件列表 + `openFile` 跳转）。
- v3（执行流）：`sessionProjections` 注册治理投影单元，把每步 check 结果折进会话状态；审批卡附带 verdict 证据。
- v4（编排）：DSH workflow 并行治理调查（Top-N/反模式分片取证）；`services/coordination` 桥接跨会话 task/lease/evidence。
