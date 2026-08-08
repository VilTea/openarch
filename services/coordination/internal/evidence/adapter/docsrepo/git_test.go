package docsrepo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRedactRemoteURLRemovesCredentials(t *testing.T) {
	if got := redactRemoteURL("https://agent:secret@example.invalid/openarch/docs.git"); got != "https://example.invalid/openarch/docs.git" {
		t.Fatalf("redacted URL = %q", got)
	}
	if got := redactRemoteURL("git@github.com:openarch/docs.git"); got != "git@github.com:openarch/docs.git" {
		t.Fatalf("SCP-like URL changed unexpectedly: %q", got)
	}
}

func TestValidateBranchRejectsGitOptionAndTraversalShapes(t *testing.T) {
	for _, branch := range []string{"-c", "refs/heads/../secret", "feature//broken", "feature name"} {
		if err := validateBranch(branch); err == nil {
			t.Fatalf("validateBranch accepted unsafe branch %q", branch)
		}
	}
	if err := validateBranch("main"); err != nil {
		t.Fatalf("validateBranch rejected main: %v", err)
	}
}

func TestServiceOwnedPathAllowsOnlyDeclaredArtifacts(t *testing.T) {
	for _, path := range []string{
		"evidence/validation.ndjson",
		"coordination/tasks/repo-a/api/task-1/events.ndjson",
	} {
		if !isServiceOwnedPath(path) {
			t.Fatalf("service-owned path rejected: %q", path)
		}
	}
	for _, path := range []string{
		"coordination/meeting/events.ndjson",
		"coordination/tasks/repo-a/api/task-1/other.json",
		"coordination/tasks/repo-a/api/../events.ndjson",
		"coordination/tasks/invalid space/api/task-1/events.ndjson",
	} {
		if isServiceOwnedPath(path) {
			t.Fatalf("undeclared service-owned path accepted: %q", path)
		}
	}
}

func runGitTest(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestLocalModeOperatesWithoutRemote(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot := filepath.Join(tempDir, "local-docs")
	if err := os.MkdirAll(docsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "init", "--initial-branch=main")
	runGitTest(t, docsRoot, "config", "user.name", "Local Test")
	runGitTest(t, docsRoot, "config", "user.email", "local-test@example.invalid")
	if err := os.WriteFile(filepath.Join(docsRoot, "README.md"), []byte("# local\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "add", "README.md")
	runGitTest(t, docsRoot, "commit", "-m", "bootstrap local")

	client, err := newGitClient(context.Background(), docsRoot, authorityConfig{remote: "", branch: "main"})
	if err != nil {
		t.Fatalf("newGitClient local mode failed: %v", err)
	}
	if !client.local {
		t.Fatal("expected local mode when remote is empty")
	}
	if err := client.ensureSynchronized(context.Background()); err != nil {
		t.Fatalf("ensureSynchronized local mode: %v", err)
	}
	descriptor, err := client.descriptor(context.Background())
	if err != nil {
		t.Fatalf("descriptor local mode: %v", err)
	}
	head := runGitTest(t, docsRoot, "rev-parse", "HEAD")
	if descriptor.HeadSHA != head {
		t.Fatalf("local descriptor head = %q, want %q", descriptor.HeadSHA, head)
	}
	absolute, err := filepath.Abs(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.RemoteURL != filepath.ToSlash(absolute) {
		t.Fatalf("local descriptor remote = %q, want %q", descriptor.RemoteURL, filepath.ToSlash(absolute))
	}

	// refresh accepts the current local head without any remote operations.
	if _, err := client.refreshFromRemoteWithServiceDescendants(context.Background(), "main", head, true); err != nil {
		t.Fatalf("local refresh with matching head: %v", err)
	}
	// refresh rejects a head that is not an ancestor of the local HEAD.
	if _, err := client.refreshFromRemoteWithServiceDescendants(context.Background(), "main", strings.Repeat("0", 40), true); err == nil {
		t.Fatal("local refresh accepted a non-ancestor head")
	}
}

// TestRefreshConcurrentWithCommitSeesConsistentHead interleaves goroutine
// commits with read-only descriptor snapshots on a local-mode client and
// asserts every observed head is a complete, resolvable commit (git HEAD
// updates are atomic; a read must never observe a torn/half-written state).
// RefreshFromRemoteContaining is intentionally NOT used here: it refuses a
// dirty service worktree (fail-closed anti-torn-read) - a deliberate design
// covered by its own tests - so this test exercises the read snapshot path.
func TestRefreshConcurrentWithCommitSeesConsistentHead(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot := filepath.Join(tempDir, "local-docs")
	if err := os.MkdirAll(docsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "init", "--initial-branch=main")
	runGitTest(t, docsRoot, "config", "user.name", "Refresh Test")
	runGitTest(t, docsRoot, "config", "user.email", "refresh-test@example.invalid")
	if err := os.WriteFile(filepath.Join(docsRoot, "README.md"), []byte("# refresh"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, docsRoot, "add", "README.md")
	runGitTest(t, docsRoot, "commit", "-m", "bootstrap")

	client, err := newGitClient(context.Background(), docsRoot, authorityConfig{remote: "", branch: "main"})
	if err != nil {
		t.Fatalf("newGitClient local mode failed: %v", err)
	}

	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		for i := 0; i < 10; i++ {
			dir := filepath.Join(docsRoot, "evidence")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Errorf("mkdir: %v", err)
				return
			}
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("payload-%d.ndjson", i)), []byte("payload"), 0o600); err != nil {
				t.Errorf("write: %v", err)
				return
			}
			runGitTest(t, docsRoot, "add", "evidence")
			runGitTest(t, docsRoot, "commit", "-m", fmt.Sprintf("service write %d", i))
		}
	}()

	for i := 0; i < 8; i++ {
		descriptor, err := client.descriptor(context.Background())
		if err != nil {
			t.Fatalf("concurrent descriptor read %d failed: %v", i, err)
		}
		if descriptor.HeadSHA == "" {
			t.Fatalf("descriptor read %d returned empty head", i)
		}
		if out := runGitTest(t, docsRoot, "cat-file", "-t", descriptor.HeadSHA); out != "commit" {
			t.Fatalf("descriptor read %d observed non-commit head %s (type %q)", i, descriptor.HeadSHA, out)
		}
	}
	writer.Wait()
	// All ten service commits landed.
	if count := runGitTest(t, docsRoot, "rev-list", "--count", "HEAD"); count != "11" {
		t.Fatalf("HEAD commits = %s, want 11 (10 service writes + bootstrap)", count)
	}
}
