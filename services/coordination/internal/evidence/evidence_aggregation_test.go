package evidence_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestObservationFingerprintIgnoresCollectionTimingButKeepsConclusionChanges(t *testing.T) {
	first := sample("opaque-a")
	first.Languages = []string{"typescript", "javascript"}
	second := first
	second.ObservedAt = first.ObservedAt.Add(24 * time.Hour)
	second.Window = domain.Window{StartedAt: second.ObservedAt.Add(-time.Hour), EndedAt: second.ObservedAt}
	second.Languages = []string{"javascript", "typescript"}
	if first.ObservationFingerprint() != second.ObservationFingerprint() {
		t.Fatal("equivalent calibration conclusion produced a different fingerprint")
	}
	second.FindingCount++
	if first.ObservationFingerprint() == second.ObservationFingerprint() {
		t.Fatal("changed calibration conclusion reused a fingerprint")
	}
}

func TestEvidenceIsAggregatedAndCalibrationStaysReviewOnly(t *testing.T) {
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
	handler := httpapi.NewHandler(service)

	for _, project := range []string{"opaque-a", "opaque-b"} {
		payload, _ := json.Marshal(sample(project))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(payload)))
		if response.Code != http.StatusAccepted {
			t.Fatalf("POST status = %d: %s", response.Code, response.Body.String())
		}
	}
	duplicatePayload, _ := json.Marshal(sample("opaque-a"))
	duplicateResponse := httptest.NewRecorder()
	handler.ServeHTTP(duplicateResponse, httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(duplicatePayload)))
	if duplicateResponse.Code != http.StatusAccepted {
		t.Fatalf("duplicate POST status = %d: %s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
	changed := sample("opaque-a")
	changed.FindingCount = 3
	changedPayload, _ := json.Marshal(changed)
	changedResponse := httptest.NewRecorder()
	handler.ServeHTTP(changedResponse, httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(changedPayload)))
	if changedResponse.Code != http.StatusAccepted {
		t.Fatalf("changed POST status = %d: %s", changedResponse.Code, changedResponse.Body.String())
	}
	otherScope := sample("opaque-c")
	otherScope.AuthorityID = "another-authority"
	payload, _ := json.Marshal(otherScope)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(payload)))
	if response.Code != http.StatusAccepted {
		t.Fatalf("POST different authority status = %d: %s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/calibrations/typescript-vitest/vitest.focused-test/vitest-api", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET status = %d", response.Code)
	}

	var calibration domain.Calibration
	if err := json.NewDecoder(response.Body).Decode(&calibration); err != nil {
		t.Fatal(err)
	}
	if calibration.Projects != 2 || calibration.Samples != 2 || calibration.AuthorityID != "vitest-api" || calibration.Recommendation == "" {
		t.Fatalf("unexpected calibration: %+v", calibration)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/calibrations/typescript-vitest/vitest.focused-test/another-authority", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET different authority status = %d", response.Code)
	}
	if err := json.NewDecoder(response.Body).Decode(&calibration); err != nil {
		t.Fatal(err)
	}
	if calibration.Projects != 1 || calibration.Samples != 1 || calibration.AuthorityID != "another-authority" {
		t.Fatalf("different authority was mixed into calibration: %+v", calibration)
	}

	if status := runGit(t, authority.Root(), "status", "--porcelain"); status != "" {
		t.Fatalf("authority worktree is dirty after ingest: %q", status)
	}
	commitMessage := runGitDir(t, remoteRoot, "log", "--format=%s", "-1", "main")
	if !strings.Contains(commitMessage, "coordination: upsert validation evidence") {
		t.Fatalf("unexpected authority commit message: %q", commitMessage)
	}
	remoteEvidence := runGitDir(t, remoteRoot, "show", "main:evidence/validation.ndjson")
	if lines := strings.Count(strings.TrimSpace(remoteEvidence), "\n") + 1; lines != 3 {
		t.Fatalf("remote authority evidence records = %d, want 3", lines)
	}
	if _, err := os.Stat(filepath.Join(tempDir, "projection.ndjson")); err != nil {
		t.Fatalf("projection file missing: %v", err)
	}
}

func TestConcurrentIngestSameEvidenceConverges(t *testing.T) {
	tempDir := t.TempDir()
	docsRoot, remoteRoot := initializeAuthorityRepo(t, tempDir)
	authority, err := docsrepo.Open(docsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.Close()
	evidence := sample("opaque-concurrent")
	const workers = 8
	var wait sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs <- authority.AppendEvidence(context.Background(), evidence)
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent ingest failed: %v", err)
		}
	}
	remoteEvidence := runGitDir(t, remoteRoot, "show", "main:evidence/validation.ndjson")
	if lines := strings.Count(strings.TrimSpace(remoteEvidence), "\n") + 1; lines != 1 {
		t.Fatalf("concurrent duplicate ingest persisted %d records, want exactly 1", lines)
	}
}
