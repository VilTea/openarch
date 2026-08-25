package evidence_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
)

func TestEvidenceHTTPStructuredErrorsAndRequestID(t *testing.T) {
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
	service := application.NewService(authority, projection, nil)
	handler := httpapi.NewHandler(service)

	t.Run("success response echoes X-Request-Id", func(t *testing.T) {
		payload, _ := json.Marshal(sample("opaque-http"))
		request := httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(payload))
		request.Header.Set("X-Request-Id", "req-evidence-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("POST status = %d: %s", response.Code, response.Body.String())
		}
		if got := response.Header().Get("X-Request-Id"); got != "req-evidence-1" {
			t.Fatalf("X-Request-Id = %q, want req-evidence-1", got)
		}
	})

	t.Run("invalid evidence returns structured invalid_request", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader([]byte(`{"schemaVersion":"2"}`)))
		request.Header.Set("X-Request-Id", "req-invalid-evidence")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid evidence status = %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Error     string `json:"error"`
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
			RequestID string `json:"requestId"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != "invalid_request" || body.Retryable || body.RequestID != "req-invalid-evidence" {
			t.Fatalf("unexpected structured error: %+v", body)
		}
	})

	t.Run("invalid calibration key returns structured invalid_request", func(t *testing.T) {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/calibrations/bad%20key/r/a", nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid calibration status = %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
			RequestID string `json:"requestId"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != "invalid_request" || body.Retryable || body.RequestID == "" {
			t.Fatalf("unexpected calibration error: %+v", body)
		}
	})

	t.Run("authority failure returns retryable authority_unavailable", func(t *testing.T) {
		evidencePath := filepath.Join(docsRoot, "evidence", "validation.ndjson")
		if err := os.MkdirAll(filepath.Dir(evidencePath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(evidencePath, []byte("dirty\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(sample("opaque-dirty"))
		request := httptest.NewRequest(http.MethodPost, "/v1/evidence", bytes.NewReader(payload))
		request.Header.Set("X-Request-Id", "req-authority-down")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("authority failure status = %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
			RequestID string `json:"requestId"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != "authority_unavailable" || !body.Retryable || body.RequestID != "req-authority-down" {
			t.Fatalf("unexpected authority error: %+v", body)
		}
	})
}
