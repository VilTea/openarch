# 协作与演化

> “没有全局在胸，是不会真的投下一着好棋子的。”——《中国革命战争的战略问题》

在处理多仓库、共享文档、`Task`、`Debt`、语义锁或 `review --evolution` 前阅读本页。

## 作用域

已发布的 OpenArch 当前一次治理一个仓库。不得从目录名、导入路径、部署名或校准令牌推导 `repositoryId`、`serviceId`、`productId`、任务身份或共享拓扑。共享事实必须有显式协作文档范围和成员登记；缺失时报告 `UNAVAILABLE`。

## 启用前提

本地 OpenArch 与 Git 文档协作默认不依赖协调服务。共享模式只有一个远端 Git DocumentStore：Agent 的 `openarch init --docs-repo <url|path>` 关联、协调服务的 Git worktree 及其返回的 `remoteUrl/branch` descriptor 必须指向同一 remote/branch。服务地址只启用对这同一仓库的协调，不得引入第二个协作仓库。`--docs-repo` 本身不配置或发现 HTTP 服务；只有用户在初始化或随后显式运行 `openarch init --coordination-url <https://...>`，本机才记录可选协调服务基址；该本机配置不含凭据，默认不进入 Git。不得从 Git remote、docs-repo、目录、部署名或环境推导服务地址。

未配置地址、地址不可达或远端 scope 不可用时，远程 Task、会议与租约为 `UNAVAILABLE`，不能静默降级或伪造协调事实；本地 `scan`、`check`、`review`、规则和 Git 文档协作继续可用。远程操作已公开为 `openarch coordination <action>` 命令族（status/bootstrap/refresh/scope/evidence/task/claim/complete/lease，advanced 可见性），全部经本机配置的协调服务基址 fail-closed（未配置/不可用 exit 3）；不要让 Agent 猜测或直接调用服务私有 HTTP 路由——一律经该命令族。

本地 `scan`、`check`、`review`、生产指标和规则都不是产品总分。`Task` 是仓库内服务子任务；语义锁是仓库内 AST 节点协调，通常最小到函数，只有证据证明时才可沿本地调用图扩展。`Debt` 是延后决策，不是可认领的锁或任务。

仅当协调服务已显式启用且对应远程操作公开后，Agent 才从服务取得脱敏的 docs-repo `remoteUrl`、branch 和 head，在本地 OpenArch/Git 写入自己拥有的 scope、共识或经验文档并 push；随后以 `repositoryId + branch + headSha` 通知服务刷新。服务只 fetch、校验并快进自己的 worktree、重建 projection，或在明确 allowlist 内写入 service-owned 的校准/交流记录；它不能代写 Agent-owned 文档。刷新失败、分叉或 scope 不可用都保持 `UNAVAILABLE`。语义锁仍是独立 TTL 租约，不写 Git。

任务采用同一边界：智能体先在 `tasks/<repositoryId>/<serviceId>/<taskId>/proposal.json` 写入显式身份、标题和假设后推送，再以相同作用域与提交版本请求验证。服务只在 `coordination/tasks/**/events.ndjson` 追加签名的生命周期事实，不改写提案；没有签名密钥时任务验证不可用，不能将路径名称视为认证。相同提案摘要与提交版本的重试幂等；已验证任务的提案改写必须使用新的任务身份。认领和语义锁仍是后续的仓库绑定租约；`verified` 不授予锁。

### 协调服务命令分支（`openarch coordination`）

`openarch coordination` 是唯一客户端入口；Agent 不得在无服务时手工调用 HTTP 路由。命令统一先判定服务状态，未配置/不可达/描述符不匹配都 fail-closed（exit 3，输出原因），不产出任何"成功"输出；本地 `scan`/`check`/`review`/`rules`/`docs` 与 Git 文档协作不受影响。

| 子命令 | not_configured | unavailable | available |
|---|---|---|---|
| `status` | exit 3：未配置 `init --coordination-url` | exit 3：网络/HTTP/描述符/scope 不匹配原因 | 呈现脱敏 remoteUrl/branch/headSha；`--json` 结构化事实 |
| `bootstrap` | exit 3 | exit 3 | 取得 descriptor，引导 `init --docs-repo` 关联 |
| `refresh` | exit 3 | exit 3 | 以本地已 push 的 `repositoryId + branch + headSha` 通知服务；分叉/脏 worktree 保持 UNAVAILABLE |
| `scope register` | 可用（纯本地生成模板） | 可用（纯本地生成模板） | 生成登记文档后引导 commit+push+refresh |
| `evidence upload` | exit 3 | exit 3 | 读 `calibration export` 产物 → `POST /v1/evidence` |
| `task submit` | exit 3 | exit 3 | proposal 已 push 后提交 `repositoryId/serviceId/taskId + branch + headSha`；无签名密钥时服务拒绝 |
| `task claim` / `task complete` | exit 3 | exit 3 | 任务已 verified 后认领（`--claimed-by`），已认领且执行者一致后完成（`--completed-by [--completed-head-sha]`）；状态机约束 |
| `lease acquire/renew/release` | exit 3 | exit 3 | 语义锁租约（`TTL` 1s~10m，`fencing token` + `epoch` 防陈旧；不写 Git，服务重启即失效） |

`scope register` 是唯一不依赖服务状态的子命令（生成智能体自有的登记模板）；其余子命令都以服务可用为前提。刷新与任务提交以智能体本地已推送的提交哈希为准，服务只校验与快进，不把服务端哈希当本地事实。完整命令用法与前提见 `docs/coordination-cli.md`。

## 演化候选

当 adapter、provider、runner、语言、命令或发行接入反复修改时运行 `openarch review --evolution`。它只报告调查优先级。

候选需要真实 Git 历史和 parser 确认的当前生产关系。历史导入确认、投影闭包、帕累托剪枝、抽样预算与排序都不能证明腐化、注册表、共享合同或必须重构。检查 dossier、当前代码、重复提交和显式合同后，才可建立项目防线。
