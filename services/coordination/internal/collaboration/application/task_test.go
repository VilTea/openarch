package application

import (
	"context"
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

const (
	proposalSHA = "73b6c4b02e65ae7deb4f6b681c7f72c6679dea3e7de1cb35d8c863bc52029701"
	headSHA     = "20e4982edbc908c3fec8254c9410d91430f98ca5"
)

type fakeTaskStore struct {
	events               []domain.TaskLifecycleEvent
	proposalContentSHA   string
	proposalDependsOn    []domain.TaskRef
	proposalGoal         string
	proposalScope        []string
	proposalConstraints  []string
	proposalVerification []string
	proposalDeliverable  string
}

func (f *fakeTaskStore) ReadProposal(context.Context, domain.TaskRef) (domain.TaskProposalRecord, bool, error) {
	sha := f.proposalContentSHA
	if sha == "" {
		sha = proposalSHA
	}
	return domain.TaskProposalRecord{Proposal: domain.TaskProposal{
		Title: "test task", Hypothesis: "test hypothesis", RequestedBy: "agent-1", DependsOn: f.proposalDependsOn,
		Goal: f.proposalGoal, Scope: f.proposalScope, Constraints: f.proposalConstraints,
		Verification: f.proposalVerification, Deliverable: f.proposalDeliverable,
	}, ContentSHA256: sha}, true, nil
}
func (f *fakeTaskStore) ListProposals(context.Context) ([]domain.TaskProposalRecord, error) {
	sha := f.proposalContentSHA
	if sha == "" {
		sha = proposalSHA
	}
	return []domain.TaskProposalRecord{{
		Proposal:      domain.TaskProposal{Task: taskRef(), Title: "listed task", Hypothesis: "list lifecycle", RequestedBy: "agent-1", DependsOn: f.proposalDependsOn},
		ContentSHA256: sha,
	}}, nil
}
func (f *fakeTaskStore) ListLifecycle(context.Context, domain.TaskRef) ([]domain.TaskLifecycleEvent, error) {
	return f.events, nil
}
func (f *fakeTaskStore) ListLifecycleStreams(context.Context) (map[domain.TaskRef][]domain.TaskLifecycleEvent, error) {
	return map[domain.TaskRef][]domain.TaskLifecycleEvent{taskRef(): f.events}, nil
}
func (f *fakeTaskStore) AppendLifecycle(_ context.Context, event domain.TaskLifecycleEvent) error {
	f.events = append(f.events, event)
	return nil
}

type fakeScopeStore struct{}

func (fakeScopeStore) Read(context.Context) (domain.ScopeRegistry, error) {
	return domain.ScopeRegistry{Services: []domain.ServiceDocument{{Service: domain.ServiceRef{RepositoryID: "repo-1", ID: "svc-a"}}}}, nil
}
func (fakeScopeStore) ListLegacyProjects(context.Context) ([]domain.LegacyProjectRef, error) {
	return nil, nil
}

type fakeDocsSync struct{}

func (fakeDocsSync) RefreshFromRemote(context.Context, string, string) (domain.DurableRepositoryDescriptor, error) {
	return domain.DurableRepositoryDescriptor{}, nil
}
func (fakeDocsSync) RefreshFromRemoteContaining(context.Context, string, string) (domain.DurableRepositoryDescriptor, error) {
	return domain.DurableRepositoryDescriptor{}, nil
}

type fakeLeaseStore struct {
	held map[domain.LeaseKey]domain.Lease
}

func (f *fakeLeaseStore) Get(_ context.Context, key domain.LeaseKey) (domain.Lease, bool, error) {
	if f.held == nil {
		return domain.Lease{}, false, nil
	}
	lease, ok := f.held[key]
	return lease, ok, nil
}

func newTestService(t *testing.T, store *fakeTaskStore) TaskService {
	return newTestServiceWithLease(t, store, &fakeLeaseStore{})
}

func newTestServiceWithLease(t *testing.T, store *fakeTaskStore, leases *fakeLeaseStore) TaskService {
	t.Helper()
	authenticator, err := signing.NewEd25519TaskEventAuthenticator("coordination-task-v1", signingTestKey())
	if err != nil {
		t.Fatal(err)
	}
	return TaskService{
		docsSync: fakeDocsSync{},
		scopes:   fakeScopeStore{},
		tasks:    store,
		auth:     authenticator,
		leases:   leases,
		clock:    func() time.Time { return time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC) },
	}
}

func heldLease(owner string) *fakeLeaseStore {
	return &fakeLeaseStore{held: map[domain.LeaseKey]domain.Lease{
		{RepositoryID: "repo-1", Target: "file:src/target.ts"}: {
			Key:              domain.LeaseKey{RepositoryID: "repo-1", Target: "file:src/target.ts"},
			LeaseID:          "lease-1",
			Owner:            owner,
			FencingToken:     1,
			CoordinatorEpoch: 1,
			ExpiresAt:        time.Date(2026, 8, 3, 13, 0, 0, 0, time.UTC),
		},
	}}
}

func signingTestKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed([]byte("01234567890123456789012345678901"))
}

func taskRef() domain.TaskRef {
	return domain.TaskRef{RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-1"}
}

func signedLifecycle(t *testing.T, service TaskService, existing []domain.TaskLifecycleEvent, eventType string, mutate func(*domain.TaskLifecycleEvent)) []domain.TaskLifecycleEvent {
	t.Helper()
	event := domain.TaskLifecycleEvent{
		SchemaVersion:   domain.TaskEventSchemaVersion,
		Task:            taskRef(),
		Type:            eventType,
		ProposalSHA256:  proposalSHA,
		VerifiedHeadSHA: headSHA,
		RecordedAt:      service.clock().UTC(),
	}
	if mutate != nil {
		mutate(&event)
	}
	if err := domain.LinkLifecycleEvent(existing, &event); err != nil {
		t.Fatal(err)
	}
	signed, err := service.auth.SignTaskEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	return append(append([]domain.TaskLifecycleEvent{}, existing...), signed)
}

func TestClaimLifecycle(t *testing.T) {
	t.Run("rejects claim on unverified task", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		_, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
		if !errors.Is(err, domain.ErrTaskNotVerified) {
			t.Fatalf("want ErrTaskNotVerified, got %v", err)
		}
	})

	t.Run("claims a verified task", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		store := &fakeTaskStore{events: signedLifecycle(t, service, nil, "verified", nil)}
		service = newTestService(t, store)
		result, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
		if err != nil {
			t.Fatal(err)
		}
		if !result.Created || result.Status.State != "claimed" || result.Status.ClaimedBy != "agent-2" {
			t.Fatalf("claim result = %+v", result)
		}
		if err := service.auth.VerifyTaskEvent(store.events[len(store.events)-1]); err != nil {
			t.Fatalf("claimed event signature invalid: %v", err)
		}
	})

	t.Run("same executor retry is idempotent", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		store := &fakeTaskStore{events: events}
		service = newTestService(t, store)
		result, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
		if err != nil {
			t.Fatal(err)
		}
		if result.Created || result.Status.State != "claimed" {
			t.Fatalf("idempotent retry = %+v", result)
		}
	})

	t.Run("different executor is rejected", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		store := &fakeTaskStore{events: events}
		service = newTestService(t, store)
		_, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-3")
		if !errors.Is(err, domain.ErrTaskAlreadyClaimed) {
			t.Fatalf("want ErrTaskAlreadyClaimed, got %v", err)
		}
	})
}

func TestClaimRejectsIncompleteDependency(t *testing.T) {
	service := newTestService(t, &fakeTaskStore{})
	events := signedLifecycle(t, service, nil, "verified", nil)
	store := &fakeTaskStore{
		events: events,
		proposalDependsOn: []domain.TaskRef{{
			RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-dep",
		}},
	}
	service = newTestService(t, store)
	_, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
	if !errors.Is(err, domain.ErrTaskDependencyNotMet) {
		t.Fatalf("want ErrTaskDependencyNotMet, got %v", err)
	}
}

func TestListLifecycle(t *testing.T) {
	service := newTestService(t, &fakeTaskStore{})
	events := signedLifecycle(t, service, nil, "verified", nil)
	store := &fakeTaskStore{events: events}
	service = newTestService(t, store)

	summaries, err := service.List(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 {
		t.Fatalf("list length = %d, want 1", len(summaries))
	}
	summary := summaries[0]
	if summary.Task != taskRef() || summary.Title != "listed task" || summary.ProposalSHA256 != proposalSHA || summary.Status.State != "verified" || summary.Status.VerifiedHeadSHA != headSHA {
		t.Fatalf("unexpected task summary: %+v", summary)
	}

	if filtered, err := service.List(context.Background(), "repo-1"); err != nil || len(filtered) != 1 {
		t.Fatalf("repository filter list = %d, err=%v", len(filtered), err)
	}
	if filtered, err := service.List(context.Background(), "repo-other"); err != nil || len(filtered) != 0 {
		t.Fatalf("unknown repository filter list = %d, err=%v", len(filtered), err)
	}
	if _, err := service.List(context.Background(), "bad id"); err == nil {
		t.Fatal("invalid repository filter was accepted")
	}
}

func TestProposalMismatchFailsClosed(t *testing.T) {
	service := newTestService(t, &fakeTaskStore{})
	events := signedLifecycle(t, service, nil, "verified", nil)
	store := &fakeTaskStore{events: events, proposalContentSHA: strings.Repeat("d", 64)}
	service = newTestService(t, store)

	if _, err := service.List(context.Background(), ""); !errors.Is(err, domain.ErrTaskProposalMismatch) {
		t.Fatalf("List proposal mismatch error = %v, want ErrTaskProposalMismatch", err)
	}
	if _, err := service.Get(context.Background(), taskRef()); !errors.Is(err, domain.ErrTaskProposalMismatch) {
		t.Fatalf("Get proposal mismatch error = %v, want ErrTaskProposalMismatch", err)
	}
	if _, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2"); !errors.Is(err, domain.ErrTaskProposalMismatch) {
		t.Fatalf("Claim proposal mismatch error = %v, want ErrTaskProposalMismatch", err)
	}
}

func TestCompleteLocalLifecycle(t *testing.T) {
	t.Run("rejects complete-local on unclaimed task", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		_, err := service.CompleteLocal(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if !errors.Is(err, domain.ErrTaskNotClaimed) {
			t.Fatalf("want ErrTaskNotClaimed, got %v", err)
		}
	})

	t.Run("rejects complete-local without lease", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, &fakeLeaseStore{})
		_, err := service.CompleteLocal(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if !errors.Is(err, domain.ErrTaskLeaseNotHeld) {
			t.Fatalf("want ErrTaskLeaseNotHeld, got %v", err)
		}
	})

	t.Run("completes local with held lease", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		result, err := service.CompleteLocal(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if err != nil {
			t.Fatal(err)
		}
		if !result.Created || result.Status.State != "completed_local" || result.Status.CompletedBy != "agent-2" || result.Status.LocalHeadSHA != headSHA {
			t.Fatalf("complete-local result = %+v", result)
		}
		if err := service.auth.VerifyTaskEvent(store.events[len(store.events)-1]); err != nil {
			t.Fatalf("completed_local event signature invalid: %v", err)
		}
	})
}

func TestCompleteLifecycle(t *testing.T) {
	t.Run("rejects final complete before completed_local", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if !errors.Is(err, domain.ErrTaskNotClaimed) {
			t.Fatalf("want ErrTaskNotClaimed, got %v", err)
		}
	})

	t.Run("rejects final complete without lease", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		events = signedLifecycle(t, service, events, "completed_local", func(e *domain.TaskLifecycleEvent) {
			e.CompletedBy = "agent-2"
			e.LeaseID = "lease-1"
			e.LocalHeadSHA = headSHA
		})
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, &fakeLeaseStore{})
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if !errors.Is(err, domain.ErrTaskLeaseNotHeld) {
			t.Fatalf("want ErrTaskLeaseNotHeld, got %v", err)
		}
	})

	t.Run("completes after completed_local with held lease", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		events = signedLifecycle(t, service, events, "completed_local", func(e *domain.TaskLifecycleEvent) {
			e.CompletedBy = "agent-2"
			e.LeaseID = "lease-1"
			e.LocalHeadSHA = headSHA
		})
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		result, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if err != nil {
			t.Fatal(err)
		}
		if !result.Created || result.Status.State != "completed" || result.Status.CompletedBy != "agent-2" || result.Status.CompletedHeadSHA != headSHA {
			t.Fatalf("complete result = %+v", result)
		}
		if err := service.auth.VerifyTaskEvent(store.events[len(store.events)-1]); err != nil {
			t.Fatalf("completed event signature invalid: %v", err)
		}
	})

	t.Run("rejects repeated final completion", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		events = signedLifecycle(t, service, events, "completed_local", func(e *domain.TaskLifecycleEvent) {
			e.CompletedBy = "agent-2"
			e.LeaseID = "lease-1"
			e.LocalHeadSHA = headSHA
		})
		events = signedLifecycle(t, service, events, "completed", func(e *domain.TaskLifecycleEvent) {
			e.CompletedBy = "agent-2"
			e.LeaseID = "lease-1"
			e.CompletedHeadSHA = headSHA
		})
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA, "file:src/target.ts", "lease-1")
		if !errors.Is(err, domain.ErrTaskAlreadyCompleted) {
			t.Fatalf("want ErrTaskAlreadyCompleted, got %v", err)
		}
	})

	t.Run("rejects invalid completed head", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		events := signedLifecycle(t, service, nil, "verified", nil)
		events = signedLifecycle(t, service, events, "claimed", func(e *domain.TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
		events = signedLifecycle(t, service, events, "completed_local", func(e *domain.TaskLifecycleEvent) {
			e.CompletedBy = "agent-2"
			e.LeaseID = "lease-1"
			e.LocalHeadSHA = headSHA
		})
		store := &fakeTaskStore{events: events}
		service = newTestServiceWithLease(t, store, heldLease("agent-2"))
		if _, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", "zzz", "file:src/target.ts", "lease-1"); err == nil {
			t.Fatal("expected validation error for invalid completedHeadSHA")
		}
	})
}

func TestGetReturnsRichProposalFields(t *testing.T) {
	service := newTestService(t, &fakeTaskStore{})
	store := &fakeTaskStore{
		events:               signedLifecycle(t, service, nil, "verified", nil),
		proposalGoal:         "Add login",
		proposalScope:        []string{"src/auth"},
		proposalConstraints:  []string{"do not touch schema"},
		proposalVerification: []string{"pnpm test auth"},
		proposalDeliverable:  "summary and diff",
	}
	service = newTestService(t, store)
	detail, err := service.Get(context.Background(), taskRef())
	if err != nil {
		t.Fatal(err)
	}
	if detail.Goal != "Add login" || len(detail.Scope) != 1 || detail.Scope[0] != "src/auth" ||
		len(detail.Constraints) != 1 || detail.Constraints[0] != "do not touch schema" ||
		len(detail.Verification) != 1 || detail.Verification[0] != "pnpm test auth" ||
		detail.Deliverable != "summary and diff" {
		t.Fatalf("rich proposal fields not returned: %+v", detail)
	}
}
