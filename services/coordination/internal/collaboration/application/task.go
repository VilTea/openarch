package application

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	"github.com/openarch/openarch/services/coordination/internal/identity"
)

type TaskService struct {
	docsSync port.DocsRepoSync
	scopes   port.ScopeStore
	tasks    port.TaskStore
	auth     port.TaskEventAuthenticator
	clock    func() time.Time
}

func NewTaskService(docsSync port.DocsRepoSync, scopes port.ScopeStore, tasks port.TaskStore, auth port.TaskEventAuthenticator, clock func() time.Time) (TaskService, error) {
	if docsSync == nil || scopes == nil || tasks == nil || auth == nil || clock == nil {
		return TaskService{}, fmt.Errorf("task service requires docs-repo sync, scope store, task store, event authenticator, and clock")
	}
	return TaskService{docsSync: docsSync, scopes: scopes, tasks: tasks, auth: auth, clock: clock}, nil
}

type TaskSubmitResult struct {
	Status  domain.TaskStatus `json:"status"`
	Created bool              `json:"created"`
}

// Submit verifies an Agent-pushed proposal against the exact remote Git head
// and records only the service-owned verified event. It does not claim a
// session or lock, and it never rewrites the proposal.
func (s TaskService) Submit(ctx context.Context, submission domain.TaskSubmission) (TaskSubmitResult, error) {
	if err := submission.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	if _, err := s.docsSync.RefreshFromRemoteContaining(ctx, strings.TrimSpace(submission.Branch), strings.ToLower(strings.TrimSpace(submission.HeadSHA))); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateScope(ctx, submission.Task); err != nil {
		return TaskSubmitResult{}, err
	}
	proposal, exists, err := s.tasks.ReadProposal(ctx, submission.Task)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if !exists {
		return TaskSubmitResult{}, domain.ErrTaskProposalMissing
	}
	if err := proposal.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	events, err := s.tasks.ListLifecycle(ctx, submission.Task)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	for _, event := range events {
		if event.Type != "verified" {
			return TaskSubmitResult{}, domain.ErrTaskAlreadyVerified
		}
		if event.ProposalSHA256 == proposal.ContentSHA256 && strings.EqualFold(event.VerifiedHeadSHA, submission.HeadSHA) {
			return TaskSubmitResult{Status: domain.TaskStatusOf([]domain.TaskLifecycleEvent{event}), Created: false}, nil
		}
		return TaskSubmitResult{}, domain.ErrTaskAlreadyVerified
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:   domain.TaskEventSchemaVersion,
		Task:            submission.Task,
		Type:            "verified",
		ProposalSHA256:  proposal.ContentSHA256,
		VerifiedHeadSHA: strings.ToLower(strings.TrimSpace(submission.HeadSHA)),
		RecordedAt:      s.clock().UTC(),
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	return TaskSubmitResult{Status: domain.TaskStatusOf([]domain.TaskLifecycleEvent{event}), Created: true}, nil
}

// Claim records the service-owned claimed event for an already-verified task.
// The same executor retrying the claim is idempotent; a claim on an unverified
// task or by a different executor is rejected.
// claimTransition resolves the state-machine step for an executor claiming a
// verified task. Same-executor idempotent retries return the current status
// with created=false; conflicting claims and completed tasks are rejected.
func claimTransition(status domain.TaskStatus, claimedBy string) (proceed bool, created bool, err error) {
	switch status.State {
	case "verified":
		return true, true, nil
	case "claimed":
		if status.ClaimedBy == claimedBy {
			return false, false, nil
		}
		return false, false, domain.ErrTaskAlreadyClaimed
	case "completed":
		return false, false, domain.ErrTaskAlreadyClaimed
	default:
		return false, false, domain.ErrTaskNotVerified
	}
}

// completeTransition resolves the state-machine step for the claimed executor
// completing a task. Only the claiming executor may complete; a completed task
// cannot be completed again.
func completeTransition(status domain.TaskStatus, completedBy string) error {
	switch status.State {
	case "claimed":
		if status.ClaimedBy != completedBy {
			return domain.ErrTaskNotClaimed
		}
		return nil
	case "completed":
		return domain.ErrTaskAlreadyCompleted
	default:
		return domain.ErrTaskNotClaimed
	}
}

func (s TaskService) Claim(ctx context.Context, task domain.TaskRef, proposalSHA256 string, claimedBy string) (TaskSubmitResult, error) {
	if err := task.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := domain.ValidateSHA256Hex(proposalSHA256, "task claim proposalSha256"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := identity.Validate(claimedBy); err != nil {
		return TaskSubmitResult{}, fmt.Errorf("task claim claimedBy: %w", err)
	}
	if err := s.validateScope(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	status, events, err := s.lifecycleFor(ctx, task, proposalSHA256)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	proceed, created, err := claimTransition(status, claimedBy)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if !proceed {
		return TaskSubmitResult{Status: status, Created: created}, nil
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:   domain.TaskEventSchemaVersion,
		Task:            task,
		Type:            "claimed",
		ProposalSHA256:  proposalSHA256,
		VerifiedHeadSHA: status.VerifiedHeadSHA,
		ClaimedBy:       claimedBy,
		RecordedAt:      s.clock().UTC(),
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	events = append(events, event)
	return TaskSubmitResult{Status: domain.TaskStatusOf(events), Created: true}, nil
}

// Complete records the service-owned completed event for a task claimed by the
// same executor. completedHeadSHA is an optional evidence of the completion head.
func (s TaskService) Complete(ctx context.Context, task domain.TaskRef, proposalSHA256 string, completedBy string, completedHeadSHA string) (TaskSubmitResult, error) {
	if err := task.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := domain.ValidateSHA256Hex(proposalSHA256, "task complete proposalSha256"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := identity.Validate(completedBy); err != nil {
		return TaskSubmitResult{}, fmt.Errorf("task complete completedBy: %w", err)
	}
	completedHead := strings.TrimSpace(completedHeadSHA)
	if completedHead != "" {
		if err := domain.ValidateGitSHAHex(completedHead, "task complete completedHeadSHA"); err != nil {
			return TaskSubmitResult{}, err
		}
	}
	if err := s.validateScope(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	status, events, err := s.lifecycleFor(ctx, task, proposalSHA256)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := completeTransition(status, completedBy); err != nil {
		return TaskSubmitResult{}, err
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:    domain.TaskEventSchemaVersion,
		Task:             task,
		Type:             "completed",
		ProposalSHA256:   proposalSHA256,
		VerifiedHeadSHA:  status.VerifiedHeadSHA,
		CompletedBy:      completedBy,
		CompletedHeadSHA: strings.ToLower(completedHead),
		RecordedAt:       s.clock().UTC(),
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	events = append(events, event)
	return TaskSubmitResult{Status: domain.TaskStatusOf(events), Created: true}, nil
}

// lifecycleFor reads the lifecycle stream and returns the rebuilt status plus
// the raw events for appending.
func (s TaskService) lifecycleFor(ctx context.Context, task domain.TaskRef, proposalSHA256 string) (domain.TaskStatus, []domain.TaskLifecycleEvent, error) {
	events, err := s.tasks.ListLifecycle(ctx, task)
	if err != nil {
		return domain.TaskStatus{}, nil, err
	}
	status := domain.TaskStatusOf(events)
	if status.ProposalSHA256 != proposalSHA256 {
		return domain.TaskStatus{}, nil, domain.ErrTaskNotVerified
	}
	return status, events, nil
}

func (s TaskService) validateScope(ctx context.Context, task domain.TaskRef) error {
	registry, err := s.scopes.Read(ctx)
	if err != nil {
		return err
	}
	for _, service := range registry.Services {
		if service.Service == task.Service() {
			return nil
		}
	}
	return domain.ErrScopeDocumentMissing
}
