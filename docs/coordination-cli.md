# OpenArch 协调服务 CLI 使用指南

**适用范围**：`openarch coordination` 命令族

## 1. 总览

`openarch coordination` 是**唯一**的协调服务客户端入口。它管理三类协作能力：

| 能力 | 载体 | 权威 |
|---|---|---|
| 作用域登记（repositories/services/products） | Agent-owned Git 文档（docs-repo） | Git（Agent commit + push） |
| Task 生命周期（proposal→verified→claimed→completed） | proposal（Git）+ 签名事件（service-owned） | Git + Ed25519 签名 |
| 语义锁（Session） | LeaseStore（内存，TTL） | 服务运行时（重启即失效） |

**核心前提**：协调服务是**可选**的。不存在服务时，本地 `scan`/`check`/`review`/`rules`/`docs` 全部不受影响；`coordination` 命令 fail-closed（exit 3 + 原因），绝不伪造"成功"。

## 2. 前提条件清单（按依赖分层）

### 2.1 所有 coordination 命令的通用前提

| 前提 | 说明 | 缺失时的行为 |
|---|---|---|
| OpenArch 已初始化 | `.openarch/` 存在 | 本地命令按各自规则处理 |
| docs-repo 已关联（除 `lease`） | `openarch init --docs-repo <url\|path>` 建立 `.openarch/docs-repo` | `scope register`/`task`/`refresh`/`bootstrap` 报"未关联"，exit 3 |
| 协调服务可达 + descriptor 匹配 | `openarch coordination status` 显示 `available` | 服务依赖命令报原因，exit 3 |

### 2.2 按命令的具体前提

| 命令 | 额外前提 | 说明 |
|---|---|---|
| `coordination status` | 无（诊断命令） | 任何状态下可运行 |
| `coordination bootstrap` | 服务在线 | 仅读取服务 descriptor 引导关联 |
| `coordination scope register` | 仅 docs-repo 关联 | **不依赖服务在线**（纯本地生成 Agent-owned 文档） |
| `coordination refresh` | 服务在线 + 本地已 push 变更 | 以本地已 push 的 head 通知服务快进 |
| `coordination evidence upload` | 服务在线 + 证据文件（`calibration export` 产物） | — |
| `coordination task submit` | 服务在线 + 签名密钥（服务端 `--task-signing-key`）+ proposal 已 push + 作用域已登记 | 无密钥时服务拒绝（503） |
| `coordination task claim/complete` | 同上 + 任务已 verified / 已 claimed | 状态机约束 |
| `coordination lease acquire/renew/release` | 服务在线（local 或 remote 模式均可） | TTL 1s~10m |

## 3. 命令速查

### 3.1 状态诊断

```bash
openarch coordination status                 # 三层状态 + 原因
openarch coordination status --json          # 结构化事实（state/detail/remoteUrl/branch/headSha）
```

| state | 含义 | 下一步 |
|---|---|---|
| `not_configured` | 未配置 `init --coordination-url` | 运行 `init --coordination-url <url>` |
| `unavailable` | 配置了但不可达 / descriptor 不匹配 | 按 detail 排查（网络、服务未起、remote/branch 不一致） |
| `available` | 服务可达 + 与本地 docs-repo 匹配 | 可用全部命令 |

### 3.2 初始化与关联

```bash
# 单次调用同时关联 docs-repo 与协调服务（推荐）
openarch init --docs-repo <url|path> --coordination-url <url>

# 本地多 Agent 协作：docs-repo 为本地 Git 仓库（无远端）
#   多个 Agent 各自 init 指向同一本地目录（自动 junction 软连接），
#   服务端以 --git-remote 留空启动（local 模式，commit 即共享）
openarch init --docs-repo /shared/docs-repo --coordination-url http://127.0.0.1:8787
```

### 3.3 作用域登记（Agent-owned）

```bash
# 生成 repositories/<id>/scope.json（契约格式）
openarch coordination scope register --repository-id repo-1
# 生成 services/<repo>/<svc>/scope.json
openarch coordination scope register --repository-id repo-1 --service-id svc-a
# 生成 products/<id>/scope.json
openarch coordination scope register --product-id prod-1 --service repo-1/svc-a --service repo-2/svc-a

# 之后：git add + commit + push（远端模式）或直接 commit（本地共享模式），
# 再通知服务：
openarch coordination refresh --repository-id repo-1 --branch main --head-sha <sha>
```

**前提**：`init --docs-repo` 已关联；写入目标是 docs-repo 根（不是当前目录）。
**边界**：identifier 必须 ASCII 字母/数字开头，≤128 字节，仅 `._:@-` 续。

### 3.4 Task 生命周期（签名事件）

```bash
# 0. 前提：服务以 --task-signing-key 启动（密钥生成见 services/coordination/README.md）
# 1. 写 proposal 到 docs-repo：tasks/<repo>/<svc>/<task>/proposal.json
#    {"schemaVersion":"1","task":{...},"requestedBy":"agent-1","title":"...","hypothesis":"..."}
# 2. commit + push
# 3. 提交验证：
openarch coordination task submit --repository-id repo-1 --service-id svc-a --task-id task-1 \
  --branch main --head-sha <sha>
#    → "task task-1 已创建：状态 verified"（幂等：同 proposal+head 重提返回"已存在"）

# 4. 认领（需 verified）
openarch coordination task claim --repository-id repo-1 --service-id svc-a --task-id task-1 \
  --proposal-sha256 <sha256> --claimed-by agent-2
#    → "已认领：状态 claimed 执行者 agent-2"

# 5. 完成（需 claimed 且执行者一致）
openarch coordination task complete --repository-id repo-1 --service-id svc-a --task-id task-1 \
  --proposal-sha256 <sha256> --completed-by agent-2 [--completed-head-sha <sha>]
#    → "已完成：状态 completed"
```

**前提**：作用域已登记（service 必须存在）；proposal 在指定 head 存在且 `requestedBy` 合法；服务有签名密钥。
**防重放**：同 proposal+head 幂等；不同 head 重提拒绝；claim 后异执行者拒绝。

### 3.5 语义锁（Session/租约）

```bash
# 获取（默认 TTL 30s，范围 1s~10m）
openarch coordination lease acquire --repository-id repo-1 --target service/svc-a \
  --owner agent-2 [--ttl 30]
#    → 已获取语义锁；记录 leaseId/fencingToken/epoch 供续期与释放

# 续期（携带完整 credential）
openarch coordination lease renew --lease-id <id> --owner agent-2 \
  --fencing-token <n> --epoch <n> [--ttl 30]

# 释放
openarch coordination lease release --lease-id <id> --owner agent-2 \
  --fencing-token <n> --epoch <n>
```

**前提**：服务在线（local/remote 均可）；TTL 在 [1s, 10m]。
**边界**：租约是 ephemeral（不写 Git）；服务重启 epoch 递增使全部凭据失效；fencing token 防陈旧凭据。

## 4. 完整协作流程示例

### 4.1 远端模式（共享 Git server）

```bash
# 服务端（一次）：git server 上建 docs-repo 裸仓库；服务以 remote 模式启动
openarch-coordination --docs-repo <worktree> --git-remote origin --git-branch main \
  --task-signing-key <key> --listen 127.0.0.1:8787

# Agent A：
openarch init --docs-repo git@server:docs.git --coordination-url http://127.0.0.1:8787
openarch coordination status                       # available
openarch coordination scope register --repository-id repo-1 --service-id svc-a
cd <docs-repo> && git add . && git commit -m "register" && git push
openarch coordination refresh --repository-id repo-1 --branch main --head-sha <sha>
# 写 proposal → push → submit → claim → complete（见 3.4）
```

### 4.2 本地多 Agent 模式（同机协作）

```bash
# 服务端：local 模式（无 --git-remote）
openarch-coordination --docs-repo /shared/docs-repo --git-branch main \
  --task-signing-key <key> --listen 127.0.0.1:8787

# Agent A / B（各自项目，docs-repo 指向同一本地目录，junction 共享）
openarch init --docs-repo /shared/docs-repo --coordination-url http://127.0.0.1:8787
openarch coordination status                       # available（本地路径匹配）
# A 登记 scope → commit（共享目录 B 即见）→ refresh → task 流程
```

## 5. 离线/在线分支（前提不满足时）

| 状态 | coordination 命令 | 本地治理 |
|---|---|---|
| 未配置服务 | 全部 exit 3（`scope register` 除外——仅需 docs-repo） | 不受影响 |
| 配置但服务不可达 | 全部 exit 3 + 具体原因（网络/HTTP/descriptor/scope 不匹配） | 不受影响 |
| 服务在线 + 匹配 | 全部可用 | 不受影响 |

**原则**：不伪造协调事实——服务不可用时没有"降级成功"，只有显式失败或纯本地能力。

## 6. 安全边界

- **双轨所有权**：CLI 只写 Agent-owned 文档（`repositories/`、`services/`、`products/`、`tasks/.../proposal.json`）；`coordination/`、`evidence/` 由服务在 `publishOwnedFile` 白名单内写
- **签名**：Task 事件由服务 Ed25519 私钥签名，Agent 只能 push proposal，不能伪造事件
- **租约**：fencing token + epoch 防陈旧/重放；不写 Git，重启即失效
- **无凭据**：coordination 配置只存 http(s) 基址，不含 token
