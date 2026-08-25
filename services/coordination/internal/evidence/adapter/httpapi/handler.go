package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

const requestIDHeader = "X-Request-Id"

func NewHandler(service application.Service) http.Handler {
	mux := http.NewServeMux()
	Register(mux, service)
	return mux
}

func Register(mux *http.ServeMux, service application.Service) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /v1/docs-repo", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		info, err := service.GetRepositoryInfo(r.Context())
		if err != nil {
			writeAuthorityError(w, requestID, "read docs-repo", err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusOK, info)
		slog.Info("docs-repo descriptor read", "requestId", requestID, "branch", info.DocsRepo.Branch, "head", info.DocsRepo.HeadSHA)
	})
	mux.HandleFunc("POST /v1/docs-repo/refresh", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		decoder.DisallowUnknownFields()
		var notice collaborationdomain.RepositorySyncNotice
		if err := decoder.Decode(&notice); err != nil {
			writeInvalidRequest(w, requestID, "invalid docs-repo refresh: "+err.Error())
			return
		}
		if err := notice.Validate(); err != nil {
			writeInvalidRequest(w, requestID, "invalid docs-repo refresh: "+err.Error())
			return
		}
		info, err := service.RefreshRepository(r.Context(), notice)
		if err != nil {
			writeAuthorityError(w, requestID, "refresh docs-repo", err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusOK, info)
		slog.Info("docs-repo refreshed", "requestId", requestID, "repositoryId", notice.RepositoryID, "branch", notice.Branch, "head", info.DocsRepo.HeadSHA)
	})
	mux.HandleFunc("POST /v1/evidence", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		var evidence domain.ValidationEvidence
		if err := decoder.Decode(&evidence); err != nil {
			writeInvalidRequest(w, requestID, "invalid evidence: "+err.Error())
			return
		}
		if err := evidence.Validate(); err != nil {
			writeInvalidRequest(w, requestID, "invalid evidence: "+err.Error())
			return
		}
		if err := service.IngestEvidence(r.Context(), evidence); err != nil {
			writeAuthorityError(w, requestID, "ingest evidence", err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusAccepted, map[string]string{"status": "accepted"})
		slog.Info("evidence ingested", "requestId", requestID, "provider", evidence.Provider.ID, "rule", evidence.RuleID, "authority", evidence.AuthorityID)
	})
	mux.HandleFunc("GET /v1/calibrations/{provider}/{rule}/{authority}", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		key := domain.CalibrationKey{
			ProviderID:  r.PathValue("provider"),
			RuleID:      r.PathValue("rule"),
			AuthorityID: r.PathValue("authority"),
		}
		if err := key.Validate(); err != nil {
			writeInvalidRequest(w, requestID, "invalid calibration key: "+err.Error())
			return
		}
		calibration, err := service.GetCalibration(r.Context(), key)
		if err != nil {
			writeServiceError(w, requestID, "read calibration", err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusOK, calibration)
		slog.Info("calibration read", "requestId", requestID, "provider", key.ProviderID, "rule", key.RuleID, "authority", key.AuthorityID, "projects", calibration.Projects)
	})
}

func requestID(r *http.Request) string {
	if id := strings.TrimSpace(r.Header.Get(requestIDHeader)); id != "" {
		if len(id) > 128 {
			id = id[:128]
		}
		return id
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("req-%d", time.Now().UnixNano())
}

func writeInvalidRequest(w http.ResponseWriter, requestID string, detail string) {
	writeJSONError(w, http.StatusBadRequest, "invalid_request", false, requestID, detail)
}

func writeAuthorityError(w http.ResponseWriter, requestID string, operation string, err error) {
	writeJSONError(w, http.StatusServiceUnavailable, "authority_unavailable", true, requestID, fmt.Sprintf("%s: %v", operation, err))
}

func writeServiceError(w http.ResponseWriter, requestID string, operation string, err error) {
	writeJSONError(w, http.StatusServiceUnavailable, "service_unavailable", true, requestID, fmt.Sprintf("%s: %v", operation, err))
}

func writeJSONError(w http.ResponseWriter, status int, code string, retryable bool, requestID string, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(requestIDHeader, requestID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":     detail,
		"code":      code,
		"retryable": retryable,
		"requestId": requestID,
	})
}

func writeJSONWithRequestID(w http.ResponseWriter, requestID string, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(requestIDHeader, requestID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
