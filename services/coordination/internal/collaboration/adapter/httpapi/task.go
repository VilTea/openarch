package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// RegisterTaskRoutes attaches collaboration routes to the composition-root
// mux. Task transport stays outside the evidence HTTP adapter.
func RegisterTaskRoutes(mux *http.ServeMux, service application.TaskService) {
	mux.HandleFunc("POST /v1/tasks/submit", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		var submission domain.TaskSubmission
		if err := decoder.Decode(&submission); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task submission: " + err.Error()})
			return
		}
		if err := submission.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task submission: " + err.Error()})
			return
		}
		result, err := service.Submit(r.Context(), submission)
		if err != nil {
			writeTaskError(w, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(w, status, result)
	})

	mux.HandleFunc("POST /v1/tasks/claim", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Task           domain.TaskRef `json:"task"`
			ProposalSHA256 string         `json:"proposalSha256"`
			ClaimedBy      string         `json:"claimedBy"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task claim: " + err.Error()})
			return
		}
		result, err := service.Claim(r.Context(), payload.Task, payload.ProposalSHA256, payload.ClaimedBy)
		if err != nil {
			writeTaskError(w, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(w, status, result)
	})

	mux.HandleFunc("POST /v1/tasks/complete", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Task             domain.TaskRef `json:"task"`
			ProposalSHA256   string         `json:"proposalSha256"`
			CompletedBy      string         `json:"completedBy"`
			CompletedHeadSHA string         `json:"completedHeadSHA"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task complete: " + err.Error()})
			return
		}
		result, err := service.Complete(r.Context(), payload.Task, payload.ProposalSHA256, payload.CompletedBy, payload.CompletedHeadSHA)
		if err != nil {
			writeTaskError(w, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(w, status, result)
	})
}

func writeTaskError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrTaskProposalMissing):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrTaskAlreadyVerified):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrTaskAlreadyClaimed):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrTaskAlreadyCompleted):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrTaskNotVerified):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrTaskNotClaimed):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrScopeDocumentMissing):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "verify task: " + err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
