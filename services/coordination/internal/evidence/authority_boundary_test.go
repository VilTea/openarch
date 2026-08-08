package evidence_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
)

func TestAuthorityRequiresSynchronizedGitWorktree(t *testing.T) {
	if _, err := docsrepo.Open(filepath.Join(t.TempDir(), "not-a-repository")); err == nil {
		t.Fatal("Open accepted a non-Git authority worktree")
	}

	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	runGit(t, docsRoot, "commit", "--allow-empty", "-m", "local only")
	if _, err := docsrepo.Open(docsRoot); err == nil {
		t.Fatal("Open accepted an authority worktree ahead of its remote")
	}
}


func TestAuthorityRequiresConfiguredBranchToBeCheckedOut(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	if _, err := docsrepo.Open(docsRoot, docsrepo.WithBranch("other")); err == nil {
		t.Fatal("Open accepted an authority branch that is not checked out")
	}
}


func TestAuthorityRejectsUncommittedEvidenceFile(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()

	evidencePath := filepath.Join(docsRoot, "evidence", "validation.ndjson")
	if err := os.MkdirAll(filepath.Dir(evidencePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(evidencePath, []byte("untracked evidence\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := authority.AppendEvidence(context.Background(), sample("opaque-a")); err == nil {
		t.Fatal("AppendEvidence accepted an uncommitted evidence file")
	}
}


func TestConcurrentServiceWritesSerializeAndAdvanceHead(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(
		docsRoot,
		docsrepo.WithCommitIdentity("Evidence Test", "evidence-test@example.invalid"),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	service := application.NewService(authority, projection, nil)

	beforeRaw := runGit(t, docsRoot, "rev-list", "--count", "HEAD")
	before, err := strconv.Atoi(beforeRaw)
	if err != nil {
		t.Fatalf("parse before commit count %q: %v", beforeRaw, err)
	}
	var wait sync.WaitGroup
	errs := make(chan error, 10)
	for i := 0; i < 5; i++ {
		wait.Add(2)
		go func(i int) {
			defer wait.Done()
			ev := sample(fmt.Sprintf("opaque-%d", i))
			errs <- service.IngestEvidence(context.Background(), ev)
		}(i)
		go func(i int) {
			defer wait.Done()
			errs <- authority.AppendTaskLifecycle(context.Background(), l2VerifiedEvent(fmt.Sprintf("task-%d", i)))
		}(i)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent service write failed: %v", err)
		}
	}
	afterRaw := runGit(t, docsRoot, "rev-list", "--count", "HEAD")
	after, err := strconv.Atoi(afterRaw)
	if err != nil {
		t.Fatalf("parse after commit count %q: %v", afterRaw, err)
	}
	// Each accepted write is its own commit: 5 evidence + 5 task events.
	if after != before+10 {
		t.Fatalf("HEAD advanced by %d commits, want 10 (serialized writes, no lost commits)", after-before)
	}
	// No event lost: all five task event files exist with one verified event each.
	for i := 0; i < 5; i++ {
		path := collaborationdomain.TaskLifecyclePath(l2TaskRef(fmt.Sprintf("task-%d", i)))
		raw, ok, err := authority.Repository().ReadFileAtHead(context.Background(), path)
		if err != nil || !ok {
			t.Fatalf("task-%d events missing: ok=%v err=%v", i, ok, err)
		}
		if lines := strings.Count(strings.TrimSpace(string(raw)), "\n") + 1; lines != 1 {
			t.Fatalf("task-%d event lines = %d, want 1", i, lines)
		}
	}
	// Remote truth: bare repo advanced too (every commit pushed under mu).
	remoteHead := runGitDir(t, remoteRoot, "rev-parse", "main")
	localHead := runGit(t, docsRoot, "rev-parse", "HEAD")
	if remoteHead != localHead {
		t.Fatalf("remote head %s != local head %s (push race)", remoteHead[:8], localHead[:8])
	}
}
