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

func openRemoteTestAuthority(t *testing.T) (*Authority, string) {
	t.Helper()
	tempDir := t.TempDir()
	docsRoot := filepath.Join(tempDir, "docs-repo")
	remoteRoot := filepath.Join(tempDir, "remote.git")
	if err := os.MkdirAll(docsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "init", "--initial-branch=main")
	runGitTest(t, docsRoot, "config", "user.name", "Remote Authority Test")
	runGitTest(t, docsRoot, "config", "user.email", "remote-authority-test@example.invalid")
	if err := os.WriteFile(filepath.Join(docsRoot, "README.md"), []byte("# remote authority\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "add", "README.md")
	runGitTest(t, docsRoot, "commit", "-m", "bootstrap")
	runGitTest(t, tempDir, "init", "--bare", remoteRoot)
	runGitTest(t, docsRoot, "remote", "add", "origin", remoteRoot)
	runGitTest(t, docsRoot, "push", "-u", "origin", "main")
	runGitTest(t, remoteRoot, "symbolic-ref", "HEAD", "refs/heads/main")
	authority, err := Open(
		docsRoot,
		WithRemote("origin"),
		WithCommitIdentity("Remote Authority Test", "remote-authority-test@example.invalid"),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = authority.Close() })
	return authority, remoteRoot
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

func l1bVerifiedEventFor(t *testing.T, task collaborationdomain.TaskRef, proposalSHA string, headSHA string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "verified",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer",
		ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA,
	}
	if err := collaborationdomain.LinkLifecycleEvent(existing, &event); err != nil {
		t.Fatalf("link verified event: %v", err)
	}
	hash, err := event.ComputeEventHash()
	if err != nil {
		t.Fatalf("hash verified event: %v", err)
	}
	event.EventHash = hash
	event.Signature = l1bSignature
	if err := event.Validate(); err != nil {
		t.Fatalf("verified event invalid: %v", err)
	}
	return event
}

func l1bClaimedEvent(t *testing.T, by string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	return l1bClaimedEventFor(t, l1bTaskRef(), by, existing...)
}

func l1bClaimedEventFor(t *testing.T, task collaborationdomain.TaskRef, by string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "claimed",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer",
		ProposalSHA256: l1bProposalSHA, VerifiedHeadSHA: l1bHeadSHA, ClaimedBy: by,
	}
	if err := collaborationdomain.LinkLifecycleEvent(existing, &event); err != nil {
		t.Fatalf("link claimed event: %v", err)
	}
	hash, err := event.ComputeEventHash()
	if err != nil {
		t.Fatalf("hash claimed event: %v", err)
	}
	event.EventHash = hash
	event.Signature = l1bSignature
	if err := event.Validate(); err != nil {
		t.Fatalf("claimed event invalid: %v", err)
	}
	return event
}

func l1bCompletedLocalEvent(t *testing.T, by string, localHeadSHA string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	return l1bCompletedLocalEventFor(t, l1bTaskRef(), by, localHeadSHA, existing...)
}

func l1bCompletedLocalEventFor(t *testing.T, task collaborationdomain.TaskRef, by string, localHeadSHA string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "completed_local",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer",
		ProposalSHA256: l1bProposalSHA, VerifiedHeadSHA: l1bHeadSHA,
		CompletedBy: by, LeaseID: "lease-1", LocalHeadSHA: localHeadSHA,
	}
	if err := collaborationdomain.LinkLifecycleEvent(existing, &event); err != nil {
		t.Fatalf("link completed_local event: %v", err)
	}
	hash, err := event.ComputeEventHash()
	if err != nil {
		t.Fatalf("hash completed_local event: %v", err)
	}
	event.EventHash = hash
	event.Signature = l1bSignature
	if err := event.Validate(); err != nil {
		t.Fatalf("completed_local event invalid: %v", err)
	}
	return event
}

func l1bCompletedEvent(t *testing.T, by string, headSHA string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	return l1bCompletedEventFor(t, l1bTaskRef(), by, headSHA, existing...)
}

func l1bCompletedEventFor(t *testing.T, task collaborationdomain.TaskRef, by string, headSHA string, existing ...collaborationdomain.TaskLifecycleEvent) collaborationdomain.TaskLifecycleEvent {
	t.Helper()
	event := collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: task, Type: "completed",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer",
		ProposalSHA256: l1bProposalSHA, VerifiedHeadSHA: l1bHeadSHA,
		CompletedBy: by, LeaseID: "lease-1", CompletedHeadSHA: headSHA,
	}
	if err := collaborationdomain.LinkLifecycleEvent(existing, &event); err != nil {
		t.Fatalf("link completed event: %v", err)
	}
	hash, err := event.ComputeEventHash()
	if err != nil {
		t.Fatalf("hash completed event: %v", err)
	}
	event.EventHash = hash
	event.Signature = l1bSignature
	if err := event.Validate(); err != nil {
		t.Fatalf("completed event invalid: %v", err)
	}
	return event
}

// TestAppendTaskLifecycleCompletesWithCanceledContext guards against a client
// disconnect leaving the shared docs-repo staged but uncommitted: the
// service-owned mutation must finish even when the request context is already
// canceled.
func TestAppendTaskLifecycleCompletesWithCanceledContext(t *testing.T) {
	authority := openTestAuthority(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	verified := l1bVerifiedEvent(t, l1bProposalSHA, l1bHeadSHA)
	if err := authority.AppendTaskLifecycle(ctx, verified); err != nil {
		t.Fatalf("AppendTaskLifecycle with canceled context: %v", err)
	}
	status := runGitTest(t, authority.Root(), "status", "--porcelain")
	if strings.TrimSpace(status) != "" {
		t.Fatalf("docs-repo left dirty after canceled-context write:\n%s", status)
	}
	payload := runGitTest(t, authority.Root(), "show", "HEAD:"+collaborationdomain.TaskLifecyclePath(l1bTaskRef()))
	if !strings.Contains(payload, `"type":"verified"`) {
		t.Fatalf("verified event not committed at HEAD:\n%s", payload)
	}
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
	type taskChain struct {
		verified       collaborationdomain.TaskLifecycleEvent
		claimed        collaborationdomain.TaskLifecycleEvent
		completedLocal collaborationdomain.TaskLifecycleEvent
		completed      collaborationdomain.TaskLifecycleEvent
	}
	chains := make([]taskChain, 0, len(taskRefs))
	for _, task := range taskRefs {
		verified := l1bVerifiedEventFor(t, task, l1bProposalSHA, l1bHeadSHA)
		claimed := l1bClaimedEventFor(t, task, "agent-a", verified)
		completedLocal := l1bCompletedLocalEventFor(t, task, "agent-a", l1bHeadSHA, verified, claimed)
		completed := l1bCompletedEventFor(t, task, "agent-a", l1bHeadSHA, verified, claimed, completedLocal)
		chains = append(chains, taskChain{verified: verified, claimed: claimed, completedLocal: completedLocal, completed: completed})
	}
	appendAll := func(events []collaborationdomain.TaskLifecycleEvent) {
		t.Helper()
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
	}
	appendAll([]collaborationdomain.TaskLifecycleEvent{
		chains[0].verified, chains[1].verified, chains[2].verified,
	})
	appendAll([]collaborationdomain.TaskLifecycleEvent{
		chains[0].claimed, chains[1].claimed, chains[2].claimed,
	})
	appendAll([]collaborationdomain.TaskLifecycleEvent{
		chains[0].completedLocal, chains[1].completedLocal, chains[2].completedLocal,
	})
	appendAll([]collaborationdomain.TaskLifecycleEvent{
		chains[0].completed, chains[1].completed, chains[2].completed,
	})
	for _, task := range taskRefs {
		got, err := authority.readTaskLifecycleAtHead(context.Background(), task)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 4 {
			t.Fatalf("task %s lifecycle events = %d, want 4 (loss or duplicate)", task.TaskID, len(got))
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
			errs <- authority.AppendTaskLifecycle(context.Background(), l1bClaimedEvent(t, claimant, verified))
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
	verified := l1bVerifiedEvent(t, l1bProposalSHA, l1bHeadSHA)
	taskEvents := []collaborationdomain.TaskLifecycleEvent{verified}
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

func TestRemoteServiceWriteSyncsBeforeCommit(t *testing.T) {
	authority, remoteRoot := openRemoteTestAuthority(t)
	agentClone := filepath.Join(t.TempDir(), "agent-clone")
	runGitTest(t, t.TempDir(), "clone", remoteRoot, agentClone)
	runGitTest(t, agentClone, "config", "user.name", "Agent")
	runGitTest(t, agentClone, "config", "user.email", "agent@example.invalid")
	if err := os.WriteFile(filepath.Join(agentClone, "agent-note.md"), []byte("agent advance\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, agentClone, "add", "agent-note.md")
	runGitTest(t, agentClone, "commit", "-m", "agent: advance remote")
	runGitTest(t, agentClone, "push", "origin", "main")

	if err := authority.AppendEvidence(context.Background(), sampleEvidence()); err != nil {
		t.Fatalf("AppendEvidence after remote advance failed: %v", err)
	}
	remoteEvidence := runGitTest(t, remoteRoot, "show", "main:evidence/validation.ndjson")
	if !strings.Contains(remoteEvidence, "opaque-distinct") {
		t.Fatalf("remote evidence missing after sync-and-write: %q", remoteEvidence)
	}
	remoteAgentNote := runGitTest(t, remoteRoot, "show", "main:agent-note.md")
	if !strings.Contains(remoteAgentNote, "agent advance") {
		t.Fatalf("agent advance was lost after service write: %q", remoteAgentNote)
	}
}

func TestRemotePublishOwnedFileRebasesOnPushConflict(t *testing.T) {
	authority, remoteRoot := openRemoteTestAuthority(t)
	agentClone := filepath.Join(t.TempDir(), "agent-clone")
	runGitTest(t, t.TempDir(), "clone", remoteRoot, agentClone)
	runGitTest(t, agentClone, "config", "user.name", "Agent")
	runGitTest(t, agentClone, "config", "user.email", "agent@example.invalid")
	if err := os.WriteFile(filepath.Join(agentClone, "agent-note.md"), []byte("agent advance\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, agentClone, "add", "agent-note.md")
	runGitTest(t, agentClone, "commit", "-m", "agent: advance remote")
	runGitTest(t, agentClone, "push", "origin", "main")

	// Bypass prepareOwnedMutation so the service commits on its stale local HEAD
	// and the subsequent push must rebase onto the agent-advanced remote.
	payload := []byte("{\"schemaVersion\":\"2\",\"projectToken\":\"opaque-rebase\",\"observedAt\":\"2026-08-22T00:00:00Z\",\"window\":{\"startedAt\":\"2026-08-22T00:00:00Z\",\"endedAt\":\"2026-08-22T01:00:00Z\"},\"openarchVersion\":\"0.1.0\",\"languages\":[\"typescript\"],\"provider\":{\"id\":\"typescript-vitest\",\"version\":\"1\"},\"ruleId\":\"vitest.focused-test\",\"authorityId\":\"vitest-api\",\"findingCount\":2,\"policyVerdict\":\"WARN\",\"evidenceLevel\":\"observed\"}\n")
	if err := authority.publishOwnedFile(context.Background(), defaultEvidenceFile, payload, "coordination: rebase evidence"); err != nil {
		t.Fatalf("publishOwnedFile with push conflict failed: %v", err)
	}
	remoteEvidence := runGitTest(t, remoteRoot, "show", "main:evidence/validation.ndjson")
	if !strings.Contains(remoteEvidence, "opaque-rebase") {
		t.Fatalf("rebased evidence missing on remote: %q", remoteEvidence)
	}
	remoteAgentNote := runGitTest(t, remoteRoot, "show", "main:agent-note.md")
	if !strings.Contains(remoteAgentNote, "agent advance") {
		t.Fatalf("agent advance was lost after rebase: %q", remoteAgentNote)
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
