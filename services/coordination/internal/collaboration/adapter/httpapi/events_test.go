package httpapi_test

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
)

func TestEventRoutesStreamsPublishedEvents(t *testing.T) {
	publisher := events.NewPublisher()
	mux := http.NewServeMux()
	httpapi.RegisterEventRoutes(mux, publisher)
	server := httptest.NewServer(mux)
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", contentType)
	}

	publisher.Publish(events.Event{Type: "session.registered", RepositoryID: "repo-main", SessionID: "session-a", Timestamp: time.Now().UTC()})

	reader := bufio.NewReader(response.Body)
	var sawData bool
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		if strings.HasPrefix(line, "data: ") {
			if strings.Contains(line, "session.registered") && strings.Contains(line, "session-a") {
				sawData = true
				break
			}
		}
	}
	if !sawData {
		t.Fatal("SSE stream did not deliver the published event")
	}
}
