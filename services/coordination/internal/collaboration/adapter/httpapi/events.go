package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
)

// RegisterEventRoutes exposes a heartbeat-backed Server-Sent Events stream of
// live coordination notifications. Consumers reconnect when the stream ends;
// events are best-effort signals, never durable coordination facts.
func RegisterEventRoutes(mux *http.ServeMux, publisher *events.Publisher) {
	mux.HandleFunc("GET /v1/events", func(w http.ResponseWriter, r *http.Request) {
		filter, err := repositoryFilter(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repositoryId filter: " + err.Error()})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		writeSSE(w, flusher, ": connected\n\n")

		eventsChannel, cancel := publisher.Subscribe()
		defer cancel()
		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case event, ok := <-eventsChannel:
				if !ok {
					return
				}
				// A filtered stream delivers only events that carry the
				// requested repository identity; repository-less lifecycle
				// signals are kept for the unfiltered cross-project view.
				if filter != "" && event.RepositoryID != string(filter) {
					continue
				}
				payload, err := json.Marshal(event)
				if err != nil {
					continue
				}
				writeSSE(w, flusher, fmt.Sprintf("event: %s\ndata: %s\n\n", sseEventName(event.Type), payload))
			case <-heartbeat.C:
				writeSSE(w, flusher, ": heartbeat\n\n")
			}
		}
	})
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, payload string) {
	_, _ = w.Write([]byte(payload))
	flusher.Flush()
}

func sseEventName(eventType string) string {
	var builder strings.Builder
	for _, char := range eventType {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9', char == '.', char == '-', char == '_':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	return builder.String()
}
