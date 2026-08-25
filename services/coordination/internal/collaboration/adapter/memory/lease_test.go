package memory_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/memory"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

func TestStoreUsesFencingAndExpiresLeases(t *testing.T) {
	now := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store, err := memory.New(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, err := domain.NewRepositoryRef("repo-main")
	if err != nil {
		t.Fatal(err)
	}
	key, err := domain.NewLeaseKey(repository, "function:Authority.AppendEvidence")
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: key, Owner: "agent-a", TTL: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if lease.CoordinatorEpoch != 7 || lease.FencingToken == 0 {
		t.Fatalf("missing lease fencing identity: %+v", lease)
	}
	if _, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: key, Owner: "agent-b", TTL: 10 * time.Second}); !errors.Is(err, domain.ErrLeaseHeld) {
		t.Fatalf("second owner error = %v, want ErrLeaseHeld", err)
	}
	if _, err := store.Renew(context.Background(), domain.LeaseRenewal{Credential: lease.Credential(), TTL: 10 * time.Second}); err != nil {
		t.Fatal(err)
	}
	stale := lease.Credential()
	stale.FencingToken++
	if _, err := store.Renew(context.Background(), domain.LeaseRenewal{Credential: stale, TTL: 10 * time.Second}); !errors.Is(err, domain.ErrLeaseStale) {
		t.Fatalf("stale renewal error = %v, want ErrLeaseStale", err)
	}
	now = now.Add(time.Minute)
	if _, ok, err := store.Get(context.Background(), key); err != nil || ok {
		t.Fatalf("expired lease lookup = (%v, %v), want (false, nil)", ok, err)
	}
	if err := store.Release(context.Background(), lease.Credential()); err != nil {
		t.Fatalf("expired release should be idempotent: %v", err)
	}
}

func TestStoreListReturnsOnlyUnexpiredLeases(t *testing.T) {
	base := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	now := base
	clock := func() time.Time { return now }
	store, err := memory.New(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	short, _ := domain.NewLeaseKey(repository, "function:short")
	long, _ := domain.NewLeaseKey(repository, "function:long")
	if _, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: short, Owner: "agent-a", TTL: time.Second}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: long, Owner: "agent-b", TTL: time.Minute}); err != nil {
		t.Fatal(err)
	}
	leases, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 2 {
		t.Fatalf("listed %d leases, want 2", len(leases))
	}
	now = now.Add(2 * time.Second)
	leases, err = store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 || leases[0].Key != long {
		t.Fatalf("listed %+v after expiry, want only long lease", leases)
	}
}

func TestStoreRejectsOutOfBoundsTTLAndInvalidLeaseKey(t *testing.T) {
	store, err := memory.New(1, time.Second, time.Minute, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	key, _ := domain.NewLeaseKey(repository, "function:file.ts#function")
	if _, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: key, Owner: "agent-a", TTL: time.Millisecond}); err == nil {
		t.Fatal("out-of-bounds TTL was accepted")
	}
	if _, err := domain.NewLeaseKey(repository, "\n"); err == nil {
		t.Fatal("invalid semantic target was accepted")
	}
}

func TestConcurrentAcquireSameKeyExactlyOneWinner(t *testing.T) {
	clock := func() time.Time { return time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC) }
	store, err := memory.New(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	key, _ := domain.NewLeaseKey(repository, "function:Authority.AppendEvidence")
	const workers = 10
	results := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func(id int) {
			_, err := store.Acquire(context.Background(), domain.LeaseRequest{
				Key: key, Owner: "agent-" + string(rune('a'+id)), TTL: 10 * time.Second,
			})
			results <- err
		}(i)
	}
	winners := 0
	for i := 0; i < workers; i++ {
		err := <-results
		switch {
		case err == nil:
			winners++
		case errors.Is(err, domain.ErrLeaseHeld):
		default:
			t.Fatalf("unexpected acquire error: %v", err)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent acquires won %d times, want exactly 1", winners)
	}
}

func TestConcurrentRenewSameCredentialAllSucceedAndExtend(t *testing.T) {
	base := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return base }
	store, err := memory.New(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	key, _ := domain.NewLeaseKey(repository, "function:Authority.AppendEvidence")
	lease, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: key, Owner: "agent-a", TTL: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	credential := lease.Credential()
	renewed := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() {
			_, err := store.Renew(context.Background(), domain.LeaseRenewal{Credential: credential, TTL: 10 * time.Second})
			renewed <- err
		}()
	}
	for i := 0; i < 10; i++ {
		if err := <-renewed; err != nil {
			t.Fatalf("concurrent renewal failed: %v", err)
		}
	}
	// Renew is a refresh, not an accumulation: ExpiresAt becomes now+TTL.
	// Concurrent renewals must all succeed (no stale credential races) and
	// leave the lease present and unexpired.
	final, ok, err := store.Get(context.Background(), key)
	if err != nil || !ok {
		t.Fatalf("lease lost after concurrent renewals: ok=%v err=%v", ok, err)
	}
	if !final.ExpiresAt.After(base) {
		t.Fatalf("renewal left an expired lease: %v", final.ExpiresAt)
	}
}

func TestConcurrentReleaseIsIdempotentAndLeavesNoLease(t *testing.T) {
	clock := func() time.Time { return time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC) }
	store, err := memory.New(7, time.Second, time.Minute, clock)
	if err != nil {
		t.Fatal(err)
	}
	repository, _ := domain.NewRepositoryRef("repo-main")
	key, _ := domain.NewLeaseKey(repository, "function:Authority.AppendEvidence")
	lease, err := store.Acquire(context.Background(), domain.LeaseRequest{Key: key, Owner: "agent-a", TTL: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	credential := lease.Credential()
	released := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() {
			released <- store.Release(context.Background(), credential)
		}()
	}
	for i := 0; i < 10; i++ {
		if err := <-released; err != nil {
			t.Fatalf("concurrent release failed (should be idempotent): %v", err)
		}
	}
	if _, ok, err := store.Get(context.Background(), key); err != nil || ok {
		t.Fatalf("lease still present after concurrent release: ok=%v err=%v", ok, err)
	}
}
