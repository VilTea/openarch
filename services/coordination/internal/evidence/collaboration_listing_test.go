package evidence_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	collaborationhttp "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	collaborationapplication "github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
)

func TestTaskListProjectsProposalJoinedWithLifecycle(t *testing.T) {
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
	taskService, err := collaborationapplication.NewTaskService(authority, scopeStore, taskStore, authenticator, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	collaborationhttp.RegisterTaskRoutes(mux, taskService)

	agentRoot := filepath.Join(tempDir, "agent-task-list")
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
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "tasks/repo-a/api/task-1/proposal.json")
	runGit(t, agentRoot, "commit", "-m", "agent: submit listed task proposal")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/tasks/submit", bytes.NewReader(taskSubmissionPayload(t, head))))
	if response.Code != http.StatusCreated {
		t.Fatalf("task submit status = %d: %s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tasks?repositoryId=repo-a", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("task list status = %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Tasks []domain.TaskSummary `json:"tasks"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Tasks) != 1 {
		t.Fatalf("task list length = %d, want 1", len(body.Tasks))
	}
	summary := body.Tasks[0]
	if summary.Task.TaskID != "task-1" || summary.Title == "" || summary.Status.State != "verified" || summary.Status.VerifiedHeadSHA != head || summary.ProposalSHA256 == "" {
		t.Fatalf("unexpected task summary: %+v", summary)
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tasks?repositoryId=repo-b", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("filtered task list status = %d: %s", response.Code, response.Body.String())
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Tasks) != 0 {
		t.Fatalf("repo-b task list = %+v, want empty", body.Tasks)
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tasks?repositoryId=bad%20id", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid task filter status = %d", response.Code)
	}
}

func TestDebtListProjectsAgentOwnedDocuments(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	debtStore, err := scopedocsrepo.NewDebtStore(authority.Repository())
	if err != nil {
		t.Fatal(err)
	}
	debtService, err := collaborationapplication.NewDebtService(debtStore)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	collaborationhttp.RegisterDebtRoutes(mux, debtService)

	agentRoot := filepath.Join(tempDir, "agent-debt-list")
	runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
	runGit(t, agentRoot, "config", "user.name", "Debt Agent")
	runGit(t, agentRoot, "config", "user.email", "debt-agent@example.invalid")
	writeTaskScopeFixture(t, agentRoot)
	debtPath := filepath.Join(agentRoot, "debts", "repo-a", "api", "debt-1.json")
	if err := os.MkdirAll(filepath.Dir(debtPath), 0o755); err != nil {
		t.Fatal(err)
	}
	debtPayload := "{\n  \"schemaVersion\": \"1\",\n  \"debt\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\", \"debtId\": \"debt-1\"},\n  \"title\": \"Defer parser split\",\n  \"reason\": \"Current parser split has no consumer evidence yet.\",\n  \"reconsiderCondition\": \"When a third language strategy lands.\",\n  \"status\": \"deferred\"\n}\n"
	if err := os.WriteFile(debtPath, []byte(debtPayload), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "debts/repo-a/api/debt-1.json")
	runGit(t, agentRoot, "commit", "-m", "agent: register deferred debt")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")

	if _, err := authority.RefreshFromRemote(t.Context(), "main", head); err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/debts?repositoryId=repo-a", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("debt list status = %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Debts []domain.DebtDocument `json:"debts"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Debts) != 1 || body.Debts[0].Debt.DebtID != "debt-1" || body.Debts[0].Status != "deferred" {
		t.Fatalf("unexpected debt projection: %+v", body.Debts)
	}
}
