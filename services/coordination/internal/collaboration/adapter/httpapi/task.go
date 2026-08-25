package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/identity"
)

const requestIDHeader = "X-Request-Id"

type taskClaimPayload struct {
	Task           domain.TaskRef `json:"task"`
	ProposalSHA256 string         `json:"proposalSha256"`
	ClaimedBy      string         `json:"claimedBy"`
}

type taskCompletePayload struct {
	Task             domain.TaskRef `json:"task"`
	ProposalSHA256   string         `json:"proposalSha256"`
	CompletedBy      string         `json:"completedBy"`
	CompletedHeadSHA string         `json:"completedHeadSHA"`
	Target           string         `json:"target"`
	LeaseID          string         `json:"leaseId"`
}

type taskCompleteLocalPayload struct {
	Task           domain.TaskRef `json:"task"`
	ProposalSHA256 string         `json:"proposalSha256"`
	CompletedBy    string         `json:"completedBy"`
	LocalHeadSHA   string         `json:"localHeadSHA"`
	Target         string         `json:"target"`
	LeaseID        string         `json:"leaseId"`
}

func decodeTaskClaim(w http.ResponseWriter, r *http.Request) (taskClaimPayload, error) {
	var payload taskClaimPayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid task claim: %w", err)
	}
	if err := payload.Task.Validate(); err != nil {
		return payload, fmt.Errorf("invalid task claim: %w", err)
	}
	if err := domain.ValidateSHA256Hex(payload.ProposalSHA256, "task claim proposalSha256"); err != nil {
		return payload, fmt.Errorf("invalid task claim: %w", err)
	}
	if err := identity.Validate(payload.ClaimedBy); err != nil {
		return payload, fmt.Errorf("invalid task claim: %w", err)
	}
	return payload, nil
}

func decodeTaskCompleteLocal(w http.ResponseWriter, r *http.Request) (taskCompleteLocalPayload, error) {
	var payload taskCompleteLocalPayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid task complete-local: %w", err)
	}
	if err := payload.Task.Validate(); err != nil {
		return payload, fmt.Errorf("invalid task complete-local: %w", err)
	}
	if err := domain.ValidateSHA256Hex(payload.ProposalSHA256, "task complete-local proposalSha256"); err != nil {
		return payload, fmt.Errorf("invalid task complete-local: %w", err)
	}
	if err := identity.Validate(payload.CompletedBy); err != nil {
		return payload, fmt.Errorf("invalid task complete-local: %w", err)
	}
	if err := domain.ValidateGitSHAHex(strings.TrimSpace(payload.LocalHeadSHA), "task complete-local localHeadSHA"); err != nil {
		return payload, fmt.Errorf("invalid task complete-local localHeadSHA")
	}
	if strings.TrimSpace(payload.Target) == "" {
		return payload, fmt.Errorf("invalid task complete-local target")
	}
	if strings.TrimSpace(payload.LeaseID) == "" {
		return payload, fmt.Errorf("invalid task complete-local leaseId")
	}
	return payload, nil
}

func decodeTaskComplete(w http.ResponseWriter, r *http.Request) (taskCompletePayload, error) {
	var payload taskCompletePayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid task complete: %w", err)
	}
	if err := payload.Task.Validate(); err != nil {
		return payload, fmt.Errorf("invalid task complete: %w", err)
	}
	if err := domain.ValidateSHA256Hex(payload.ProposalSHA256, "task complete proposalSha256"); err != nil {
		return payload, fmt.Errorf("invalid task complete: %w", err)
	}
	if err := identity.Validate(payload.CompletedBy); err != nil {
		return payload, fmt.Errorf("invalid task complete: %w", err)
	}
	if err := domain.ValidateGitSHAHex(strings.TrimSpace(payload.CompletedHeadSHA), "task complete completedHeadSHA"); err != nil {
		return payload, fmt.Errorf("invalid task complete completedHeadSHA")
	}
	if strings.TrimSpace(payload.Target) == "" {
		return payload, fmt.Errorf("invalid task complete target")
	}
	if strings.TrimSpace(payload.LeaseID) == "" {
		return payload, fmt.Errorf("invalid task complete leaseId")
	}
	return payload, nil
}

// RegisterTaskRoutes attaches collaboration routes to the composition-root
// mux. Task transport stays outside the evidence HTTP adapter.
func RegisterTaskRoutes(mux *http.ServeMux, service application.TaskService, publishers ...*events.Publisher) {
	publish := func(event events.Event) {
		for _, publisher := range publishers {
			publisher.Publish(event)
		}
	}
	mux.HandleFunc("POST /v1/tasks/submit", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		var submission domain.TaskSubmission
		if err := decoder.Decode(&submission); err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, "invalid task submission: "+err.Error())
			return
		}
		if err := submission.Validate(); err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, "invalid task submission: "+err.Error())
			return
		}
		result, err := service.Submit(r.Context(), submission)
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		publish(events.Event{Type: "task.verified", RepositoryID: string(submission.Task.RepositoryID), ServiceID: string(submission.Task.ServiceID), TaskID: submission.Task.TaskID, Timestamp: time.Now().UTC()})
		writeJSONWithRequestID(w, requestID, status, result)
	})

	mux.HandleFunc("GET /v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		filter, err := repositoryFilter(r)
		if err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, "invalid repositoryId filter: "+err.Error())
			return
		}
		summaries, err := service.List(r.Context(), string(filter))
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusOK, map[string]any{"tasks": summaries})
	})

	mux.HandleFunc("GET /v1/tasks/{repositoryId}/{serviceId}/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		ref := domain.TaskRef{
			RepositoryID: domain.RepositoryID(r.PathValue("repositoryId")),
			ServiceID:    domain.ServiceID(r.PathValue("serviceId")),
			TaskID:       r.PathValue("taskId"),
		}
		if err := ref.Validate(); err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, "invalid task ref: "+err.Error())
			return
		}
		detail, err := service.Get(r.Context(), ref)
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		writeJSONWithRequestID(w, requestID, http.StatusOK, detail)
	})

	mux.HandleFunc("POST /v1/tasks/claim", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		payload, err := decodeTaskClaim(w, r)
		if err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, err.Error())
			return
		}
		result, err := service.Claim(r.Context(), payload.Task, payload.ProposalSHA256, payload.ClaimedBy)
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		publish(events.Event{Type: "task.claimed", RepositoryID: string(payload.Task.RepositoryID), ServiceID: string(payload.Task.ServiceID), TaskID: payload.Task.TaskID, Timestamp: time.Now().UTC()})
		writeJSONWithRequestID(w, requestID, status, result)
	})

	mux.HandleFunc("POST /v1/tasks/complete-local", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		payload, err := decodeTaskCompleteLocal(w, r)
		if err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, err.Error())
			return
		}
		result, err := service.CompleteLocal(r.Context(), payload.Task, payload.ProposalSHA256, payload.CompletedBy, strings.TrimSpace(payload.LocalHeadSHA), strings.TrimSpace(payload.Target), strings.TrimSpace(payload.LeaseID))
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		publish(events.Event{Type: "task.completed_local", RepositoryID: string(payload.Task.RepositoryID), ServiceID: string(payload.Task.ServiceID), TaskID: payload.Task.TaskID, Timestamp: time.Now().UTC()})
		writeJSONWithRequestID(w, requestID, status, result)
	})

	mux.HandleFunc("POST /v1/tasks/complete", func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		defer r.Body.Close()
		payload, err := decodeTaskComplete(w, r)
		if err != nil {
			writeTaskError(w, requestID, http.StatusBadRequest, "invalid_request", false, err.Error())
			return
		}
		result, err := service.Complete(r.Context(), payload.Task, payload.ProposalSHA256, payload.CompletedBy, strings.TrimSpace(payload.CompletedHeadSHA), strings.TrimSpace(payload.Target), strings.TrimSpace(payload.LeaseID))
		if err != nil {
			writeTaskClassifiedError(w, requestID, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		publish(events.Event{Type: "task.completed", RepositoryID: string(payload.Task.RepositoryID), ServiceID: string(payload.Task.ServiceID), TaskID: payload.Task.TaskID, Timestamp: time.Now().UTC()})
		writeJSONWithRequestID(w, requestID, status, result)
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

func writeTaskError(w http.ResponseWriter, requestID string, status int, code string, retryable bool, detail string) {
	writeJSONError(w, status, code, retryable, requestID, detail)
}

func writeTaskClassifiedError(w http.ResponseWriter, requestID string, err error) {
	status, code, retryable := taskErrorClass(err)
	writeJSONError(w, status, code, retryable, requestID, err.Error())
}

type taskErrorMapping struct {
	target    error
	status    int
	code      string
	retryable bool
}

var taskErrorMappings = []taskErrorMapping{
	{target: domain.ErrTaskProposalMissing, status: http.StatusNotFound, code: "not_found"},
	{target: domain.ErrTaskProposalMismatch, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskAlreadyVerified, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskAlreadyClaimed, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskAlreadyCompleted, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskNotVerified, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskNotClaimed, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskLeaseNotHeld, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskDependencyNotMet, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrTaskDependencyCycle, status: http.StatusConflict, code: "state_conflict"},
	{target: domain.ErrScopeDocumentMissing, status: http.StatusUnprocessableEntity, code: "scope_missing"},
}

func taskErrorClass(err error) (int, string, bool) {
	for _, mapping := range taskErrorMappings {
		if errors.Is(err, mapping.target) {
			return mapping.status, mapping.code, mapping.retryable
		}
	}
	return http.StatusServiceUnavailable, "service_unavailable", true
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
