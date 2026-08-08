package docsrepo

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

// openTestAuthority builds a local-mode (no remote) docs repository and opens
// an Authority over it. Local mode skips fetch/push, so concurrent
// service-owned commits contend only on authority.mu and the git worktree.
func openTestAuthority(t *testing.T) *Authority {
	t.Helper()
	docsRoot := filepath.Join(t.TempDir(), "docs-repo")
	if err := os.MkdirAll(docsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "init", "--initial-branch=main")
	runGitTest(t, docsRoot, "config", "user.name", "Authority Test")
	runGitTest(t, docsRoot, "config", "user.email", "authority-test@example.invalid")
	if err := os.WriteFile(filepath.Join(docsRoot, "README.md"), []byte("# authority\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "add", "README.md")
	runGitTest(t, docsRoot, "commit", "-m", "bootstrap")
	authority, err := Open(
		docsRoot,
		WithRemote(""), // local mode: no origin, commits are shared via the worktree itself
		WithCommitIdentity("Authority Test", "authority-test@example.invalid"),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = authority.Close() })
	return authority
}

const (
	l1bProposalSHA = "73b6c4b02e65ae7deb4f6b681c7f72c6679dea3e7de1cb35d8c863bc52029701"
	l1bHeadSHA     = "20e4982edbc908c3fec8254c9410d91430f98ca5"
)

var l1bSignature = base64.RawStdEncoding.EncodeToString(make([]byte, 64))

func l1bTaskRef() collaborationdomain.TaskRef {
	return collaborationdomain.TaskRef{RepositoryID: "repo-a", ServiceID: "svc-a", TaskID: "task-1"}
}

func l1bVerifiedEvent(t *testing.T, proposalSHA string, headSHA string) collaborationdomain.TaskLifecycleEvent {
	return l1bVerifiedEventFor(t, l1bTaskRef(), proposalSHA, headSHA)
}

func l1bVerifiedEventFor(t *testing.T, task collaborationdomain.TaskRef, proposalSHA string, headSHA string) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "verified",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer", Signature: l1bSignature,
		ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA,
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("verified event invalid: %v", err)
	}
	return event
}

func l1bClaimedEvent(t *testing.T, by string) collaborationdomain.TaskLifecycleEvent {
	return l1bClaimedEventFor(t, l1bTaskRef(), by)
}

func l1bClaimedEventFor(t *testing.T, task collaborationdomain.TaskRef, by string) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "claimed",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer", Signature: l1bSignature,
		ProposalSHA256: l1bProposalSHA, VerifiedHeadSHA: l1bHeadSHA, ClaimedBy: by,
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("claimed event invalid: %v", err)
	}
	return event
}

func l1bCompletedEvent(t *testing.T, by string, headSHA string) collaborationdomain.TaskLifecycleEvent {
	return l1bCompletedEventFor(t, l1bTaskRef(), by, headSHA)
}

func l1bCompletedEventFor(t *testing.T, task collaborationdomain.TaskRef, by string, headSHA string) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "completed",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer", Signature: l1bSignature,
		ProposalSHA256: l1bProposalSHA, VerifiedHeadSHA: l1bHeadSHA,
		CompletedBy: by, CompletedHeadSHA: headSHA,
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("completed event invalid: %v", err)
	}
	return event
}

// TestConcurrentAppendTaskLifecycleNoLossNoDuplicate drives concurrent
// append-only lifecycle events across three distinct tasks (each a full
// verified -> claimed -> completed chain) and asserts every event survives
// exactly once (no loss, no duplicate) under authority.mu.
func TestConcurrentAppendTaskLifecycleNoLossNoDuplicate(t *testing.T) {
	authority := openTestAuthority(t)
	taskRefs := []collaborationdomain.TaskRef{
		{RepositoryID: "repo-a", ServiceID: "svc-a", TaskID: "task-1"},
		{RepositoryID: "repo-a", ServiceID: "svc-a", TaskID: "task-2"},
		{RepositoryID: "repo-b", ServiceID: "svc-b", TaskID: "task-3"},
	}
	var events []collaborationdomain.TaskLifecycleEvent
	for i, task := range taskRefs {
		proposal := l1bProposalSHA[:63] + string(rune('a'+i))
		events = append(events,
			l1bVerifiedEventFor(t, task, proposal, l1bHeadSHA),
			l1bClaimedEventFor(t, task, "agent-a"),
			l1bCompletedEventFor(t, task, "agent-a", l1bHeadSHA),
		)
	}
	var wait sync.WaitGroup
	errs := make(chan error, len(events))
	for _, event := range events {
		wait.Add(1)
		go func(event collaborationdomain.TaskLifecycleEvent) {
			defer wait.Done()
			errs <- authority.AppendTaskLifecycle(context.Background(), event)
		}(event)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent append failed: %v", err)
		}
	}
	for _, task := range taskRefs {
		got, err := authority.readTaskLifecycleAtHead(context.Background(), task)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 3 {
			t.Fatalf("task %s lifecycle events = %d, want 3 (loss or duplicate)", task.TaskID, len(got))
		}
		seen := make(map[string]bool, len(got))
		for _, event := range got {
			key := event.Type + "\x00" + event.VerificationIdentity() + "\x00" + event.ClaimedBy + "\x00" + event.CompletedBy
			if seen[key] {
				t.Fatalf("duplicate lifecycle event persisted: %+v", event)
			}
			seen[key] = true
		}
	}
}

// TestConcurrentIdempotentTaskLifecycleRetry asserts an identical retried
// event (same type + same verification identity) collapses to a single
// persisted record under concurrent submission.
func TestConcurrentIdempotentTaskLifecycleRetry(t *testing.T) {
	authority := openTestAuthority(t)
	event := l1bVerifiedEvent(t, l1bProposalSHA, l1bHeadSHA)
	const workers = 10
	var wait sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs <- authority.AppendTaskLifecycle(context.Background(), event)
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("idempotent retry failed: %v", err)
		}
	}
	got, err := authority.readTaskLifecycleAtHead(context.Background(), l1bTaskRef())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("idempotent retry persisted %d events, want exactly 1", len(got))
	}
}

// TestConcurrentClaimOnSameTaskConverges asserts the intended claim
// uniqueness: concurrent claimed events for the same task collapse to a
// single persisted claimed record (the same type + verification identity is
// an idempotent retry; application-level Claim allows only one claimant in
// the normal flow, and this test locks in the convergence at the authority
// layer so a race cannot produce two claimed records).
func TestConcurrentClaimOnSameTaskConverges(t *testing.T) {
	authority := openTestAuthority(t)
	verified := l1bVerifiedEvent(t, l1bProposalSHA, l1bHeadSHA)
	if err := authority.AppendTaskLifecycle(context.Background(), verified); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errs := make(chan error, 3)
	for _, claimant := range []string{"agent-a", "agent-b", "agent-c"} {
		wait.Add(1)
		go func(claimant string) {
			defer wait.Done()
			errs <- authority.AppendTaskLifecycle(context.Background(), l1bClaimedEvent(t, claimant))
		}(claimant)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent claim failed: %v", err)
		}
	}
	got, err := authority.readTaskLifecycleAtHead(context.Background(), l1bTaskRef())
	if err != nil {
		t.Fatal(err)
	}
	claimed := 0
	for _, event := range got {
		if event.Type == "claimed" {
			claimed++
		}
	}
	if claimed != 1 {
		t.Fatalf("claimed events = %d, want exactly 1 (claim must converge)", claimed)
	}
}

// TestConcurrentDistinctServiceOwnedPathsAllSucceed drives concurrent writes
// to different service-owned paths (evidence vs task events) and asserts both
// survive on HEAD with no torn file.
func TestConcurrentDistinctServiceOwnedPathsAllSucceed(t *testing.T) {
	authority := openTestAuthority(t)
	taskEvents := []collaborationdomain.TaskLifecycleEvent{
		l1bVerifiedEvent(t, l1bProposalSHA, l1bHeadSHA),
		l1bClaimedEvent(t, "agent-a"),
		l1bCompletedEvent(t, "agent-a", l1bHeadSHA),
	}
	path := collaborationdomain.TaskLifecyclePath(l1bTaskRef())
	var wait sync.WaitGroup
	errs := make(chan error, len(taskEvents)+1)
	for _, event := range taskEvents {
		wait.Add(1)
		go func(event collaborationdomain.TaskLifecycleEvent) {
			defer wait.Done()
			errs <- authority.AppendTaskLifecycle(context.Background(), event)
		}(event)
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		errs <- authority.AppendEvidence(context.Background(), sampleEvidence())
	}()
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent distinct-path write failed: %v", err)
		}
	}
	raw, ok, err := authority.Repository().ReadFileAtHead(context.Background(), path)
	if err != nil || !ok {
		t.Fatalf("task events missing on HEAD: ok=%v err=%v", ok, err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != len(taskEvents) {
		t.Fatalf("task event lines = %d, want %d", len(lines), len(taskEvents))
	}
	evidenceRaw, ok, err := authority.Repository().ReadFileAtHead(context.Background(), defaultEvidenceFile)
	if err != nil || !ok {
		t.Fatalf("evidence missing on HEAD: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(string(evidenceRaw), "opaque-distinct") {
		t.Fatalf("evidence content not persisted: %s", evidenceRaw)
	}
}

func sampleEvidence() domain.ValidationEvidence {
	return domain.ValidationEvidence{
		SchemaVersion:   "2",
		ProjectToken:    "opaque-distinct",
		ObservedAt:      time.Now().UTC(),
		Window:          domain.Window{StartedAt: time.Now().UTC().Add(-time.Hour), EndedAt: time.Now().UTC()},
		OpenArchVersion: "0.1.0",
		Languages:       []string{"typescript"},
		Provider:        domain.Provider{ID: "typescript-vitest", Version: "1"},
		RuleID:          "vitest.focused-test",
		AuthorityID:     "vitest-api",
		FindingCount:    2,
		PolicyVerdict:   "WARN",
		EvidenceLevel:   "observed",
	}
}
