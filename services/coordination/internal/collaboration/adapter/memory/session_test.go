package memory_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/memory"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

func TestSessionStoreRegisterHeartbeatExpireClose(t *testing.T) {
	base := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	now := base
	clock := func() time.Time { return now }
	store, err := memory.NewSessionStore(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, err := domain.NewRepositoryRef("repo-main")
	if err != nil {
		t.Fatal(err)
	}
	ref, err := domain.NewSessionRef(repository, "session-a")
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.Register(context.Background(), domain.SessionRegisterRequest{
		Ref: ref, Owner: "agent-a", TTL: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.CoordinatorEpoch != 7 || session.FencingToken == 0 {
		t.Fatalf("missing session fencing identity: %+v", session)
	}
	if _, err := store.Register(context.Background(), domain.SessionRegisterRequest{
		Ref: ref, Owner: "agent-b", TTL: 10 * time.Second,
	}); !errors.Is(err, domain.ErrSessionExists) {
		t.Fatalf("second register error = %v, want ErrSessionExists", err)
	}
	if _, err := store.Heartbeat(context.Background(), domain.SessionHeartbeat{
		Credential: session.Credential(), TTL: 10 * time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	stale := session.Credential()
	stale.FencingToken++
	if _, err := store.Heartbeat(context.Background(), domain.SessionHeartbeat{
		Credential: stale, TTL: 10 * time.Second,
	}); !errors.Is(err, domain.ErrSessionStale) {
		t.Fatalf("stale heartbeat error = %v, want ErrSessionStale", err)
	}
	now = now.Add(time.Minute)
	if _, ok, err := store.Get(context.Background(), ref); err != nil || ok {
		t.Fatalf("expired session lookup = (%v, %v), want (false, nil)", ok, err)
	}
	if err := store.Close(context.Background(), session.Credential()); err != nil {
		t.Fatalf("expired close should be idempotent: %v", err)
	}
}

func TestSessionStoreConcurrentHeartbeatAndList(t *testing.T) {
	base := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return base }
	store, err := memory.NewSessionStore(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	ref, _ := domain.NewSessionRef(repository, "session-a")
	session, err := store.Register(context.Background(), domain.SessionRegisterRequest{
		Ref: ref, Owner: "agent-a", TTL: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential := session.Credential()
	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() {
			_, err := store.Heartbeat(context.Background(), domain.SessionHeartbeat{
				Credential: credential, TTL: 10 * time.Second,
			})
			errs <- err
		}()
	}
	for i := 0; i < 10; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent heartbeat failed: %v", err)
		}
	}
	sessions, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Ref != ref {
		t.Fatalf("listed %+v, want one registered session", sessions)
	}
}
