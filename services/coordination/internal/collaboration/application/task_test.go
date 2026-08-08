package application

import (
	"context"
	"crypto/ed25519"
	"errors"
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
	events []domain.TaskLifecycleEvent
}

func (f *fakeTaskStore) ReadProposal(context.Context, domain.TaskRef) (domain.TaskProposalRecord, bool, error) {
	return domain.TaskProposalRecord{Proposal: domain.TaskProposal{RequestedBy: "agent-1"}, ContentSHA256: proposalSHA}, true, nil
}
func (f *fakeTaskStore) ListLifecycle(context.Context, domain.TaskRef) ([]domain.TaskLifecycleEvent, error) {
	return f.events, nil
}
func (f *fakeTaskStore) AppendLifecycle(_ context.Context, event domain.TaskLifecycleEvent) error {
	f.events = append(f.events, event)
	return nil
}

type fakeScopeStore struct{}

func (fakeScopeStore) Read(context.Context) (domain.ScopeRegistry, error) {
	return domain.ScopeRegistry{Services: []domain.ServiceDocument{{Service: domain.ServiceRef{RepositoryID: "repo-1", ID: "svc-a"}}}}, nil
}
func (fakeScopeStore) ListLegacyProjects(context.Context) ([]domain.LegacyProjectRef, error) { return nil, nil }

type fakeDocsSync struct{}

func (fakeDocsSync) RefreshFromRemote(context.Context, string, string) (domain.DurableRepositoryDescriptor, error) {
	return domain.DurableRepositoryDescriptor{}, nil
}
func (fakeDocsSync) RefreshFromRemoteContaining(context.Context, string, string) (domain.DurableRepositoryDescriptor, error) {
	return domain.DurableRepositoryDescriptor{}, nil
}

func newTestService(t *testing.T, store *fakeTaskStore) TaskService {
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
		clock:    func() time.Time { return time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC) },
	}
}

func signingTestKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed([]byte("01234567890123456789012345678901"))
}

func taskRef() domain.TaskRef {
	return domain.TaskRef{RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-1"}
}

func TestClaimLifecycle(t *testing.T) {
	verified := domain.TaskLifecycleEvent{
		SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "verified",
		ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA,
	}

	t.Run("rejects claim on unverified task", func(t *testing.T) {
		service := newTestService(t, &fakeTaskStore{})
		_, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
		if !errors.Is(err, domain.ErrTaskNotVerified) {
			t.Fatalf("want ErrTaskNotVerified, got %v", err)
		}
	})

	t.Run("claims a verified task", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{verified}}
		service := newTestService(t, store)
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
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{
			verified,
			{SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "claimed", ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA, ClaimedBy: "agent-2"},
		}}
		service := newTestService(t, store)
		result, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-2")
		if err != nil {
			t.Fatal(err)
		}
		if result.Created || result.Status.State != "claimed" {
			t.Fatalf("idempotent retry = %+v", result)
		}
	})

	t.Run("different executor is rejected", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{
			verified,
			{SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "claimed", ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA, ClaimedBy: "agent-2"},
		}}
		service := newTestService(t, store)
		_, err := service.Claim(context.Background(), taskRef(), proposalSHA, "agent-3")
		if !errors.Is(err, domain.ErrTaskAlreadyClaimed) {
			t.Fatalf("want ErrTaskAlreadyClaimed, got %v", err)
		}
	})
}

func TestCompleteLifecycle(t *testing.T) {
	verified := domain.TaskLifecycleEvent{
		SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "verified",
		ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA,
	}
	claimed := domain.TaskLifecycleEvent{
		SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "claimed",
		ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA, ClaimedBy: "agent-2",
	}

	t.Run("rejects complete on unclaimed task", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{verified}}
		service := newTestService(t, store)
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", "")
		if !errors.Is(err, domain.ErrTaskNotClaimed) {
			t.Fatalf("want ErrTaskNotClaimed, got %v", err)
		}
	})

	t.Run("rejects complete by a different executor", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{verified, claimed}}
		service := newTestService(t, store)
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-9", "")
		if !errors.Is(err, domain.ErrTaskNotClaimed) {
			t.Fatalf("want ErrTaskNotClaimed, got %v", err)
		}
	})

	t.Run("completes a claimed task with head evidence", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{verified, claimed}}
		service := newTestService(t, store)
		result, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", headSHA)
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

	t.Run("rejects repeated completion", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{
			verified, claimed,
			{SchemaVersion: domain.TaskEventSchemaVersion, Task: taskRef(), Type: "completed", ProposalSHA256: proposalSHA, VerifiedHeadSHA: headSHA, CompletedBy: "agent-2"},
		}}
		service := newTestService(t, store)
		_, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", "")
		if !errors.Is(err, domain.ErrTaskAlreadyCompleted) {
			t.Fatalf("want ErrTaskAlreadyCompleted, got %v", err)
		}
	})

	t.Run("rejects invalid completed head", func(t *testing.T) {
		store := &fakeTaskStore{events: []domain.TaskLifecycleEvent{verified, claimed}}
		service := newTestService(t, store)
		if _, err := service.Complete(context.Background(), taskRef(), proposalSHA, "agent-2", "zzz"); err == nil {
			t.Fatal("expected validation error for invalid completedHeadSHA")
		}
	})
}
