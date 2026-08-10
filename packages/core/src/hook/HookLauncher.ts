import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type HookDisposition = "advisory" | "enforcing";

export const hookExecutable = (): string => process.env.OPENARCH_BIN ?? "openarch";

export const hookExecutableAvailable = (command: string = hookExecutable(), cwd: string = process.cwd()): boolean => {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command);
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  const directories = [join(cwd, "node_modules", ".bin"), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  return directories.some((directory) => suffixes.some((suffix) => existsSync(join(directory, `${command}${suffix}`))));
};

/** Shared POSIX hook prelude. The caller owns the governance command sequence. */
export const renderHookLauncher = (disposition: HookDisposition, label: string): string => {
  const exitCode = disposition === "advisory" ? 0 : 3;
  return `OPENARCH_BIN="\${OPENARCH_BIN:-openarch}"
if ! command -v "$OPENARCH_BIN" >/dev/null 2>&1 && [ -f "$PWD/node_modules/@openarch/cli/bin/openarch.js" ]; then
  if command -v node >/dev/null 2>&1; then
    openarch_exec() { node "$PWD/node_modules/@openarch/cli/bin/openarch.js" "$@"; }
    OPENARCH_BIN=openarch_exec
  elif command -v node.exe >/dev/null 2>&1; then
    openarch_exec() {
      if command -v wslpath >/dev/null 2>&1; then
        node.exe "$(wslpath -w "$PWD")\\node_modules\\@openarch\\cli\\bin\\openarch.js" "$@"
      elif command -v cygpath >/dev/null 2>&1; then
        node.exe "$(cygpath -w "$PWD")\\node_modules\\@openarch\\cli\\bin\\openarch.js" "$@"
      else
        node.exe "$PWD/node_modules/@openarch/cli/bin/openarch.js" "$@"
      fi
    }
    OPENARCH_BIN=openarch_exec
  fi
fi
if ! command -v "$OPENARCH_BIN" >/dev/null 2>&1; then
  echo "${label} unavailable: executable unavailable ($OPENARCH_BIN)"
  exit ${exitCode}
fi`;
};

/** Narrow shell adapter for the single scalar that controls hook persistence. */
export const renderHookPersistenceResolver = (): string => [
  "OPENARCH_PERSISTENCE=\"$(awk '",
  "  /^[[:space:]]*governance:[[:space:]]*(#.*)?$/ { governance = 1; next }",
  "  governance && /^[^[:space:]#]/ { governance = 0 }",
  "  governance && /^[[:space:]]+persistence:[[:space:]]*/ {",
  "    value = $0",
  "    sub(/^[[:space:]]+persistence:[[:space:]]*/, \"\", value)",
  "    sub(/[[:space:]]+#.*/, \"\", value)",
  "    gsub(/[\"[:space:]]/, \"\", value)",
  "    print value",
  "    exit",
  "  }",
  "' .openarch/config.yml 2>/dev/null)\"",
  "OPENARCH_PERSISTENCE=\"${OPENARCH_PERSISTENCE:-tracked}\"",
  "case \"$OPENARCH_PERSISTENCE\" in",
  "  local|tracked) ;;",
  "  *) echo \"OpenArch code governance unavailable: invalid governance.persistence ($OPENARCH_PERSISTENCE)\"; exit 3 ;;",
  "esac",
].join("\n");

/**
 * Stage only governance *decision artifacts* changed by this hook invocation
 * (B2 2026-08-10): 只暂存决策产物——config.yml 与规则/校准脚本；运行产物
 * （baseline/history/audit/pending/scan-status/document-store.json）不自动暂存，
 * 它们可由 `openarch scan` 幂等重建。`git add` 只针对本次 hook 前后有差异的
 * 决策文件，避免 blanket add 捕获无关工作树漂移。
 */
export const renderGovernanceArtifactStager = (): string => `snapshot_governance_artifacts() (
  # Git Bash process startup is expensive. Bound batches by both file count
  # and command-line size while retaining one content hash per artifact.
  HASH_BATCH_MAX_FILES=32
  HASH_BATCH_MAX_BYTES=8192
  paths_file="$(mktemp)"
  hashes_file="$(mktemp)"
  batch_bytes=0
  batch=()
  trap 'rm -f "$paths_file" "$hashes_file"' EXIT

  flush_hash_batch() {
    [ "\${#batch[@]}" -gt 0 ] || return 0
    git hash-object -- "\${batch[@]}" > "$hashes_file" || return 1
    hash_index=0
    while IFS= read -r hash; do
      [ "$hash_index" -lt "\${#batch[@]}" ] || return 1
      printf '%s\\t%s\\n' "$hash" "\${batch[$hash_index]}"
      hash_index=$((hash_index + 1))
    done < "$hashes_file"
    [ "$hash_index" -eq "\${#batch[@]}" ] || return 1
    batch=()
    batch_bytes=0
  }

  # 决策产物（幂等重建物除外）：配置 + 规则 + 校准样本 + 隐式依赖声明。
  find .openarch -type f \\
    \\( -path "./.openarch/anti-patterns/*" -o -path "./.openarch/test-governance/*" \\
       -o -path "./.openarch/calibration/*" -o -path "./.openarch/implicit-deps*" \\
       -o -name "config.yml" -o -name ".docs-repo-config.json" -o -name "config.yaml" \\) \\
    -print0 > "$paths_file" 2>/dev/null || true
  while IFS= read -r -d '' path; do
    [ -f "$path" ] || continue
    batch+=("$path")
    batch_bytes=$((batch_bytes + \${#path} + 1))
    if [ "\${#batch[@]}" -ge "$HASH_BATCH_MAX_FILES" ] || [ "$batch_bytes" -ge "$HASH_BATCH_MAX_BYTES" ]; then
      flush_hash_batch || exit 1
    fi
  done < "$paths_file"
  flush_hash_batch
)
stage_changed_governance_artifacts() {
  before="$1"
  after="$(mktemp)"
  snapshot_governance_artifacts > "$after"
  while IFS= read -r path; do
    # A concurrent check may reclaim a generated shard after the snapshot.
    [ -e "$path" ] || continue
    git add -- "$path"
  done < <(
    awk -F '\\t' 'NR == FNR { known[$0] = 1; next } !($0 in known) { print $2 }' "$before" "$after"
  )
  while IFS= read -r path; do
    git ls-files --error-unmatch -- "$path" >/dev/null 2>&1 && git add -u -- "$path"
  done < <(
    awk -F '\\t' 'NR == FNR { known[$0] = 1; next } !($0 in known) { print $2 }' "$after" "$before"
  )
  rm -f "$after"
}
GOVERNANCE_ARTIFACTS_BEFORE="$(mktemp)"
snapshot_governance_artifacts > "$GOVERNANCE_ARTIFACTS_BEFORE"
trap 'rm -f "$GOVERNANCE_ARTIFACTS_BEFORE"' EXIT`;
