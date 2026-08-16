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

// RegisterLeaseRoutes exposes the ephemeral LeaseStore (semantic locks). Leases
// are live, high-frequency runtime state: they are never written to Git and
// cannot be recreated from history; a service restart invalidates them via the
// coordinator epoch. When a publisher is supplied, lifecycle transitions are
// emitted as best-effort live events.
func RegisterLeaseRoutes(mux *http.ServeMux, store port.LeaseStore, publishers ...*events.Publisher) {
	publish := func(event events.Event) {
		for _, publisher := range publishers {
			publisher.Publish(event)
		}
	}
	mux.HandleFunc("POST /v1/leases/acquire", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Key        domain.LeaseKey `json:"key"`
			Owner      string          `json:"owner"`
			TTLSeconds int64           `json:"ttlSeconds"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid lease acquire: " + err.Error()})
			return
		}
		lease, err := store.Acquire(r.Context(), domain.LeaseRequest{Key: payload.Key, Owner: payload.Owner, TTL: time.Duration(payload.TTLSeconds) * time.Second})
		if err != nil {
			writeLeaseError(w, err)
			return
		}
		publish(events.Event{Type: "lease.acquired", RepositoryID: string(lease.Key.RepositoryID), Target: lease.Key.Target, Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusCreated, lease)
	})

	mux.HandleFunc("POST /v1/leases/renew", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Credential domain.LeaseCredential `json:"credential"`
			TTLSeconds int64                  `json:"ttlSeconds"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid lease renew: " + err.Error()})
			return
		}
		lease, err := store.Renew(r.Context(), domain.LeaseRenewal{Credential: payload.Credential, TTL: time.Duration(payload.TTLSeconds) * time.Second})
		if err != nil {
			writeLeaseError(w, err)
			return
		}
		publish(events.Event{Type: "lease.renewed", RepositoryID: string(lease.Key.RepositoryID), Target: lease.Key.Target, Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusOK, lease)
	})

	mux.HandleFunc("POST /v1/leases/release", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var payload struct {
			Credential domain.LeaseCredential `json:"credential"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid lease release: " + err.Error()})
			return
		}
		if err := store.Release(r.Context(), payload.Credential); err != nil {
			writeLeaseError(w, err)
			return
		}
		publish(events.Event{Type: "lease.released", Timestamp: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]bool{"released": true})
	})

	mux.HandleFunc("GET /v1/leases", func(w http.ResponseWriter, r *http.Request) {
		filter, err := repositoryFilter(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repositoryId filter: " + err.Error()})
			return
		}
		leases, err := store.List(r.Context())
		if err != nil {
			writeLeaseError(w, err)
			return
		}
		if filter != "" {
			filtered := make([]domain.Lease, 0, len(leases))
			for _, lease := range leases {
				if lease.Key.RepositoryID == filter {
					filtered = append(filtered, lease)
				}
			}
			leases = filtered
		}
		writeJSON(w, http.StatusOK, map[string]any{"leases": leases})
	})

	mux.HandleFunc("GET /v1/leases/{repositoryId}/{target}", func(w http.ResponseWriter, r *http.Request) {
		key := domain.LeaseKey{
			RepositoryID: domain.RepositoryID(r.PathValue("repositoryId")),
			Target:       r.PathValue("target"),
		}
		lease, exists, err := store.Get(r.Context(), key)
		if err != nil {
			writeLeaseError(w, err)
			return
		}
		if !exists {
			writeJSON(w, http.StatusNotFound, map[string]bool{"held": false})
			return
		}
		writeJSON(w, http.StatusOK, lease)
	})
}

func writeLeaseError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrLeaseHeld):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrLeaseExpired):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrLeaseStale):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lease operation failed: " + err.Error()})
	}
}
