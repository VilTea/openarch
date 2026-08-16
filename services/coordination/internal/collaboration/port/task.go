package port

import (
	"context"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// TaskStore reads Agent-owned proposals and appends only service-owned task
// lifecycle records. It cannot rewrite a proposal or return a hidden task DB.
type TaskStore interface {
	ReadProposal(context.Context, domain.TaskRef) (domain.TaskProposalRecord, bool, error)
	ListProposals(context.Context) ([]domain.TaskProposalRecord, error)
	ListLifecycle(context.Context, domain.TaskRef) ([]domain.TaskLifecycleEvent, error)
	ListLifecycleStreams(context.Context) (map[domain.TaskRef][]domain.TaskLifecycleEvent, error)
	AppendLifecycle(context.Context, domain.TaskLifecycleEvent) error
}

// TaskEventAuthenticator signs service-owned lifecycle records and verifies
// them when reading Git. A pathname alone is not proof of service ownership.
type TaskEventAuthenticator interface {
	SignTaskEvent(domain.TaskLifecycleEvent) (domain.TaskLifecycleEvent, error)
	VerifyTaskEvent(domain.TaskLifecycleEvent) error
}

// DocsRepoSync binds a submission to the remote Git head the agent claims to
// have pushed before the service reads the proposal.
type DocsRepoSync interface {
	RefreshFromRemote(context.Context, string, string) (domain.DurableRepositoryDescriptor, error)
	RefreshFromRemoteContaining(context.Context, string, string) (domain.DurableRepositoryDescriptor, error)
}
