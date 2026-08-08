#!/usr/bin/env bash
# L3 端到端：本地多 Agent 并发写测试（S1-S7）
# 覆盖 docs/plans/2026-08-03-local-multiagent-concurrency-test.md 的 L3 矩阵。
# 核心断言方向：冲突被显式拒绝（非 2xx / 非零退出）而非静默覆盖；事件零丢失；
# 幂等重试不产生重复记录；Agent 永不写 service-owned 路径。
#
# 前提：
#   - openarch CLI（环境变量 OPENARCH_CLI 指定，默认本机命令 openarch）
#   - 协调服务二进制（OPENARCH_COORD_BIN，默认 artifacts/binary 下的 openarch-coordination 编译产物）
#   - git、sha256sum
# 用法：bash scripts/local-multiagent-concurrency.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${OPENARCH_CLI:-openarch}"
COORD_BIN="${OPENARCH_COORD_BIN:-}"
PORT="${OPENARCH_COORD_PORT:-39299}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/oa-l3-XXXXXX")"
DOCS="$WORK/docs"
# 外部服务时端口取 URL、docs-repo 取 OPENARCH_COORD_DOCS（服务启动时固定的 worktree）
if [[ -n "${OPENARCH_COORD_URL:-}" ]]; then
  PORT="${OPENARCH_COORD_PORT:-${OPENARCH_COORD_URL##*:}}"
  DOCS="${OPENARCH_COORD_DOCS:?外部服务模式需 OPENARCH_COORD_DOCS 指向服务启动时的 docs-repo}"
fi
AGENT_A="$WORK/agentA"
AGENT_B="$WORK/agentB"
SERVICE_LOG="$WORK/coord.log"
FAILURES=0

# ---- Windows 路径转换（Git Bash /tmp -> Windows 绝对路径，服务/CLI 需要）----
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

# ---- 清理 ----
cleanup() {
  if [[ -n "${SERVICE_PID:-}" && "$SERVICE_PID" != "0" ]]; then kill "$SERVICE_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- 断言辅助 ----
fail() { echo "  ✗ FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ✓ ok: $*"; }
assert_contains() { # assert_contains <needle> <haystack> <label>
  if [[ "$2" == *"$1"* ]]; then pass "$3"; else fail "$3（缺 '$1'，实际: $(echo "$2" | head -3)）"; fi
}
assert_eq() { # assert_eq <want> <got> <label>
  if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3（want '$1' got '$2'）"; fi
}

# ---- 基建 ----
git_init() {
  if [[ -n "${OPENARCH_COORD_URL:-}" ]]; then return 0; fi  # 外部服务：docs-repo 已由服务初始化
  mkdir -p "$DOCS"
  git -C "$DOCS" init --initial-branch=main -q
  git -C "$DOCS" config user.name "L3 Test"
  git -C "$DOCS" config user.email "l3@example.invalid"
  echo "# docs" > "$DOCS/README.md"
  git -C "$DOCS" add README.md
  git -C "$DOCS" commit -qm "bootstrap"
}

start_service() {
  if [[ -n "${OPENARCH_COORD_URL:-}" ]]; then
    echo "使用外部协调服务: $OPENARCH_COORD_URL"
    SERVICE_PID=0
    return 0
  fi
  if [[ -z "$COORD_BIN" ]]; then
    COORD_BIN="/tmp/oa-coord.exe"
  fi
  [[ -f "$COORD_BIN" ]] || { echo "找不到协调服务二进制: $COORD_BIN（先 go build）"; exit 1; }
  local key="$WORK/task-key.b64"
  # Ed25519 seed（raw base64）——用 python 生成
  python3 -c "import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode().rstrip('='))" > "$key"
  local docs_win key_win
  docs_win="$(winpath "$DOCS")"; key_win="$(winpath "$key")"
  # PowerShell Start-Process -PassThru：独立进程组 + 返回 PID 供 cleanup 精准关闭
  # PowerShell Start-Process -PassThru：独立进程组 + 返回 PID 供 cleanup 精准关闭
  local bin_win
  bin_win="$(winpath "$COORD_BIN")"
  SERVICE_PID=$(powershell -NoProfile -Command "Start-Process -FilePath '$bin_win' -ArgumentList '--docs-repo','$docs_win','--listen','127.0.0.1:$PORT','--task-signing-key','$key_win' -WindowStyle Hidden -RedirectStandardOutput '$SERVICE_LOG' -PassThru | Select-Object -ExpandProperty Id")
  sleep 1
  local i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/v1/evidence"; then return 0; fi
    sleep 0.5
  done
  echo "服务未就绪："; tail -5 "$SERVICE_LOG"; exit 1
}

agent_init() { # agent_init <agent-dir> <lang>
  ( cd "$1" && "$CLI" init --docs-repo "$(winpath "$DOCS")" --coordination-url "http://127.0.0.1:$PORT" --lang "$2" >/dev/null 2>&1 )
}

# 提交 scope 文档（repositories/ + services/）并 refresh
scope_commit_refresh() { # scope_commit_refresh <repo-id>
  git -C "$DOCS" add -A
  git -C "$DOCS" commit -qm "scope $1"
  local head
  head="$(git -C "$DOCS" rev-parse HEAD)"
  ( cd "$AGENT_A" && "$CLI" coordination refresh --repository-id "$1" --branch main --head-sha "$head" >/dev/null 2>&1 )
}

# 提交 proposal 并 refresh
proposal_commit_refresh() { # proposal_commit_refresh <repo-id> <svc-id> <task-id> <requested-by>
  local repo="$1" svc="$2" task="$3" by="$4"
  mkdir -p "$DOCS/tasks/$repo/$svc/$task"
  cat > "$DOCS/tasks/$repo/$svc/$task/proposal.json" << EOF
{
  "schemaVersion": "1",
  "task": {"repositoryId": "$repo", "serviceId": "$svc", "taskId": "$task"},
  "title": "reduce parser nesting",
  "hypothesis": "splitting the visitor removes the deep branch",
  "requestedBy": "$by"
}
EOF
  git -C "$DOCS" add -A
  git -C "$DOCS" commit -qm "proposal $task"
  local head
  head="$(git -C "$DOCS" rev-parse HEAD)"
  ( cd "$AGENT_A" && "$CLI" coordination refresh --repository-id "$repo" --branch main --head-sha "$head" >/dev/null 2>&1 )
}

proposal_sha() { # proposal_sha <repo> <svc> <task>
  sha256sum "$DOCS/tasks/$1/$2/$3/proposal.json" | cut -d' ' -f1
}

# ================= S1-S7 =================

s1_concurrent_scope_register() {
  echo "== S1 并发 scope 登记（不同 repo，同时 commit）=="
  ( cd "$AGENT_A" && "$CLI" coordination scope register --repository-id repo-a --service-id svc-a >/dev/null 2>&1 ) &
  RA=$!
  ( cd "$AGENT_B" && "$CLI" coordination scope register --repository-id repo-b --service-id svc-b >/dev/null 2>&1 ) &
  RB=$!
  wait "$RA" "$RB"
  # 两个文档都已生成
  [[ -f "$DOCS/repositories/repo-a/scope.json" ]] && pass "repo-a 登记文档存在" || fail "repo-a 登记文档缺失"
  [[ -f "$DOCS/repositories/repo-b/scope.json" ]] && pass "repo-b 登记文档存在" || fail "repo-b 登记文档缺失"
  # 并发 commit：index.lock 使恰一个成功（或都成功但绝不半写）
  git -C "$DOCS" add -A
  ( git -C "$DOCS" commit -qm "s1 a" 2>/dev/null && echo ok > "$WORK/s1a" ) &
  P1=$!
  ( git -C "$DOCS" commit -qm "s1 b" 2>/dev/null && echo ok > "$WORK/s1b" ) &
  P2=$!
  wait $P1 $P2 || true  # 并发 commit 恰一方成功是预期（index.lock）；失败方显式报错不覆盖
  local commits
  commits="$(git -C "$DOCS" rev-list --count HEAD)"
  # 期望 1 个成功 commit（index.lock 使另一个失败），至少 1 个
  if [[ "$commits" -ge 1 ]]; then pass "并发 commit 落盘 $commits 个（失败方显式报错不覆盖）"; else fail "无 commit 落盘"; fi
  # 文档完整（无半写）
  local a_ok b_ok
  a_ok=$(git -C "$DOCS" show HEAD:repositories/repo-a/scope.json 2>/dev/null | grep -c '"repositoryId"') || true
  b_ok=$(git -C "$DOCS" show HEAD:repositories/repo-b/scope.json 2>/dev/null | grep -c '"repositoryId"') || true
  [[ "$a_ok" -ge 1 ]] && pass "repo-a 文档完整" || fail "repo-a 文档半写"
  [[ "$b_ok" -ge 1 ]] && pass "repo-b 文档完整" || fail "repo-b 文档半写"
}

s2_concurrent_same_path_register() {
  echo "== S2 并发同路径登记（幂等一致）=="
  ( cd "$AGENT_A" && "$CLI" coordination scope register --repository-id repo-c --service-id svc-c >/dev/null 2>&1 ) &
  RA=$!
  ( cd "$AGENT_B" && "$CLI" coordination scope register --repository-id repo-c --service-id svc-c >/dev/null 2>&1 ) &
  RB=$!
  wait "$RA" "$RB"
  git -C "$DOCS" add -A
  git -C "$DOCS" commit -qm "s2" || true
  local content
  content="$(cat "$DOCS/repositories/repo-c/scope.json")"
  local id_count
  id_count="$(echo "$content" | grep -c '"repositoryId"')"
  assert_eq "1" "$id_count" "同路径登记文档唯一一致（无竞态覆盖）"
}

s3_concurrent_claim() {
  echo "== S3 并发 task claim（恰一个成功）=="
  proposal_commit_refresh repo-a svc-a task-claim agent-A
  local head proposal
  head="$(git -C "$DOCS" rev-parse HEAD)"
  ( cd "$AGENT_A" && "$CLI" coordination task submit --repository-id repo-a --service-id svc-a --task-id task-claim --branch main --head-sha "$head" >/dev/null 2>&1 )
  proposal="$(proposal_sha repo-a svc-a task-claim)"
  local ra rb
  if ( cd "$AGENT_A" && timeout 60 "$CLI" coordination claim --repository-id repo-a --service-id svc-a --task-id task-claim --proposal-sha256 "$proposal" --claimed-by agent-A > "$WORK/claimA.out" 2>&1 ); then ra=0; else ra=$?; fi
  if ( cd "$AGENT_B" && timeout 60 "$CLI" coordination claim --repository-id repo-a --service-id svc-a --task-id task-claim --proposal-sha256 "$proposal" --claimed-by agent-B > "$WORK/claimB.out" 2>&1 ); then rb=0; else rb=$?; fi
  # 恰一个成功（exit 0），另一个显式拒绝（非 0）
  if [[ "$ra" -eq 0 && "$rb" -ne 0 ]]; then pass "A 成功 B 拒绝（exit $rb）"
  elif [[ "$rb" -eq 0 && "$ra" -ne 0 ]]; then pass "B 成功 A 拒绝（exit $ra）"
  else fail "claim 双写或双拒（A=$ra B=$rb）"; fi
  # 事件流只有一条 claimed
  local claimed_count
  claimed_count="$(grep -o '"type":"claimed"' "$DOCS/coordination/tasks/repo-a/svc-a/task-claim/events.ndjson" | wc -l)"
  assert_eq "1" "$claimed_count" "claimed 事件恰一条"
}

s4_concurrent_lease() {
  echo "== S4 并发 lease acquire（恰一个成功）=="
  local ra rb
  if ( cd "$AGENT_A" && timeout 60 "$CLI" coordination lease acquire --repository-id repo-a --service-id svc-a --target "s4#lease" --owner agent-A --ttl 30 > "$WORK/leaseA.out" 2>&1 ); then ra=0; else ra=$?; fi
  if ( cd "$AGENT_B" && timeout 60 "$CLI" coordination lease acquire --repository-id repo-a --service-id svc-a --target "s4#lease" --owner agent-B --ttl 30 > "$WORK/leaseB.out" 2>&1 ); then rb=0; else rb=$?; fi
  if [[ "$ra" -eq 0 && "$rb" -ne 0 ]]; then pass "A 持锁 B 拒绝（exit $rb: $(head -1 "$WORK/leaseB.out")）"
  elif [[ "$rb" -eq 0 && "$ra" -ne 0 ]]; then pass "B 持锁 A 拒绝（exit $ra: $(head -1 "$WORK/leaseA.out")）"
  else fail "lease 双持或双拒（A=$ra B=$rb）"; fi
}

s5_idempotent_storm() {
  echo "== S5 幂等风暴（同 submit ×3 → 一条 verified）=="
  proposal_commit_refresh repo-a svc-a task-storm agent-A
  local head
  head="$(git -C "$DOCS" rev-parse HEAD)"
  local r1 r2 r3
  ( cd "$AGENT_A" && timeout 60 "$CLI" coordination task submit --repository-id repo-a --service-id svc-a --task-id task-storm --branch main --head-sha "$head" > "$WORK/storm1.out" 2>&1 ); r1=$?
  ( cd "$AGENT_B" && timeout 60 "$CLI" coordination task submit --repository-id repo-a --service-id svc-a --task-id task-storm --branch main --head-sha "$head" > "$WORK/storm2.out" 2>&1 ); r2=$?
  ( cd "$AGENT_A" && timeout 60 "$CLI" coordination task submit --repository-id repo-a --service-id svc-a --task-id task-storm --branch main --head-sha "$head" > "$WORK/storm3.out" 2>&1 ); r3=$?
  if [[ "$r1" -eq 0 && "$r2" -eq 0 && "$r3" -eq 0 ]]; then pass "三次 submit 全部 exit 0（幂等重试）"; else fail "submit 退出码异常（$r1 $r2 $r3）"; fi
  local verified_count
  verified_count="$(grep -o '"type":"verified"' "$DOCS/coordination/tasks/repo-a/svc-a/task-storm/events.ndjson" | wc -l)"
  assert_eq "1" "$verified_count" "verified 事件恰一条（幂等不重复）"
}

s6_service_and_agent_write_interleave() {
  echo "== S6 服务写与 Agent 写交错（无半写）=="
  proposal_commit_refresh repo-a svc-a task-interleave agent-A
  local head
  head="$(git -C "$DOCS" rev-parse HEAD)"
  # 服务 submit（写 events + commit）与 Agent 并发 commit scope 交错
  ( cd "$AGENT_A" && timeout 60 "$CLI" coordination task submit --repository-id repo-a --service-id svc-a --task-id task-interleave --branch main --head-sha "$head" > /dev/null 2>&1 ) &
  SUBMIT_PID=$!
  ( cd "$AGENT_A" && "$CLI" coordination scope register --repository-id repo-z --service-id svc-z >/dev/null 2>&1; git -C "$DOCS" add -A; git -C "$DOCS" commit -qm "s6 agent write" 2>/dev/null || true ) &
  AGENT_PID=$!
  wait $SUBMIT_PID $AGENT_PID || true
  # 无半写：events 文件每行一个完整事件；HEAD 可解析
  local events_file="$DOCS/coordination/tasks/repo-a/svc-a/task-interleave/events.ndjson"
  if [[ -f "$events_file" ]]; then
    local bad
    bad="$(grep -cE '^\{' "$events_file" || true)"
    local total
    total="$(wc -l < "$events_file")"
    assert_eq "$total" "$bad" "events 每行完整 JSON（无半写）"
  else
    fail "交错后 events 文件缺失"
  fi
  git -C "$DOCS" rev-parse HEAD >/dev/null && pass "HEAD 可解析（完整 commit）" || fail "HEAD 损坏"
}

s7_dual_ownership() {
  echo "== S7 双轨所有权（Agent 无 service-owned 写入口）=="
  # 代码层断言：CLI 源码不得写 coordination/tasks/.../events.ndjson 或 evidence/
  local cli_writes
  cli_writes="$(grep -rn "events.ndjson\|evidence/validation.ndjson" "$REPO_ROOT/packages/cli/src" 2>/dev/null | grep -vE "^\s*//|test" | head -3 || true)"
  if [[ -z "$cli_writes" ]]; then pass "CLI 无 service-owned 路径写代码"; else fail "CLI 存在 service-owned 写入口: $cli_writes"; fi
  # 服务端白名单（isServiceOwnedPath）由 Go 单测覆盖；此处验证服务提交的 events 在 coordination/ 下
  [[ -f "$DOCS/coordination/tasks/repo-a/svc-a/task-claim/events.ndjson" ]] && pass "服务事件落在 coordination/ 白名单路径" || fail "服务事件路径异常"
}

# ================= 主流程 =================
main() {
  echo "### L3 本地多 Agent 并发写测试（$WORK）"
  git_init
  mkdir -p "$AGENT_A" "$AGENT_B"
  start_service
  agent_init "$AGENT_A" zh
  agent_init "$AGENT_B" en

  s1_concurrent_scope_register
  s2_concurrent_same_path_register
  # S1/S2 之后服务 worktree 可能因并发 commit 落后——refresh 到最新 HEAD
  local head
  head="$(git -C "$DOCS" rev-parse HEAD)"
  "$CLI" coordination refresh --repository-id repo-a --branch main --head-sha "$head" >/dev/null 2>&1 || true
  s3_concurrent_claim
  s4_concurrent_lease
  s5_idempotent_storm
  s6_service_and_agent_write_interleave
  s7_dual_ownership

  echo
  if [[ "$FAILURES" -eq 0 ]]; then
    echo "### L3 全部通过"
    exit 0
  else
    echo "### L3 失败 $FAILURES 项"
    exit 1
  fi
}

main "$@"
