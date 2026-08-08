package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

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
		info, err := service.GetRepositoryInfo(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": fmt.Sprintf("read docs-repo: %v", err)})
			return
		}
		writeJSON(w, http.StatusOK, info)
	})
	mux.HandleFunc("POST /v1/docs-repo/refresh", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		decoder.DisallowUnknownFields()
		var notice collaborationdomain.RepositorySyncNotice
		if err := decoder.Decode(&notice); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid docs-repo refresh: " + err.Error()})
			return
		}
		if err := notice.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid docs-repo refresh: " + err.Error()})
			return
		}
		info, err := service.RefreshRepository(r.Context(), notice)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": fmt.Sprintf("refresh docs-repo: %v", err)})
			return
		}
		writeJSON(w, http.StatusOK, info)
	})
	mux.HandleFunc("POST /v1/evidence", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		var evidence domain.ValidationEvidence
		if err := decoder.Decode(&evidence); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid evidence: " + err.Error()})
			return
		}
		if err := service.IngestEvidence(r.Context(), evidence); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
	})
	mux.HandleFunc("GET /v1/calibrations/{provider}/{rule}/{authority}", func(w http.ResponseWriter, r *http.Request) {
		key := domain.CalibrationKey{
			ProviderID:  r.PathValue("provider"),
			RuleID:      r.PathValue("rule"),
			AuthorityID: r.PathValue("authority"),
		}
		if err := key.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid calibration key: " + err.Error()})
			return
		}
		calibration, err := service.GetCalibration(r.Context(), key)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("read calibration: %v", err)})
			return
		}
		writeJSON(w, http.StatusOK, calibration)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
