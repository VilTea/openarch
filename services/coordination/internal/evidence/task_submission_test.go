package evidence_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	collaborationapplication "github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	collaborationhttp "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
)

func TestAgentTaskProposalIsVerifiedOnceAndCannotBeReplaced(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
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
	taskService, err := collaborationapplication.NewTaskService(authority, scopeStore, taskStore, authenticator, noLeaseVerifier{}, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	handler := http.NewServeMux()
	collaborationhttp.RegisterTaskRoutes(handler, taskService)

	agentRoot := filepath.Join(tempDir, "agent-task-docs")
	runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
	runGit(t, agentRoot, "config", "user.name", "Task Agent")
	runGit(t, agentRoot, "config", "user.email", "task-agent@example.invalid")
	writeTaskScopeFixture(t, agentRoot)
	proposalPath := filepath.Join(agentRoot, "tasks", "repo-a", "api", "task-1", "proposal.json")
	if err := os.MkdirAll(filepath.Dir(proposalPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(proposalPath, []byte("{\n  \"schemaVersion\": \"1\",\n  \"task\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\", \"taskId\": \"task-1\"},\n  \"title\": \"Verify shared task lifecycle\",\n  \"hypothesis\": \"A verified task remains traceable to one proposal head.\",\n  \"requestedBy\": \"agent-a\"\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "tasks/repo-a/api/task-1/proposal.json")
	runGit(t, agentRoot, "commit", "-m", "agent: submit task proposal")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")
	payload := taskSubmissionPayload(t, head)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(payload)))
	if response.Code != http.StatusCreated {
		t.Fatalf("task submit status = %d: %s", response.Code, response.Body.String())
	}
	var created collaborationapplication.TaskSubmitResult
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if !created.Created || created.Status.State != "verified" || created.Status.VerifiedHeadSHA != head {
		t.Fatalf("unexpected verified task: %+v", created)
	}
	verifiedHead := runGitDir(t, remoteRoot, "rev-parse", "main")
	events := runGitDir(t, remoteRoot, "show", "main:coordination/tasks/repo-a/api/task-1/events.ndjson")
	if strings.Count(strings.TrimSpace(events), "\n")+1 != 1 || !strings.Contains(events, `"type":"verified"`) {
		t.Fatalf("unexpected lifecycle events: %q", events)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("idempotent task submit status = %d: %s", response.Code, response.Body.String())
	}
	if got := runGitDir(t, remoteRoot, "rev-parse", "main"); got != verifiedHead {
		t.Fatalf("idempotent submit created a new lifecycle commit: %s -> %s", verifiedHead, got)
	}

	runGit(t, agentRoot, "pull", "--rebase", "origin", "main")
	if err := os.WriteFile(proposalPath, []byte("{\n  \"schemaVersion\": \"1\",\n  \"task\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\", \"taskId\": \"task-1\"},\n  \"title\": \"Verify shared task lifecycle\",\n  \"hypothesis\": \"A changed proposal must require a new task identity.\",\n  \"requestedBy\": \"agent-a\"\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "tasks/repo-a/api/task-1/proposal.json")
	runGit(t, agentRoot, "commit", "-m", "agent: replace proposal")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	changedHead := runGit(t, agentRoot, "rev-parse", "HEAD")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayload(t, changedHead))))
	if response.Code != http.StatusConflict {
		t.Fatalf("replaced proposal status = %d: %s", response.Code, response.Body.String())
	}
	events = runGitDir(t, remoteRoot, "show", "main:coordination/tasks/repo-a/api/task-1/events.ndjson")
	if strings.Count(strings.TrimSpace(events), "\n")+1 != 1 {
		t.Fatalf("replaced proposal appended lifecycle event: %q", events)
	}
}


func TestTaskSubmissionRejectsMissingProposalAndScope(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, taskService := openTaskVerificationService(t, docsRoot)
	defer authority.Close()
	handler := http.NewServeMux()
	collaborationhttp.RegisterTaskRoutes(handler, taskService)

	agentRoot := filepath.Join(tempDir, "agent-task-errors")
	runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
	runGit(t, agentRoot, "config", "user.name", "Task Agent")
	runGit(t, agentRoot, "config", "user.email", "task-agent@example.invalid")
	writeTaskScopeFixture(t, agentRoot)
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json")
	runGit(t, agentRoot, "commit", "-m", "agent: register task scope")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayload(t, head))))
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing proposal status = %d: %s", response.Code, response.Body.String())
	}

	proposalPath := filepath.Join(agentRoot, "tasks", "repo-a", "api", "task-1", "proposal.json")
	if err := os.MkdirAll(filepath.Dir(proposalPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(proposalPath, taskProposalFixture("task-1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(agentRoot, "services", "repo-a", "api", "scope.json")); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "-A", "services/repo-a/api/scope.json", "tasks/repo-a/api/task-1/proposal.json")
	runGit(t, agentRoot, "commit", "-m", "agent: submit without registered service")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head = runGit(t, agentRoot, "rev-parse", "HEAD")

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayload(t, head))))
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing service scope status = %d: %s", response.Code, response.Body.String())
	}
}


func TestTaskSubmissionRejectsForgedLifecycleAndAgentDescendant(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, taskService := openTaskVerificationService(t, docsRoot)
	defer authority.Close()
	handler := http.NewServeMux()
	collaborationhttp.RegisterTaskRoutes(handler, taskService)

	agentRoot := filepath.Join(tempDir, "agent-task-boundaries")
	runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
	runGit(t, agentRoot, "config", "user.name", "Task Agent")
	runGit(t, agentRoot, "config", "user.email", "task-agent@example.invalid")
	writeTaskScopeFixture(t, agentRoot)
	proposalPath := filepath.Join(agentRoot, "tasks", "repo-a", "api", "task-1", "proposal.json")
	if err := os.MkdirAll(filepath.Dir(proposalPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(proposalPath, taskProposalFixture("task-1"), 0o600); err != nil {
		t.Fatal(err)
	}
	forgedPath := filepath.Join(agentRoot, "coordination", "tasks", "repo-a", "api", "task-1", "events.ndjson")
	if err := os.MkdirAll(filepath.Dir(forgedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(forgedPath, []byte("{\"schemaVersion\":\"1\",\"task\":{\"repositoryId\":\"repo-a\",\"serviceId\":\"api\",\"taskId\":\"task-1\"},\"type\":\"verified\",\"proposalSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"verifiedHeadSha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"recordedAt\":\"2026-08-02T00:00:00Z\",\"signerKeyId\":\"coordination-task-v1\",\"signature\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "tasks/repo-a/api/task-1/proposal.json", "coordination/tasks/repo-a/api/task-1/events.ndjson")
	runGit(t, agentRoot, "commit", "-m", "agent: forge task lifecycle")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayload(t, head))))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("forged lifecycle status = %d: %s", response.Code, response.Body.String())
	}

	// A distinct Task proves that a service-owned descendant is tolerated only
	// until an Agent-owned path appears after the submitted head.
	runGit(t, agentRoot, "rm", "coordination/tasks/repo-a/api/task-1/events.ndjson")
	secondProposal := filepath.Join(agentRoot, "tasks", "repo-a", "api", "task-2", "proposal.json")
	if err := os.MkdirAll(filepath.Dir(secondProposal), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondProposal, taskProposalFixture("task-2"), 0o600); err != nil {
		t.Fatal(err)
	}
	// git rm already staged the forged lifecycle deletion.
	runGit(t, agentRoot, "add", "tasks/repo-a/api/task-2/proposal.json")
	runGit(t, agentRoot, "commit", "-m", "agent: submit second task")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	submittedHead := runGit(t, agentRoot, "rev-parse", "HEAD")

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayloadFor(t, submittedHead, "task-2"))))
	if response.Code != http.StatusCreated {
		t.Fatalf("second task submit status = %d: %s", response.Code, response.Body.String())
	}

	runGit(t, agentRoot, "pull", "--rebase", "origin", "main")
	if err := os.WriteFile(filepath.Join(agentRoot, "agent-note.md"), []byte("Agent-owned descendant\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "agent-note.md")
	runGit(t, agentRoot, "commit", "-m", "agent: advance unrelated document")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayloadFor(t, submittedHead, "task-2"))))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("agent descendant retry status = %d: %s", response.Code, response.Body.String())
	}
}
