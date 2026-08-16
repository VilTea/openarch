package evidence_test

import (
	"bytes"
	"encoding/json"
	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEvidenceRequiresRuleAndAuthorityKey(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	handler := httpapi.NewHandler(application.NewService(authority, projection, nil))

	invalid := sample("opaque-a")
	invalid.AuthorityID = `E:\workspace\project`
	payload, _ := json.Marshal(invalid)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(payload)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("POST without authority key status = %d", response.Code)
	}
}

func TestAgentPushAndRefreshPublishesRemoteHeadAndScopeProjection(t *testing.T) {
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
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	handler := httpapi.NewHandler(application.NewService(authority, projection, scopeStore))

	agentRoot := filepath.Join(tempDir, "agent-docs")
	runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
	runGit(t, agentRoot, "config", "user.name", "Agent Test")
	runGit(t, agentRoot, "config", "user.email", "agent@example.invalid")
	scopePath := filepath.Join(agentRoot, "repositories", "repo-a", "scope.json")
	if err := os.MkdirAll(filepath.Dir(scopePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scopePath, []byte("{\n  \"schemaVersion\": \"1\",\n  \"repository\": {\"repositoryId\": \"repo-a\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	serviceScopePath := filepath.Join(agentRoot, "services", "repo-a", "api", "scope.json")
	if err := os.MkdirAll(filepath.Dir(serviceScopePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(serviceScopePath, []byte("{\n  \"schemaVersion\": \"1\",\n  \"service\": {\"repositoryId\": \"repo-a\", \"serviceId\": \"api\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	productScopePath := filepath.Join(agentRoot, "products", "product-a", "scope.json")
	if err := os.MkdirAll(filepath.Dir(productScopePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(productScopePath, []byte("{\n  \"schemaVersion\": \"1\",\n  \"product\": {\"productId\": \"product-a\", \"services\": [{\"repositoryId\": \"repo-a\", \"serviceId\": \"api\"}]}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyProjectPath := filepath.Join(agentRoot, "projects", "legacy-basename", "README.md")
	if err := os.MkdirAll(filepath.Dir(legacyProjectPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyProjectPath, []byte("legacy project that still needs an explicit migration\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "products/product-a/scope.json", "projects/legacy-basename/README.md")
	runGit(t, agentRoot, "commit", "-m", "agent: register repository scope")
	runGit(t, agentRoot, "push", "origin", "HEAD:main")
	head := runGit(t, agentRoot, "rev-parse", "HEAD")

	payload, err := json.Marshal(map[string]string{
		"repositoryId": "repo-a",
		"branch":       "main",
		"headSha":      head,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/docs-repo/refresh", bytes.NewReader(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("refresh status = %d: %s", response.Code, response.Body.String())
	}
	var info application.RepositoryInfo
	if err := json.NewDecoder(response.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if info.DocsRepo.HeadSHA != head || info.DocsRepo.Branch != "main" || info.ScopeState != "available" || len(info.Scope.Repositories) != 1 || len(info.Scope.Services) != 1 || len(info.Scope.Products) != 1 {
		t.Fatalf("unexpected refreshed docs-repo info: %+v", info)
	}
	if info.Scope.Repositories[0].Repository.ID != "repo-a" {
		t.Fatalf("unexpected scope projection: %+v", info.Scope.Repositories)
	}
	if len(info.LegacyProjects) != 1 || info.LegacyProjects[0].Path != "projects/legacy-basename" {
		t.Fatalf("unexpected legacy project projection: %+v", info.LegacyProjects)
	}
	if status := runGit(t, docsRoot, "status", "--porcelain"); status != "" {
		t.Fatalf("service worktree is dirty after refresh: %q", status)
	}
}

func TestRefreshRejectsAnAdvertisedHeadThatIsNotRemoteTruth(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	handler := httpapi.NewHandler(application.NewService(authority, projection, nil))
	oldHead := runGit(t, docsRoot, "rev-parse", "HEAD")
	payload := []byte(`{"repositoryId":"repo-a","branch":"main","headSha":"0000000000000000000000000000000000000000"}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/docs-repo/refresh", bytes.NewReader(payload)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("refresh mismatch status = %d: %s", response.Code, response.Body.String())
	}
	if got := runGit(t, docsRoot, "rev-parse", "HEAD"); got != oldHead {
		t.Fatalf("failed refresh changed service head from %s to %s", oldHead, got)
	}
}

// TestRefreshAcceptsAncestorAdvertisedHeadAfterConcurrentProjectPush models the
// multi-project single-docs-repo case: project A and project B push to the
// same remote branch independently. A refresh that advertises A's already
// pushed (ancestor) head must still fast-forward the service worktree and
// report the actual remote head, never rewind it.
func TestRefreshAcceptsAncestorAdvertisedHeadAfterConcurrentProjectPush(t *testing.T) {
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
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	handler := httpapi.NewHandler(application.NewService(authority, projection, scopeStore))

	writeProjectScope := func(agentRoot string, repositoryID string) string {
		t.Helper()
		scopePath := filepath.Join(agentRoot, "repositories", repositoryID, "scope.json")
		if err := os.MkdirAll(filepath.Dir(scopePath), 0o755); err != nil {
			t.Fatal(err)
		}
		payload := "{\n  \"schemaVersion\": \"1\",\n  \"repository\": {\"repositoryId\": \"" + repositoryID + "\"}\n}\n"
		if err := os.WriteFile(scopePath, []byte(payload), 0o600); err != nil {
			t.Fatal(err)
		}
		runGit(t, agentRoot, "add", filepath.ToSlash(filepath.Join("repositories", repositoryID, "scope.json")))
		runGit(t, agentRoot, "commit", "-m", "agent "+repositoryID+": register repository scope")
		runGit(t, agentRoot, "push", "origin", "HEAD:main")
		return runGit(t, agentRoot, "rev-parse", "HEAD")
	}
	newAgentClone := func(name string) string {
		t.Helper()
		agentRoot := filepath.Join(tempDir, name)
		runGit(t, tempDir, "clone", "--branch", "main", remoteRoot, agentRoot)
		runGit(t, agentRoot, "config", "user.name", "Agent Test")
		runGit(t, agentRoot, "config", "user.email", "agent@example.invalid")
		return agentRoot
	}
	refresh := func(head string) (int, application.RepositoryInfo) {
		t.Helper()
		payload, err := json.Marshal(map[string]string{"repositoryId": "repo-a", "branch": "main", "headSha": head})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/docs-repo/refresh", bytes.NewReader(payload)))
		var info application.RepositoryInfo
		if err := json.NewDecoder(response.Body).Decode(&info); err != nil {
			t.Fatalf("decode refresh response: %v", err)
		}
		return response.Code, info
	}

	headA := writeProjectScope(newAgentClone("agent-a"), "repo-a")
	if status, _ := refresh(headA); status != http.StatusOK {
		t.Fatalf("project A refresh status = %d", status)
	}

	headB := writeProjectScope(newAgentClone("agent-b"), "repo-b")
	status, info := refresh(headA)
	if status != http.StatusOK {
		t.Fatalf("ancestor refresh after project B push status = %d", status)
	}
	if info.DocsRepo.HeadSHA != headB {
		t.Fatalf("ancestor refresh reported head %s, want actual remote head %s", info.DocsRepo.HeadSHA, headB)
	}
	if info.ScopeState != "available" || len(info.Scope.Repositories) != 2 {
		t.Fatalf("scope projection did not rebuild for both projects: %+v", info.Scope)
	}
	if status := runGit(t, docsRoot, "status", "--porcelain"); status != "" {
		t.Fatalf("service worktree is dirty after ancestor refresh: %q", status)
	}
}

func TestRefreshRejectsMalformedNoticeAtTransportBoundary(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, _ := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	projection, err := ndjson.Open(filepath.Join(tempDir, "projection.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer projection.Close()
	handler := httpapi.NewHandler(application.NewService(authority, projection, nil))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/docs-repo/refresh", bytes.NewBufferString(`{"repositoryId":"repo-a","branch":"main","headSha":"short"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("malformed refresh status = %d: %s", response.Code, response.Body.String())
	}
}
