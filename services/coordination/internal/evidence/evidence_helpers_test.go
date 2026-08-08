package evidence_test

// 共享测试辅助（evidence_test.go 拆解，2026-08-08）：拆解前 753 行堆积
// 5 个无关主题，sizeDispersion 超 P95 两倍触发。共享 fixture/helper 集中于此。

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	collaborationapplication "github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

func sample(project string) domain.ValidationEvidence {
	return domain.ValidationEvidence{
		SchemaVersion:   "2",
		ProjectToken:    project,
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


func writeTaskScopeFixture(t *testing.T, root string) {
	t.Helper()
	repositoryScope := filepath.Join(root, "repositories", "repo-a", "scope.json")
	serviceScope := filepath.Join(root, "services", "repo-a", "api", "scope.json")
	if err := os.MkdirAll(filepath.Dir(repositoryScope), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(serviceScope), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(repositoryScope, []byte("{\n  \"schemaVersion\": \"1\",\n  \"repository\": {\"repositoryId\": \"repo-a\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(serviceScope, []byte("{\n  \"schemaVersion\": \"1\",\n  \"service\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func taskSubmissionPayload(t *testing.T, head string) []byte {
	return taskSubmissionPayloadFor(t, head, "task-1")
}

func taskSubmissionPayloadFor(t *testing.T, head string, taskID string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"task":    map[string]string{"repositoryId": "repo-a", "serviceId": "api", "taskId": taskID},
		"branch":  "main",
		"headSha": head,
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func taskProposalFixture(taskID string) []byte {
	return []byte("{\n  \"schemaVersion\": \"1\",\n  \"task\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\", \"taskId\": \"" + taskID + "\"},\n  \"title\": \"Verify shared task lifecycle\",\n  \"hypothesis\": \"A verified task remains traceable to one proposal head.\",\n  \"requestedBy\": \"agent-a\"\n}\n")
}

func openTaskVerificationService(t *testing.T, docsRoot string) (*docsrepo.Authority, collaborationapplication.TaskService) {
	t.Helper()
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	scopeStore, err := scopedocsrepo.New(authority.Repository())
	if err != nil {
		t.Fatal(err)
	}
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	authenticator, err := signing.NewEd25519TaskEventAuthenticator("coordination-task-v1", private)
	if err != nil {
		t.Fatal(err)
	}
	taskStore, err := scopedocsrepo.NewTaskStore(authority.Repository(), authority, authenticator)
	if err != nil {
		t.Fatal(err)
	}
	taskService, err := collaborationapplication.NewTaskService(authority, scopeStore, taskStore, authenticator, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	return authority, taskService
}

func initializeAuthorityRepo(t *testing.T, tempDir string) (string, string) {
	t.Helper()
	docsRoot := filepath.Join(tempDir, "docs-repo")
	remoteRoot := filepath.Join(tempDir, "authority.git")
	runGit(t, tempDir, "init", "--initial-branch=main", docsRoot)
	runGit(t, docsRoot, "config", "user.name", "Evidence Test")
	runGit(t, docsRoot, "config", "user.email", "evidence-test@example.invalid")
	if err := os.WriteFile(filepath.Join(docsRoot, "README.md"), []byte("# authority\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, docsRoot, "add", "README.md")
	runGit(t, docsRoot, "commit", "-m", "bootstrap authority")
	runGit(t, tempDir, "init", "--bare", remoteRoot)
	runGit(t, docsRoot, "remote", "add", "origin", remoteRoot)
	runGit(t, docsRoot, "push", "-u", "origin", "main")
	return docsRoot, remoteRoot
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func runGitDir(t *testing.T, gitDirectory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"--git-dir", gitDirectory}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git --git-dir %s %s: %v: %s", gitDirectory, strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func l2TaskRef(taskID string) collaborationdomain.TaskRef {
	return collaborationdomain.TaskRef{RepositoryID: "repo-a", ServiceID: "svc-a", TaskID: taskID}
}

func l2VerifiedEvent(taskID string) collaborationdomain.TaskLifecycleEvent {
	return collaborationdomain.TaskLifecycleEvent{
		SchemaVersion: collaborationdomain.TaskEventSchemaVersion, Task: l2TaskRef(taskID), Type: "verified",
		RecordedAt: time.Now().UTC(), SignerKeyID: "test-signer",
		Signature:       base64.RawStdEncoding.EncodeToString(make([]byte, 64)),
		ProposalSHA256:  "73b6c4b02e65ae7deb4f6b681c7f72c6679dea3e7de1cb35d8c863bc52029701",
		VerifiedHeadSHA: "20e4982edbc908c3fec8254c9410d91430f98ca5",
	}
}

// TestConcurrentServiceWritesSerializeAndAdvanceHead drives concurrent
// AppendEvidence + AppendTaskLifecycle through one Service (one Authority),
// asserting every write lands, no event is lost, and HEAD advances once per
// accepted write (authority.mu serializes service-owned commits).
