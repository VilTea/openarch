# Coordination service architecture

## Positioning

`services/coordination` is a lightweight consensus service in front of the Git collaboration docs repository.

The collaboration docs repository is the only durable fact source for durable cross-project collaboration state and shared governance evidence. In shared mode there is exactly one such remote repository and branch: the service worktree and every Agent's configured OpenArch DocumentStore must track that same remote/branch. The service endpoint is a coordination entry point for that repository, never a second collaboration repository. Live coordination leases are a separate runtime authority with an explicit expiry; they are not Git facts. The service exists to:

- read and refresh the shared repository after an agent has pushed its own documents
- serialize writes only for explicitly service-owned records (for example calibration evidence and future append-only coordination events)
- arbitrate short-lived coordination leases without creating a Git commit per renewal
- maintain fast read projections
- provide timely query / notification interfaces

It is not:

- a remote OpenArch core
- a second authority for project policy
- a hidden database where product defaults or dogfood assumptions live

Local project `.openarch` data remains the authority for local scan / diff / gate / test. The collaboration docs repository remains the durable authority for shared coordination and cross-project calibration state. Service-local files, NDJSON caches, SQLite, and ordinary in-memory maps are disposable projections; the explicitly scoped `LeaseStore` is the separate live authority for expiring locks and liveness. A service-owned writer must be allowlisted by artifact; there is no generic service document write path.

## Scope boundary

Coordination must distinguish `repository`, `service`, and `product` scopes. A repository owns local governance facts and is the only place a semantic lock can protect source changes. A service is an explicitly declared capability boundary that may live in a monorepo or repository; a product is an explicitly declared set of service references used for shared decisions and cross-service Tasks. The service must never infer membership from a path, import graph, deployment name, or evidence token.

The current evidence `projectToken` is deliberately opaque and only supports calibration de-correlation. It is not a repository, service, or product identity and must not be reused for locks, Task claims, or authorization. The current docs-repo `projects/<basename>` convention is repository-local legacy behavior, not a stable identity contract.

When Phase 3 adds collaboration, a product Task may coordinate a goal but must materialize repository-bound service subtasks. Claim, Session, branch, verification, and semantic lock apply to those subtasks; a product Task cannot acquire a cross-repository lock. Locks are AST-node semantic locks, with a function implementation as the ordinary minimum target; type/file targets are explicit wider operations, and signature/internal-behaviour changes may expand through the local repository call graph. Debt remains a deferred decision record without claim or lock and becomes work only through an explicit Task creation. The complete planned contract is in [`docs/collaboration-scope-design.md`](../../docs/collaboration-scope-design.md).

## 多项目共用一个文档仓

共享模式只有一个远端仓库和一个分支，但这一个分支可以承载多个项目的登记与事实。当前实现已按 `repositoryId` 命名空间化，并有针对性的多项目并发行为：

| 表面 | 多项目行为 |
|---|---|
| scope 登记 | `repositories/<id>/scope.json`、`services/<repo>/<svc>/scope.json`、`products/<id>/scope.json` 均按身份命名；`ScopeRegistry.Validate` 强制服务引用已登记仓库、产品引用已登记服务。 |
| Task 提案/事件 | `tasks/<repo>/<svc>/<task>/proposal.json`（Agent-owned）与 `coordination/tasks/<repo>/<svc>/<task>/events.ndjson`（service-owned）按仓库/服务/任务隔离；`publishOwnedFile` 白名单同样按该路径校验。 |
| 校准证据 | 共享 `evidence/validation.ndjson` 的槽位指纹含 `projectToken`，不同项目不互相覆盖；校准聚合按 `provider/rule/authority` 跨项目计数 `projects`。`projectToken` 必须由各项目保证在共享仓内唯一（重复 token 会被视为同一项目的槽位并替换）。 |
| 租约 / 会话 | 键均含 `repositoryId`；`GET /v1/leases`、`GET /v1/sessions`、`GET /v1/events` 支持可选 `?repositoryId=` 过滤实时视图。 |
| 并发 refresh | 推送后若另一个项目已把同一分支推进，refresh 只要求广告 head 是远端 head 的祖先即可（只快进、不回退），响应返回实际 head 并据此重建投影。 |
| Task 提交 | 保持更严的绑定：`task submit` 要求广告 head 等于远端 head，或其后仅有 service-owned 提交；若中间混入 Agent-owned 提交则 fail-closed，必须按错误原因重试/换新提交版本，不静默放宽任务身份。 |
| 遗留 `projects/<basename>` | 服务在 `GET /v1/docs-repo` 的 `legacyProjects` 中列出未迁移位置，但绝不把 basename 隐式提升为 `repositoryId`；迁移由 `openarch coordination scope register --repository-id <新稳定id>` 显式完成。 |

仍然不在多项目信任域内的能力：认证/授权、按项目配额/限流、以及多实例部署下的跨进程 Git 写串行化与 TTL 原子租约（当前内存 LeaseStore/SessionStore 只承诺单实例语义，多实例必须换成 TTL 原子存储或单路由 coordinator）。

## Architectural consequence

The important early choice is not a heavy Go framework. The high-leverage choice is to model the service as:

- Git-backed write-through command handling
- rebuildable read models
- bounded contexts with explicit ports and adapters
- `cmd/` as the only composition root

This gives the same kind of long-term benefit that `packages/core` got from early dependency discipline: explicit dependencies, replaceable adapters, and no transport-shaped business logic.

Current scope still does not justify a runtime DI framework. Go stdlib plus explicit constructors is enough until Phase 3 introduces genuinely complex lifecycle management.

## Core model

### Authority model

There are four distinct storage roles:

1. Git collaboration docs repository: durable fact source for scope, decisions, evidence, and audit
2. Live lease authority: short-lived semantic locks and liveness, held by `LeaseStore` in memory or another TTL-backed ephemeral store
3. Service projection store: disposable acceleration layer for durable Git facts
4. Process memory: non-authoritative caches and request-local state

If the service is destroyed, durable projections can be rebuilt from Git and active leases expire rather than becoming stale locks. If Git history is lost, the system has lost durable truth; if the lease authority is lost, clients must reacquire coordination leases.

### Command model

Every durable state-changing operation is a command against Git-backed authority, but the writer is selected by artifact ownership. Agent-owned scope/consensus documents are committed and pushed by the agent; the service only refreshes its read worktree. Service-owned evidence or append-only coordination records may use a narrow service authority adapter. Lease operations are a separate command family against the live lease authority and must never be acknowledged as durable Git facts.

Examples:

- service upserts a calibration evidence batch
- agent registers / updates a repository, service, or product scope, then notifies refresh
- agent writes a Task, Debt, or final consensus decision document, then notifies refresh
- service appends an owned append-only coordination record（v5.3：会议房间/交流事件记录已 cut）

Task proposals are Agent-owned Git documents. The service verifies one pushed
proposal/scope/head snapshot and appends signed `verified → claimed → completed`
events under `coordination/tasks/`. Task events use schema v2 with a
`sequence` / `eventHash` / `prevEventHash` hash chain and canonical JSON
signing payloads; both write and read paths reject broken chains, invalid
transitions, and proposals that changed after verification. Task event routes
are disabled unless `--task-signing-key` supplies a base64 Ed25519 seed or
private-key file; a path prefix alone is not treated as authorization.
Additional historical public keys can be trusted with repeatable
`--task-verify-key "<keyId>:<base64pub>"`.

Live lease commands include:

- acquire / renew / release a semantic lock
- heartbeat / expire a live Session lease

The service may validate, serialize, commit, push, and then publish derived projections, but it must not acknowledge a durable shared state transition that cannot be traced back to repository state.

### Query model

Durable queries should read from projections, not by walking Git on every request. Active lease queries read from the live lease authority and are bounded by the returned expiry.

Examples:

- calibration by provider / rule / authority
- active lock view (live, expiring)
- session status (durable identity plus live lease state)
- review feed / notifications

Read models are caches. They improve latency; they do not own truth.

## Write path and read path

### Write path

Target flow:

1. an agent obtains the remote docs-repo descriptor, writes its owned documents locally, and commits/pushes
2. the agent notifies `POST /v1/docs-repo/refresh` with explicit `repositoryId`, branch, and pushed head SHA
3. the service validates the notice, fetches, accepts only a fast-forward of its disposable worktree, and rebuilds projections
4. service-owned records use a separate allowlisted writer; lease commands go through `LeaseStore`
5. transport publishes the result / notifications

If an agent push, service-owned commit/push, or refresh/head advance fails, the command must fail or retry explicitly. If lease storage is unavailable, lease commands must fail closed; the service must not silently claim a durable lock or reconstruct an expired lease from Git.

### Read path

Target flow:

1. Git head changes or a command succeeds
2. projection builder updates query models
3. HTTP / SSE reads projections

When projections are stale or missing, rebuild from Git rather than inventing fallback truth.

## Bounded contexts

The service should grow by bounded context, not by endpoint accumulation.

### 1. Evidence calibration context

Phase 2 starts here.

Responsibilities:

- accept desensitized shared evidence
- write evidence records into Git-backed shared state
- project calibration summaries by provider / rule / authority
- return review recommendations

Not responsible for:

- remote gate decisions
- source-code inspection
- project-local thresholds or path rules

### 2. Collaboration context

Phase 3.

Responsibilities:

- explicit repository/service/product scope identity
- session registry
- semantic lock lifecycle
- meeting lifecycle（v5.3 cut：以 SSE + docs-repo 共识文档替代，不建房间状态机）
- timely notifications

Not responsible for:

- becoming the permanent source instead of Git
- rewriting local `.openarch` baseline or history

These contexts may share identity, audit, and projection infrastructure, but they must keep separate application services and ports.

## Architectural layers

### Domain

Pure types and invariants. No HTTP, filesystem, SQL, env, or Git.

Examples:

- `ValidationEvidence`
- `Calibration`
- `RepositoryRef`, `ServiceRef`, `ProductRef`
- lock/session/debt value objects and invariants（v5.3：meeting 已 cut）
- recommendation rules

### Application

Use cases that orchestrate domain logic through ports.

Phase 2 examples:

- `IngestEvidence`
- `GetCalibration`

Phase 3 examples:

- `AcquireLock`
- `ReleaseLock`
- `RegisterSession`
- `RecordDebt`（v5.3 revised：版本化 Debt 文档 + 校验，先于状态机）

Application code should accept `context.Context`, call ports, and return typed results/errors. It should not know whether the backing projection is NDJSON, SQLite, or memory.

### Ports

Interfaces owned by the application layer.

Expected port families:

- `AuthorityRepo`: read / write durable Git-backed shared state
- `LeaseStore`: atomic acquire / renew / release of expiring semantic leases; no Git or durable storage contract
- `ProjectionStore`: maintain query models
- `EventPublisher`: SSE / WS / polling invalidation hooks
- optional infrastructure ports such as `Clock` and `Logger`

Important: the authoritative write port and the projection port must stay separate.

### Adapters

Transport and infrastructure implementations.

Examples:

- HTTP command/query handlers
- Git worktree mutation adapter
- projection builders over NDJSON / SQLite
- SSE transport

The current NDJSON implementation should be treated as a temporary projection/cache technique, not as the architectural center.

## Git-backed authority design

### Durable repository rule

All shared durable state must have a repository representation with schema and auditability. This rule does not apply to live leases whose correctness depends on expiry and atomic renewal rather than historical replay.

Likely shapes:

- bounded current evidence records with Git history audit
- scope, Task, Debt, and meeting decision documents
- derived human-readable summaries where helpful

The service may keep additional local indexes, but they must be derivable from repository contents. A lease store is different: it is the authority for the current lease interval, is not rebuildable from Git, and must expose its loss/restart boundary.

### Live lease authority

Semantic locks are short-lived coordination leases, not durable facts. The lease key contains the explicit `repositoryId` and semantic target (function by default; wider type/file targets require explicit scope), plus the owner/claim context. A successful acquisition returns a lease ID, fencing token, coordinator epoch, and expiry. Renewal is accepted only for the current lease owner before expiry; release is idempotent; an expired lease cannot be resurrected.

The first adapter may keep leases in process memory under a single-writer service instance. A multi-instance deployment must use a TTL-capable atomic store or a single routed coordinator; it must not pretend that independent process memories form consensus. Restarting the lease authority advances its coordinator epoch and invalidates old leases. Optional Git or event-log records are audit hints only and can never recreate an active lock.

### Concurrency rule

Consensus is lightweight because the service serializes commands, not because it owns exclusive truth.

Recommended mechanisms:

- precondition checks against known repository head
- single-writer mutation queue per repository clone
- retry/rebase on head movement
- explicit lease expiry and fencing in the `LeaseStore` contract rather than hidden in Git history

### Failure rule

If the service is down:

- local OpenArch governance continues
- durable shared coordination remains in Git
- active leases are unavailable and expire; clients must reacquire after the service returns
- another instance can rebuild durable projections from Git, but cannot infer old live locks

This is the architectural payoff of keeping Git as the durable fact source while giving live leases their own explicit lifecycle.

## Package direction

Target structure:

```text
services/coordination/
  cmd/openarch-coordination/
    main.go
  internal/
    evidence/
      domain/
      application/
      port/
      adapter/
        http/
        gitrepo/
        lease/
        projection/
    collaboration/
      domain/
      application/
      port/
      adapter/
        http/
        gitrepo/
        projection/
    platform/
      gitrepo/
      projection/
      httpx/
      logging/
```

The shared platform packages should contain reusable mechanics, not cross-context business logic.

## Current prototype state

The evidence context has now been split into:

- `domain`
- `application`
- `port`
- `adapter/httpapi`
- `adapter/ndjson`

That removes the previous “one file owns four layers” corruption pattern. The remaining limitation is different: the current NDJSON adapter is still a local prototype that temporarily satisfies both authoritative-write and projection reads. That is acceptable for Phase 2 dogfood, but it is not the target shape.

The current implementation now separates:

- authoritative writes into a synchronized docs-repo Git adapter
- rebuildable local projection reads

An ingest is acknowledged only after the adapter upserts `evidence/validation.ndjson`, creates a dedicated Git commit, pushes that commit to the configured remote branch, and confirms that local and remote heads match. Startup rejects a non-Git worktree, a missing remote branch, or a worktree whose checked-out head differs from that remote branch. A push failure leaves the local commit unacknowledged and makes later authority reads/writes fail closed until the repository is synchronized again.

Each `ValidationEvidence` is schema `2` and carries one explicit calibration key: `providerId + ruleId + authorityId`. The `authorityId` is a stable, opaque authority identifier declared by the reporting integration; it must not be inferred from a source path, test name, or repository layout. All three key parts accept only ASCII identifiers up to 128 characters (`[A-Za-z0-9][A-Za-z0-9._:@-]*`), so path separators cannot enter shared evidence. The HTTP query is correspondingly `GET /v1/calibrations/{provider}/{rule}/{authority}`, so records from different rules or authorities are never mixed into one recommendation.

Evidence ingest is content-addressed at the calibration-conclusion level: observation time and collection window do not create a new record when the project token, provider/rule/authority, language set, tool version, finding count, policy result and reviewed error counts are unchanged. A duplicate CI retry is therefore a no-op and creates no Git commit. Each project/key/language slot retains only its latest distinct conclusion, so one project cannot repeatedly inflate a calibration aggregate; Git history remains the audit trail of replacements. Retention or compaction must be an explicit future authority schema, never silent deletion by the projection.

The independent Go coordination module has now verified the `go-testing` provider, its own OpenArch scope, and schema-v2 evidence export. A read-only validation copy of the public `prometheus/client_golang` Go module (snapshot `ecdb825`) supplied a second real project sample for the same `go-testing / go-testing.skip-call / go-testing-stdlib` key: 69/69 test files were statically covered and 6 skip findings were exported. Its full `go test ./...` run remained unavailable because the environment could not reach `proxy.golang.org`; that runtime failure is not converted into a clean or zero-finding result. In a temporary local Git authority, the sample aggregated with the two earlier validation records as 3 projects, 3 samples, and average finding count `2.0`; the recommendation remains review-only per project. This validates the evidence transport and a first heterogeneous sample, but it does not establish a portable statistical recommendation. The remaining gaps are narrower and explicit:

- the projection is still a local NDJSON cache
- the sample is still observed-only and locally staged; real CI submissions with human-reviewed false-positive/false-negative labels are required before any provider rule or project threshold is promoted

The command entry point accepts `--git-remote`, `--git-branch`, `--git-author-name`, and `--git-author-email`; it defaults to `origin`, the checked-out branch, and the service identity.

Evidence HTTP endpoints now share the Task error contract: structured
`{ error, code, retryable, requestId }` responses, `X-Request-Id` echo, and
slog JSON operation logs. Bad input is `invalid_request`; Git authority write
or refresh failures are retryable `authority_unavailable`; projection read
failures are `service_unavailable`.

## Local policy trial

The service has one project-local exploratory rule: `max_func_branch > 5` at WARN. It was derived from the sealed calibration P95 of `4.15` and the original `authority.go` production sample of `5.30`; test files remain outside the production governance population. That warning was actionable: `Authority.AppendEvidence` was carrying synchronization, idempotent slot transition, file publication, Git commit/push, and final head verification in one function. The implementation now separates `prepareEvidenceAppend`, pure `upsertEvidence`, and `publishEvidence`.

The root multi-language policy preserves this same Go trial instead of inheriting TypeScript thresholds. The completed `authority.go` decomposition does not certify later functions: the current root scan warns on `git.go` and the composition-root `main.go`, whose `max_func_branch` values exceed 5. They are active investigation items, not calibration failure and not grounds to raise the threshold. The local-burden value reported for the previous decomposition is a different metric from this direct function-complexity rule. This remains a calibration sample, not a portable Go/OpenArch default. After each meaningful change, run a fresh scan/review and classify the warning as actionable, an accepted boundary, or a false positive before changing or promoting the rule. No BLOCK is implied by this first trial.

## Contracts to preserve

1. Service offline or unavailable must not change local `openarch check` policy behavior.
2. Git collaboration docs repository is the only durable fact source for durable shared state.
3. Live lock/session leases use an explicit expiring `LeaseStore`; they are never reconstructed from Git.
4. Unknown JSON fields stay rejected at the transport boundary.
5. Shared evidence payloads stay desensitized.
6. Remote results are recommendations or durable coordination facts traceable to Git, not hidden policy overrides.
7. Projection replacement from NDJSON to SQLite must not require changing application contracts.

## Immediate implementation sequence

1. Keep NDJSON only as a temporary projection/cache mechanism, not as the authority abstraction.
2. Keep repeated calibration exports idempotent; introduce retention/compaction only through a reviewed authority schema once real sample cadence establishes a need.
3. Collect matching records from real CI, including human-reviewed false-positive/false-negative labels, before treating recommendations as portable calibration input.
4. ~~Phase 3 M0 domain-only scope identity contract~~ done: Git-backed `repositories/services/products` scope registration, referential validation, and an explicit `LegacyProjectRef`/`MigrateLegacyProject` contract are implemented and surfaced via `legacyProjects`.
5. ~~Git-backed scope registration and explicit migration contract~~ done at the domain/read boundary; the remaining migration gap is an explicit `scope migrate-legacy` command and tests, not identity inference.
6. ~~Domain-only LeaseStore contract and in-memory TTL adapter~~ done with epoch + fencing.
7. ~~Repository-bound live Session and SSE transport~~ done: register/heartbeat/close/list, bounded event fan-out, and `?repositoryId=` filtering for live views.

Next gaps, in order（design v5.3 §1.6 收敛）：

- ~~`scope migrate-legacy` command and Task list/query endpoints~~ done: `coordination scope migrate-legacy`、`GET /v1/tasks` + `coordination task list`。
- ~~Versioned Debt documents with scope references~~ done: `debts/<repo>/<svc>/<debt>.json` Agent-owned 文档、`GET /v1/debts` 只读投影、`coordination debt register/list`。
- ~~Minimal `protected_paths` inside `authority_hygiene`~~ done: 变更级 warn/block 政策并入 `openarch check`。
- ~~Append-only replay protection (`prevEventHash`/sequence)~~ done（Task v2 哈希链）；retention policy for service-owned streams 仍开放。
- Multi-instance TTL-backed Lease/Session store or single routed coordinator; cross-process Git write serialization（conditional：真实多项目共仓上线前）。
- Authn/z, per-project quotas/rate limits, and access/metrics logs for a real multi-project trust domain.
- e2e smoke/load tests for multi-project shared-branch pushes.

Cut by v5.3：meeting room lifecycle、product Task automatic decomposition、SQLite projection（推迟到多实例需求出现）。

## 生成文件治理

协调服务运行时产生的本地文件只有一类：**投影缓存**（`--projection`，默认 `coordination-projection.ndjson`）。

- 它是可从 Git authority **重建的 disposable 缓存**（refresh 时从 Git 事实重建），不是长期事实源；丢失或删除无影响。
- 默认位置为**系统临时目录**（`os.TempDir()` 下按 docs-repo 路径 hash 的稳定名），避免污染项目工作区或共享 docs-repo。
- 需要持久化到特定位置时用 `--projection <path>` 显式指定；若该路径落在 Git 工作区内（如项目根），请确保加入 `.gitignore`（项目 `.gitignore` 已含 `coordination-projection.ndjson`）。
- 服务写入 docs-repo 的 `evidence/`、`coordination/tasks/` 是 **service-owned 共享事实**（受 `publishOwnedFile` 路径白名单约束、提交后经 Git 传播），与本地投影缓存性质不同。

## Task 验证密钥

Task submit 需要服务以 `--task-signing-key <file>` 启用，密钥文件为 **base64 raw（无 padding）的 Ed25519 私钥或 32 字节 seed**。生成指引：

```bash
# 用 Go 生成（seed 来自 32 字节随机数；私钥 64 字节）
go run - <<'EOF'
package main
import ("crypto/ed25519"; "crypto/rand"; "encoding/base64"; "fmt"; "os")
func main() {
    pub, priv, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { panic(err) }
    f, _ := os.Create("signing.key")
    f.WriteString(base64.RawStdEncoding.EncodeToString(priv))
    f.Close()
    fmt.Println("public key (share for verification):", base64.RawStdEncoding.EncodeToString(pub))
}
```

如需轮换签名密钥后仍能验证旧事件，启动时用可重复的 `--task-verify-key "<keyId>:<base64pub>"` 注册旧公钥；当前 `--task-signing-key` 对应公钥自动受信。

Agent 提交流程：在 docs-repo 写 `tasks/<repositoryId>/<serviceId>/<taskId>/proposal.json`（含 `requestedBy`/`title`/`hypothesis`，`requestedBy` 必须是合法 identifier）→ commit → push（远端模式）或直接 commit（本地共享模式）→ `openarch coordination task submit --repository-id <id> --service-id <id> --task-id <id> --branch <b> --head-sha <sha>`。服务校验 proposal 在指定 head 存在、`requestedBy` 合法，追加 Ed25519 签名的 schema v2 `verified` 事件到 `coordination/tasks/**/events.ndjson`；相同 proposal+head 重提幂等返回"已存在"，不同 head 重提拒绝（防重放）。

## 本机验证（2026-08-15）

- Go 工具链：`E:\workspace\llm\.tools\go\bin\go.exe`（go1.26.5）
- C 编译器（race detector 依赖 cgo）：`E:\workspace\llm\.tools\w64devkit\w64devkit\bin\gcc.exe`（w64devkit 2.9.1）
- 验证命令：

```powershell
$env:CGO_ENABLED = '1'
$env:PATH = 'E:\workspace\llm\.tools\w64devkit\w64devkit\bin;E:\workspace\llm\.tools\go\bin;' + $env:PATH
go test -race ./...
```

结果：`go vet ./...`、`go build ./...`、`go test ./...`、`go test -race ./...` 全部通过。
