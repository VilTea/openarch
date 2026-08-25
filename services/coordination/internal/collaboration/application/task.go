package application

import (
	"context"
	"fmt"
	"sort"
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
	leases   port.LeaseVerifier
	clock    func() time.Time
}

func NewTaskService(docsSync port.DocsRepoSync, scopes port.ScopeStore, tasks port.TaskStore, auth port.TaskEventAuthenticator, leases port.LeaseVerifier, clock func() time.Time) (TaskService, error) {
	if docsSync == nil || scopes == nil || tasks == nil || auth == nil || leases == nil || clock == nil {
		return TaskService{}, fmt.Errorf("task service requires docs-repo sync, scope store, task store, event authenticator, lease verifier, and clock")
	}
	return TaskService{docsSync: docsSync, scopes: scopes, tasks: tasks, auth: auth, leases: leases, clock: clock}, nil
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
	allProposals, err := s.tasks.ListProposals(ctx)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := domain.ValidateDependencyGraph(allProposals); err != nil {
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
	if err := domain.LinkLifecycleEvent(events, &event); err != nil {
		return TaskSubmitResult{}, err
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
	case "completed_local", "completed":
		return false, false, domain.ErrTaskAlreadyClaimed
	default:
		return false, false, domain.ErrTaskNotVerified
	}
}

// completeLocalTransition resolves the state-machine step for the claimed
// executor marking the task as locally completed.
func completeLocalTransition(status domain.TaskStatus, completedBy string) error {
	switch status.State {
	case "claimed":
		if status.ClaimedBy != completedBy {
			return domain.ErrTaskNotClaimed
		}
		return nil
	case "completed_local", "completed":
		return domain.ErrTaskAlreadyCompleted
	default:
		return domain.ErrTaskNotClaimed
	}
}

// completeTransition resolves the final state-machine step from
// completed_local to completed.
func completeTransition(status domain.TaskStatus, completedBy string) error {
	switch status.State {
	case "completed_local":
		if status.CompletedBy != completedBy {
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
	if err := s.validateProposalStillMatches(ctx, task, status.ProposalSHA256); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.ensureDependenciesCompleted(ctx, task); err != nil {
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
	if err := domain.LinkLifecycleEvent(events, &event); err != nil {
		return TaskSubmitResult{}, err
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	// 追加后再读一次持久化状态：并发 claim 时 authority 层会把同类型事件收敛为
	// 一条，只有最终 ClaimedBy 与请求者一致才返回成功，避免两个执行者都认为拿到任务。
	events, err = s.tasks.ListLifecycle(ctx, task)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	status = domain.TaskStatusOf(events)
	if status.State != "claimed" || status.ClaimedBy != claimedBy {
		return TaskSubmitResult{}, domain.ErrTaskAlreadyClaimed
	}
	return TaskSubmitResult{Status: status, Created: true}, nil
}

// CompleteLocal records the service-owned completed_local event. It marks the
// task as locally finished (implementation committed locally) but not yet
// confirmed as pushed. The completing agent must still hold the semantic lease
// for the declared target.
func (s TaskService) CompleteLocal(ctx context.Context, task domain.TaskRef, proposalSHA256 string, completedBy string, localHeadSHA string, target string, leaseID string) (TaskSubmitResult, error) {
	if err := task.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := domain.ValidateSHA256Hex(proposalSHA256, "task complete-local proposalSha256"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := identity.Validate(completedBy); err != nil {
		return TaskSubmitResult{}, fmt.Errorf("task complete-local completedBy: %w", err)
	}
	localHead := strings.ToLower(strings.TrimSpace(localHeadSHA))
	if err := domain.ValidateGitSHAHex(localHead, "task complete-local localHeadSHA"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateScope(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	status, events, err := s.lifecycleFor(ctx, task, proposalSHA256)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateProposalStillMatches(ctx, task, status.ProposalSHA256); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.ensureDependenciesCompleted(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := completeLocalTransition(status, completedBy); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateLeaseHeld(ctx, task, target, completedBy, leaseID); err != nil {
		return TaskSubmitResult{}, err
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:   domain.TaskEventSchemaVersion,
		Task:            task,
		Type:            "completed_local",
		ProposalSHA256:  proposalSHA256,
		VerifiedHeadSHA: status.VerifiedHeadSHA,
		CompletedBy:     completedBy,
		LeaseID:         leaseID,
		LocalHeadSHA:    localHead,
		RecordedAt:      s.clock().UTC(),
	}
	if err := domain.LinkLifecycleEvent(events, &event); err != nil {
		return TaskSubmitResult{}, err
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	events, err = s.tasks.ListLifecycle(ctx, task)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	status = domain.TaskStatusOf(events)
	if status.State != "completed_local" || status.CompletedBy != completedBy {
		return TaskSubmitResult{}, domain.ErrTaskNotClaimed
	}
	return TaskSubmitResult{Status: status, Created: true}, nil
}

// Complete records the final service-owned completed event. It requires the
// task to already be completed_local and the completing agent to still hold
// the semantic lease for the declared target.
func (s TaskService) Complete(ctx context.Context, task domain.TaskRef, proposalSHA256 string, completedBy string, completedHeadSHA string, target string, leaseID string) (TaskSubmitResult, error) {
	if err := task.Validate(); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := domain.ValidateSHA256Hex(proposalSHA256, "task complete proposalSha256"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := identity.Validate(completedBy); err != nil {
		return TaskSubmitResult{}, fmt.Errorf("task complete completedBy: %w", err)
	}
	completedHead := strings.ToLower(strings.TrimSpace(completedHeadSHA))
	if err := domain.ValidateGitSHAHex(completedHead, "task complete completedHeadSHA"); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateScope(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	status, events, err := s.lifecycleFor(ctx, task, proposalSHA256)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateProposalStillMatches(ctx, task, status.ProposalSHA256); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.ensureDependenciesCompleted(ctx, task); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := completeTransition(status, completedBy); err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.validateLeaseHeld(ctx, task, target, completedBy, leaseID); err != nil {
		return TaskSubmitResult{}, err
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:    domain.TaskEventSchemaVersion,
		Task:             task,
		Type:             "completed",
		ProposalSHA256:   proposalSHA256,
		VerifiedHeadSHA:  status.VerifiedHeadSHA,
		CompletedBy:      completedBy,
		LeaseID:          leaseID,
		CompletedHeadSHA: completedHead,
		RecordedAt:       s.clock().UTC(),
	}
	if err := domain.LinkLifecycleEvent(events, &event); err != nil {
		return TaskSubmitResult{}, err
	}
	event, err = s.auth.SignTaskEvent(event)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	if err := s.tasks.AppendLifecycle(ctx, event); err != nil {
		return TaskSubmitResult{}, err
	}
	events, err = s.tasks.ListLifecycle(ctx, task)
	if err != nil {
		return TaskSubmitResult{}, err
	}
	status = domain.TaskStatusOf(events)
	if status.State != "completed" || status.CompletedBy != completedBy {
		return TaskSubmitResult{}, domain.ErrTaskNotClaimed
	}
	return TaskSubmitResult{Status: status, Created: true}, nil
}

// List projects the Agent-owned proposals joined with their latest signed
// lifecycle status. It is a read-only query; lifecycle events stay the only
// durable authority for state transitions.
func (s TaskService) List(ctx context.Context, repositoryID string) ([]domain.TaskSummary, error) {
	filter := strings.TrimSpace(repositoryID)
	if filter != "" {
		if err := domain.RepositoryID(filter).Validate(); err != nil {
			return nil, fmt.Errorf("task list repositoryId: %w", err)
		}
	}
	proposals, err := s.tasks.ListProposals(ctx)
	if err != nil {
		return nil, err
	}
	streams, err := s.tasks.ListLifecycleStreams(ctx)
	if err != nil {
		return nil, err
	}
	summaries := make([]domain.TaskSummary, 0, len(proposals))
	for _, proposal := range proposals {
		if filter != "" && string(proposal.Proposal.Task.RepositoryID) != filter {
			continue
		}
		status := domain.TaskStatusOf(streams[proposal.Proposal.Task])
		status.Task = proposal.Proposal.Task
		if status.ProposalSHA256 == "" {
			status.ProposalSHA256 = proposal.ContentSHA256
		} else if status.ProposalSHA256 != proposal.ContentSHA256 {
			return nil, fmt.Errorf("%w: task %s", domain.ErrTaskProposalMismatch, proposal.Proposal.Task.TaskID)
		}
		summary := domain.TaskSummary{
			Task:           proposal.Proposal.Task,
			Title:          proposal.Proposal.Title,
			Hypothesis:     proposal.Proposal.Hypothesis,
			RequestedBy:    proposal.Proposal.RequestedBy,
			ProposalSHA256: proposal.ContentSHA256,
			Status:         status,
		}
		if err := summary.Validate(); err != nil {
			return nil, err
		}
		summaries = append(summaries, summary)
	}
	sort.Slice(summaries, func(i, j int) bool {
		left := summaries[i].Task
		right := summaries[j].Task
		if left.RepositoryID != right.RepositoryID {
			return left.RepositoryID < right.RepositoryID
		}
		if left.ServiceID != right.ServiceID {
			return left.ServiceID < right.ServiceID
		}
		return left.TaskID < right.TaskID
	})
	return summaries, nil
}

// Get returns one task's proposal summary plus the verified v2 event chain.
// It fails closed when the current proposal no longer matches the verified
// proposal SHA or when the event chain cannot be verified.
func (s TaskService) Get(ctx context.Context, task domain.TaskRef) (domain.TaskDetail, error) {
	if err := task.Validate(); err != nil {
		return domain.TaskDetail{}, err
	}
	if err := s.validateScope(ctx, task); err != nil {
		return domain.TaskDetail{}, err
	}
	proposal, exists, err := s.tasks.ReadProposal(ctx, task)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	if !exists {
		return domain.TaskDetail{}, domain.ErrTaskProposalMissing
	}
	events, err := s.tasks.ListLifecycle(ctx, task)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	status := domain.TaskStatusOf(events)
	status.Task = task
	if status.ProposalSHA256 == "" {
		status.ProposalSHA256 = proposal.ContentSHA256
	} else if status.ProposalSHA256 != proposal.ContentSHA256 {
		return domain.TaskDetail{}, domain.ErrTaskProposalMismatch
	}
	detail := domain.TaskDetail{
		Task:           task,
		Title:          proposal.Proposal.Title,
		Hypothesis:     proposal.Proposal.Hypothesis,
		RequestedBy:    proposal.Proposal.RequestedBy,
		ProposalSHA256: proposal.ContentSHA256,
		DependsOn:      proposal.Proposal.DependsOn,
		Goal:           proposal.Proposal.Goal,
		Scope:          proposal.Proposal.Scope,
		Constraints:    proposal.Proposal.Constraints,
		Verification:   proposal.Proposal.Verification,
		Deliverable:    proposal.Proposal.Deliverable,
		Status:         status,
		Events:         events,
	}
	if err := detail.Validate(); err != nil {
		return domain.TaskDetail{}, err
	}
	return detail, nil
}

func (s TaskService) ensureDependenciesCompleted(ctx context.Context, task domain.TaskRef) error {
	proposal, exists, err := s.tasks.ReadProposal(ctx, task)
	if err != nil {
		return err
	}
	if !exists {
		return domain.ErrTaskProposalMissing
	}
	if len(proposal.Proposal.DependsOn) == 0 {
		return nil
	}
	streams, err := s.tasks.ListLifecycleStreams(ctx)
	if err != nil {
		return err
	}
	for _, dependency := range proposal.Proposal.DependsOn {
		status := domain.TaskStatusOf(streams[dependency])
		if status.State != "completed" {
			return domain.ErrTaskDependencyNotMet
		}
	}
	return nil
}

func (s TaskService) validateLeaseHeld(ctx context.Context, task domain.TaskRef, target string, owner string, leaseID string) error {
	key := domain.LeaseKey{RepositoryID: task.RepositoryID, Target: domain.NormalizeTarget(target)}
	if err := key.Validate(); err != nil {
		return fmt.Errorf("task completion lease target: %w", err)
	}
	lease, exists, err := s.leases.Get(ctx, key)
	if err != nil {
		return err
	}
	if !exists || lease.Owner != owner || lease.LeaseID != leaseID || !s.clock().Before(lease.ExpiresAt) {
		return domain.ErrTaskLeaseNotHeld
	}
	return nil
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

func (s TaskService) validateProposalStillMatches(ctx context.Context, task domain.TaskRef, proposalSHA256 string) error {
	if proposalSHA256 == "" {
		return domain.ErrTaskNotVerified
	}
	proposal, exists, err := s.tasks.ReadProposal(ctx, task)
	if err != nil {
		return err
	}
	if !exists {
		return domain.ErrTaskProposalMissing
	}
	if proposal.ContentSHA256 != proposalSHA256 {
		return domain.ErrTaskProposalMismatch
	}
	return nil
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
