# Governance Lifecycle

> “一切实际工作者必须向下调查。” — Mao Zedong, *Rural Surveys* (1941)

Read this page before initialization, persistence, hooks, semantic evidence, DocumentStore, or experience records.

## Initialization And Persistence

`openarch context` is read-only project-fact discovery. It does not refresh the baseline, create evidence, select a workflow, or authorize policy change.

`governance.persistence` in `.openarch/config.yml` is the sole authority. `tracked` stages only decision artifacts (config.yml, anti-patterns/test-governance rules, calibration samples, implicit-deps declarations) changed by the hook; runtime artifacts (baseline/history/audit/pending/scan-status/document-store.json) are never auto-staged — they are idempotently rebuilt by `openarch scan`. `local` manages only OpenArch's block in `.git/info/exclude`. Hooks validate evidence and policy in both modes.

`presentation.locale` selects default CLI presentation and the Skill tree installed by `init --agent` (`zh` or `en`). `--lang` and `OPENARCH_LANG` change CLI presentation for one invocation only; they do not change the Skill, metrics, policy, gate, or JSON contract. Install a Skill only with explicit `init --agent <known>` or `--skill-dir <project-relative-directory>`; never guess an Agent directory or write a user-global directory.

## Structural-policy configuration practice

`structural_policies` rule entries take a **`condition` (CEL expression subset)**, not `n`; `mode` decides adjudication: `enforce` evaluates rules and produces WARN/BLOCK, `observe` only covers a population without evaluating rules (a first calibration "trial" uses `enforce` + `warn`, never an automatic BLOCK). `scope.include/exclude` use minimatch; a single file can be a literal path:

```yaml
structural_policies:
  - id: ts-core
    mode: enforce
    languages: [typescript]
    scope:
      include: ["src/**"]
    rules_warn:
      - name: max-func-branch
        condition: "max_func_branch > 12"
```

**Every production file must match exactly one profile** (zero or multiple matches are both `UNAVAILABLE`; no borrowing from a neighboring language or default threshold); multi-language/multi-service projects must declare every population explicitly. Thresholds are calibrated against **this project's baseline P95**, not portable defaults; `review`'s P95/Top-3 are calibration inputs.

**Run `openarch scan --rebuild` after configuration changes**: incremental scan short-circuits on per-file content `SHA-256`, so `structural_policies`/`file_kinds`/`analysisScope` changes do not trigger recomputation — if the gate still reports `policy_calibration_missing` or uses the old scope after a config edit, run `scan --rebuild` before investigating other causes. Profile id/scope changes also invalidate old calibration and need a rebuild.

`--docs-scope` takes **`<scopeId>=<relative-path>`** (e.g. `example-project=agent`): the scopeId precedes `=`, the path within the document store follows it; a bare value fails validation.

`init` does not auto-detect TypeScript/JavaScript (they have no project indicator files); `languages: []` means "no supported language yet", so `scan` completes 0 files. TS/JS projects must set `languages: [typescript]` manually and re-`scan`.

## Baseline, Evidence, And Hook

`scan` publishes structural baseline facts; only a complete `scan` atomically updates the canonical generation. `check --worktree` and `check --staged` produce replaceable pending after-metric overlays and semantic evidence, never canonical baseline shards. Consumers that describe current state (`gate`, `review`, and graph rebuild) read the complete generation plus an overlay whose source `SHA-256` still matches; scan/evolution consumers read the stable generation only. Pre-commit evaluates the staged candidate projection first, then requires exactly matching paths and `SHA-256` evidence before history can be sealed. A complete scan removes the superseded overlay.

Atomic publication does not prove that a generation is always complete. Readers must validate the index, shard set, path counts and content identity. Missing or corrupt shards, contradictory generations, or an unreadable history marker are `UNAVAILABLE/PARTIAL`, never clean or zero facts. Canonical recovery belongs to a locked complete scan or explicit recovery operation; pre-commit only validates candidates and seals matching evidence.

When structural and test-provider facts were separated, one known legacy baseline identity included `testMetrics`. It remains readable for one migration path and the next complete `scan` republishes the structural identity. Any other identity mismatch remains unavailable; do not bypass validation by deleting shards or weakening the check.

After an interruption, `baseline.staging-*` and `baseline.backup-*` are observable temporary-generation facts: `context --json` reports the active generation, the readable generation, and each artifact's validity and age without moving or deleting anything. `status` renders an old `scan-status.json` running marker as stale. This is an interruption signal, not a failure or clean result; only a complete `scan` may recover or publish under the write lock.

After sealing, the history adapter retains recent raw evidence according to `governance.history.raw_window_days` and compacts older CRL contributions into a mathematically equivalent checkpoint; it never discards the trend merely because it is old. Replaying the checkpoint with retained records equals replaying complete sealed history, and raw files removed from the worktree remain auditable in Git. `_compaction.v1.json` is the crash-recovery logical publication point: readers never double-count, and a later successful run completes physical cleanup. The default window is 180 days; high-frequency projects may configure any positive whole number of days.

### Recovering Corrupt History

History records, `_checkpoint.v1.json`, or `_compaction.v1.json` written by an older version can make `readAllHistory` fail closed after an upgrade. Readers do not skip one record, downgrade to an empty history, or overwrite the original. Recover in this order:

1. Copy the entire `.openarch/history/` directory to an external recovery location and preserve the reported path, commit, and time; do not delete or rename the bad file just to obtain `PASS`.
2. For `tracked` projects, use `git log -- .openarch/history` to find the last known-good commit, then restore the affected file with `git restore --source=<known-good-commit> -- .openarch/history/<file>`. Treat a checkpoint, compaction marker, and every raw entry it lists as one publication set; do not restore only one marker.
3. For `local` projects, restore from an external backup. If no verifiable copy exists, do not fabricate JSON or silently discard the bad entry. Historical CRL is `UNAVAILABLE`, not zero or clean.
4. After recovery, rerun `openarch review` or `openarch check` to verify readability. If only the structural baseline needs rebuilding, run `openarch scan` separately; `scan` cannot reconstruct missing historical CRL.

Do not delete pending evidence, baseline fragments, history, or audit output to manufacture a clean commit. Identical checks must be idempotent. Investigate content identity, time, adapter contract, reachability, and reconciliation before changing a hook or adding an exception.

Regardless of persistence mode, `pending/`, `scan-status.json`, and lock files are replaceable runtime state. `init` maintains this minimal ignore set in the project's `.openarch/.gitignore`, so a nested project never relies on its parent Git root's ignore rules. Auditable baseline, history, and audit artifacts still follow `persistence`.

## Documents And Experience

Resolve the DocumentStore before editing. A project-local store is `docs/openarch`; a shared store needs an explicit `scope-id` and may read only its bound `scopeRoot`. A missing binding is `UNAVAILABLE`, not permission to scan neighboring projects.

When the current project owns a public capability, workflow, provider, or script contract, update that project's `CORE-CAPABILITIES.md` and run `openarch docs check --changed <path>`. An integrated project does not maintain OpenArch's product capability inventory or release documentation; report a product change upstream. Record with `docs record --category patterns|anti_patterns|decisions` only after a verifiable review. Write the document before checking similarity. See [record-guide.md](../record-guide.md) for categories and writing requirements.

## Upgrades And Skill Re-equipment

When CLI behavior diverges from what this Skill describes, or command output contradicts recorded experience, first run `openarch update --json`: it read-only compares the installed version against the release branch, prints current/latest versions and upgrade steps, and never auto-installs. Upgrading is an explicit user action (rebuild the binary per INSTALL.md); afterwards re-run `openarch init --agent <target>` at the project root to atomically refresh the Skill (retired files are cleared), then confirm governance readiness with `openarch context`. When building external integrations, treat the `openarch contract --json` catalog as the single authority: breaking changes bump the version and plugins fail closed on unknown versions — never guess compatibility from payload fields.
