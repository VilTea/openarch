package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
)

// RegisterSessionRoutes exposes the live repository-bound session registry.
// Sessions are liveness plus fencing; durable session identity remains the
// responsibility of the Git-backed scope registry.
func RegisterSessionRoutes(mux *http.ServeMux, store port.LiveSessionStore, publishers ...*events.Publisher) {
	publish := func(event events.Event) {
		for _, publisher := range publishers {
			publisher.Publish(event)
		}
	}
	mux.HandleFunc("POST /v1/sessions/register", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			RepositoryID domain.RepositoryID `json:"repositoryId"`
			SessionID    string              `json:"sessionId"`
			Owner        string              `json:"owner"`
			TTLSeconds   int64               `json:"ttlSeconds"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session register: " + err.Error()})
			return
		}
		ref := domain.SessionRef{RepositoryID: payload.RepositoryID, SessionID: payload.SessionID}
		session, err := store.Register(r.Context(), domain.SessionRegisterRequest{
			Ref: ref, Owner: payload.Owner, TTL: time.Duration(payload.TTLSeconds) * time.Second,
		})
		if err != nil {
			writeSessionError(w, err)
			return
		}
		publish(events.Event{Type: "session.registered", RepositoryID: string(session.Ref.RepositoryID), SessionID: session.Ref.SessionID, Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusCreated, session)
	})

	mux.HandleFunc("POST /v1/sessions/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Credential domain.SessionCredential `json:"credential"`
			TTLSeconds int64                    `json:"ttlSeconds"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session heartbeat: " + err.Error()})
			return
		}
		session, err := store.Heartbeat(r.Context(), domain.SessionHeartbeat{
			Credential: payload.Credential, TTL: time.Duration(payload.TTLSeconds) * time.Second,
		})
		if err != nil {
			writeSessionError(w, err)
			return
		}
		publish(events.Event{Type: "session.heartbeat", RepositoryID: string(session.Ref.RepositoryID), SessionID: session.Ref.SessionID, Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusOK, session)
	})

	mux.HandleFunc("POST /v1/sessions/close", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Credential domain.SessionCredential `json:"credential"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session close: " + err.Error()})
			return
		}
		if err := store.Close(r.Context(), payload.Credential); err != nil {
			writeSessionError(w, err)
			return
		}
		publish(events.Event{Type: "session.closed", Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]bool{"closed": true})
	})

	mux.HandleFunc("GET /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		filter, err := repositoryFilter(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repositoryId filter: " + err.Error()})
			return
		}
		sessions, err := store.List(r.Context())
		if err != nil {
			writeSessionError(w, err)
			return
		}
		if filter != "" {
			filtered := make([]domain.Session, 0, len(sessions))
			for _, session := range sessions {
				if session.Ref.RepositoryID == filter {
					filtered = append(filtered, session)
				}
			}
			sessions = filtered
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
	})

	mux.HandleFunc("GET /v1/sessions/{repositoryId}/{sessionId}", func(w http.ResponseWriter, r *http.Request) {
		ref := domain.SessionRef{
			RepositoryID: domain.RepositoryID(r.PathValue("repositoryId")),
			SessionID:    r.PathValue("sessionId"),
		}
		session, exists, err := store.Get(r.Context(), ref)
		if err != nil {
			writeSessionError(w, err)
			return
		}
		if !exists {
			writeJSON(w, http.StatusNotFound, map[string]bool{"registered": false})
			return
		}
		writeJSON(w, http.StatusOK, session)
	})
}

func writeSessionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrSessionExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrSessionExpired), errors.Is(err, domain.ErrSessionUnknown):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrSessionStale):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session operation failed: " + err.Error()})
	}
}
