# Collaboration And Evolution

> “没有全局在胸，是不会真的投下一着好棋子的。” — Mao Zedong, *Problems of Strategy in China's Revolutionary War* (1936)

Read this page before multi-repository work, shared documents, Task/Debt, semantic locks, or `review --evolution`.

## Scope

Published OpenArch currently governs one repository at a time. Do not derive `repositoryId`, `serviceId`, `productId`, task identity, or shared topology from a folder name, import path, deployment name, or calibration token. Shared facts need an explicit collaboration-document scope and member registry; otherwise report `UNAVAILABLE`.

## Activation Prerequisite

Local OpenArch and Git document collaboration do not require a coordination service. Shared mode has one remote Git DocumentStore: the Agent's `openarch init --docs-repo <url|path>` association, the coordination service's Git worktree, and its returned `remoteUrl/branch` descriptor must name the same remote and branch. A service address only enables coordination around that same repository; it must not introduce a second collaboration repository. `--docs-repo` itself neither configures nor discovers an HTTP service. Only when the user explicitly runs `openarch init --coordination-url <https://...>` during initialization or later does this machine record an optional coordination-service base URL. This local selection contains no credentials and is ignored by Git by default. Never infer the address from a Git remote, docs-repo, directory, or deployment name.

With no address, an unreachable address, or unavailable remote scope, remote Tasks, meetings, and leases are `UNAVAILABLE`: do not silently fall back or fabricate coordination facts. Local `scan`, `check`, `review`, rules, and Git document collaboration remain available. The current CLI only records and presents this activation fact; no remote collaboration command is public yet, so an Agent must not guess or call private service HTTP routes.

Local `scan`, `check`, `review`, production metrics, and rules are never a product-wide score. A `Task` is a repository-bound service subtask. A semantic lock coordinates a repository-local AST node: function scope is normally the minimum, and it may expand through the local call graph only with evidence. `Debt` is a deferred decision, not a claimable lock or task.

Only when coordination is explicitly enabled and the relevant remote operation is public does an agent obtain the redacted docs-repo `remoteUrl`, branch, and head from the service. It then writes its owned scope, consensus, or wisdom documents in a local OpenArch/Git worktree and pushes them, followed by a `repositoryId + branch + headSha` refresh notice. The service only fetches, verifies, fast-forwards its disposable worktree, and rebuilds projections, or writes explicitly allowlisted service-owned calibration/communication records. It must not write agent-owned documents. Refresh failures, divergence, or unavailable scope remain `UNAVAILABLE`. Semantic locks remain independent TTL leases and are not Git facts.

Tasks use the same boundary: the Agent writes explicit identity, title, and hypothesis to `tasks/<repositoryId>/<serviceId>/<taskId>/proposal.json`, pushes it, then submits the same scope and head for verification. The service only appends signed lifecycle facts at `coordination/tasks/**/events.ndjson`; it does not rewrite the proposal. Task verification is unavailable without a signing key, because a path name is not authentication. A retry with the same proposal hash/head is idempotent; changing a verified proposal requires a new Task identity. Claim and semantic-lock lifecycle remain future repository-bound leases; `verified` grants no lock.

### Coordination command branching (`openarch coordination`)

`openarch coordination` is the only client entry point; agents must not call HTTP routes by hand when no service is configured. Every command first determines service state: not configured, unreachable, or descriptor mismatch all fail closed (exit 3 with the reason) and never produce a "success" output. Local `scan`/`check`/`review`/`rules`/`docs` and Git document collaboration are unaffected.

| subcommand | not_configured | unavailable | available |
|---|---|---|---|
| `status` | exit 3: run `init --coordination-url` first | exit 3: network/HTTP/descriptor/scope mismatch reason | prints redacted remoteUrl/branch/headSha; `--json` structured facts |
| `bootstrap` | exit 3 | exit 3 | obtains descriptor, guides `init --docs-repo` binding |
| `refresh` | exit 3 | exit 3 | notifies with the locally pushed `repositoryId + branch + headSha`; divergence/dirty worktree stays UNAVAILABLE |
| `scope register` | available (local template only) | available (local template only) | generates registration documents, guides commit+push+refresh |
| `evidence upload` | exit 3 | exit 3 | reads `calibration export` output → `POST /v1/evidence` |
| `task submit` | exit 3 | exit 3 | submits `repositoryId/serviceId/taskId + branch + headSha` after the proposal is pushed; service refuses without a signing key |
| `task claim` / `task complete` | exit 3 | exit 3 | claim after verified (`--claimed-by`), complete by the same executor after claimed (`--completed-by [--completed-head-sha]`); state machine enforced |
| `lease acquire/renew/release` | exit 3 | exit 3 | semantic-lock leases (`TTL` 1s~10m, `fencing token` + `epoch` guard; not Git-backed, invalidated on service restart) |

`scope register` is the only subcommand independent of service state (it generates Agent-owned registration templates); the rest require an available service. refresh/task submit use the locally pushed head as the precondition; the service only verifies and fast-forwards, and the service head is never treated as a local fact. Full command usage and prerequisites live in `docs/coordination-cli.md`.

## Evolution Candidates

Run `openarch review --evolution` when repeated adapter, provider, runner, language, command, or distribution integration may be accumulating coordination work. It is report-only.

Candidates require real Git history and parser-confirmed current production relationships. History-import confirmation, projection closure, Pareto pruning, sampling budgets, and ranking do not prove corruption, a registry, a shared contract, or a required refactor. Inspect the dossier, current code, repeated commits, and explicit contracts before establishing a project defense.
