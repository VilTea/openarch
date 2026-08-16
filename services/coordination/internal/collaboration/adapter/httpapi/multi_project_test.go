package httpapi_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/memory"
)

func TestLiveReadViewsFilterByRepositoryID(t *testing.T) {
	clock := func() time.Time { return time.Now() }
	leaseStore, err := memory.New(1, time.Second, 10*time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	sessionStore, err := memory.NewSessionStore(1, time.Second, 10*time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	httpapi.RegisterLeaseRoutes(mux, leaseStore)
	httpapi.RegisterSessionRoutes(mux, sessionStore)

	post := func(path string, payload map[string]any, wantStatus int) {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)))
		if response.Code != wantStatus {
			t.Fatalf("POST %s status = %d, want %d: %s", path, response.Code, wantStatus, response.Body.String())
		}
	}

	for _, repositoryID := range []string{"repo-a", "repo-b"} {
		post("/v1/leases/acquire", map[string]any{
			"key":        map[string]string{"repositoryId": repositoryID, "target": "function#handle"},
			"owner":      "agent-" + repositoryID,
			"ttlSeconds": 30,
		}, http.StatusCreated)
		post("/v1/sessions/register", map[string]any{
			"repositoryId": repositoryID,
			"sessionId":    "session-1",
			"owner":        "agent-" + repositoryID,
			"ttlSeconds":   60,
		}, http.StatusCreated)
	}

	get := func(path string, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != wantStatus {
			t.Fatalf("GET %s status = %d, want %d: %s", path, response.Code, wantStatus, response.Body.String())
		}
		return response
	}

	var leaseList struct {
		Leases []struct {
			Key struct {
				RepositoryID string `json:"repositoryId"`
			} `json:"key"`
		} `json:"leases"`
	}
	if err := json.NewDecoder(get("/v1/leases?repositoryId=repo-a", http.StatusOK).Body).Decode(&leaseList); err != nil {
		t.Fatal(err)
	}
	if len(leaseList.Leases) != 1 || leaseList.Leases[0].Key.RepositoryID != "repo-a" {
		t.Fatalf("filtered lease list = %+v", leaseList.Leases)
	}
	if err := json.NewDecoder(get("/v1/leases?repositoryId=repo-c", http.StatusOK).Body).Decode(&leaseList); err != nil {
		t.Fatal(err)
	}
	if len(leaseList.Leases) != 0 {
		t.Fatalf("filtered lease list for unknown repo = %+v", leaseList.Leases)
	}

	var sessionList struct {
		Sessions []struct {
			Ref struct {
				RepositoryID string `json:"repositoryId"`
			} `json:"ref"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(get("/v1/sessions?repositoryId=repo-b", http.StatusOK).Body).Decode(&sessionList); err != nil {
		t.Fatal(err)
	}
	if len(sessionList.Sessions) != 1 || sessionList.Sessions[0].Ref.RepositoryID != "repo-b" {
		t.Fatalf("filtered session list = %+v", sessionList.Sessions)
	}

	get("/v1/leases?repositoryId=bad%20id", http.StatusBadRequest)
	get("/v1/sessions?repositoryId=bad%20id", http.StatusBadRequest)
}

func TestEventStreamFiltersByRepositoryID(t *testing.T) {
	publisher := events.NewPublisher()
	mux := http.NewServeMux()
	httpapi.RegisterEventRoutes(mux, publisher)
	server := httptest.NewServer(mux)
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/events?repositoryId=repo-main")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filtered SSE status = %d, want 200", response.StatusCode)
	}

	publisher.Publish(events.Event{Type: "session.registered", RepositoryID: "repo-other", SessionID: "session-other", Timestamp: time.Now().UTC()})
	publisher.Publish(events.Event{Type: "session.registered", RepositoryID: "repo-main", SessionID: "session-main", Timestamp: time.Now().UTC()})

	reader := bufio.NewReader(response.Body)
	sawMain, sawOther := false, false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		if strings.Contains(line, "session-main") {
			sawMain = true
			break
		}
		if strings.Contains(line, "session-other") {
			sawOther = true
		}
	}
	if !sawMain {
		t.Fatal("filtered SSE stream did not deliver the matching repository event")
	}
	if sawOther {
		t.Fatal("filtered SSE stream leaked an event from another repository")
	}
}
