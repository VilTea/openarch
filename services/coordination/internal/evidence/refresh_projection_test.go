package evidence_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
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
	runGit(t, agentRoot, "add", "repositories/repo-a/scope.json", "services/repo-a/api/scope.json", "products/product-a/scope.json")
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
